"""2D 도로면용 지역 캐시와 대상지 clip.

도로면의 우선순위는 다음과 같다.

1. VWorld ``(도로명주소)실폭도로`` (dsId=30057) 지역별 SHP
2. VWorld ``연속수치지형도 도로경계_면`` (dsId=30179) 지역별 SHP
3. NGII 연속수치지형도 도로중심선 ``lt_l_n3a0020000`` 폭 속성 buffer

연속지적도의 ``지목=도`` 필지는 여기서 절대 사용하지 않는다. VWorld 자료실은
로그인이 필요한 계정에서는 비로그인 자동 다운로드가 빈 응답으로 끝날 수 있다.
그 경우에도 중심선 fallback으로 도판을 만들며, 사용자가 공식 ZIP을 한 번
가져오면 이후에는 지역 캐시를 BBOX로 잘라 쓴다.

사용 예::

    python road_data.py import "C:/Download/(도로명주소)실폭도로_서울.zip"
    python road_data.py build --name 국민대학교
    python road_data.py build --all
    python road_data.py status

각 지역의 ``current.json``만 현재판을 가리키고 ``versions/`` 아래의 예전 자료는
지우지 않는다. 새 판은 압축 해제·도형 검증·GeoPackage 변환을 모두 통과한 뒤에만
current가 바뀐다.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import pyogrio
from shapely import make_valid
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, box, mapping, shape
from shapely.ops import transform as shapely_transform, unary_union

from common import ENV_PATH, HERE, Site, list_sites, network_session, pick_crs, resolve_site
from vworld import VWorld, VWorldError, load_key


ROAD_AREA_ID = "ROAD_AREA"
ROAD_CENTERLINE_ID = "ROAD_CENTERLINE"
ROAD_CACHE = os.path.join(HERE, "cache", "roads")
INBOX = os.path.join(ROAD_CACHE, "inbox")
CATALOG_TTL_SECONDS = 7 * 24 * 60 * 60
CATALOG_URL = "https://www.vworld.kr/dtmk/dtmk_ntads_s002.do"
DOWNLOAD_URL = "https://www.vworld.kr/dtmk/downloadResourceFile.do"

DATASETS = (
    {
        "id": "30057",
        "name": "VWorld 도로명주소 실폭도로",
        "marker": "실폭도로",
        "kind": "actual_width_polygon",
    },
    {
        "id": "30179",
        "name": "VWorld 연속수치지형도 도로경계_면",
        "marker": "도로경계",
        "kind": "road_boundary_polygon",
    },
)

# 자료실 파일명에 쓰이는 이름으로 정규화한다. 30057의 2026년 자료는 광주와
# 전남이 통합 파일이므로 둘 다 같은 별칭으로 향하게 한다.
REGION_ALIASES = {
    "서울": ("서울", "서울특별시"),
    "부산": ("부산", "부산광역시"),
    "대구": ("대구", "대구광역시"),
    "인천": ("인천", "인천광역시"),
    "광주": ("광주", "광주광역시", "전남광주통합특별시"),
    "대전": ("대전", "대전광역시"),
    "울산": ("울산", "울산광역시"),
    "세종": ("세종", "세종특별자치시"),
    "경기": ("경기", "경기도"),
    "강원특별자치도": ("강원", "강원도", "강원특별자치도"),
    "충북": ("충북", "충청북도"),
    "충남": ("충남", "충청남도"),
    "전북특별자치도": ("전북", "전라북도", "전북특별자치도"),
    "전남": ("전남", "전라남도", "전남광주통합특별시"),
    "경북": ("경북", "경상북도"),
    "경남": ("경남", "경상남도"),
    "제주": ("제주", "제주도", "제주특별자치도"),
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe(text: str) -> str:
    return re.sub(r"[^0-9A-Za-z가-힣._-]+", "-", str(text)).strip("-") or "unknown"


def normalize_region(text: str | None, dataset_id: str | None = None) -> str | None:
    raw = (text or "").replace(" ", "")
    for region, aliases in REGION_ALIASES.items():
        if any(a.replace(" ", "") in raw for a in aliases):
            if dataset_id == "30057" and region in ("광주", "전남"):
                return "전남광주통합특별시"
            return region
    return None


def site_region(site: Site, dataset_id: str | None = None) -> str | None:
    manifest = site.read_manifest() or {}
    meta = manifest.get("resolved_by") or {}
    return normalize_region(meta.get("address") or meta.get("query"), dataset_id)


def _dataset(dataset_id: str) -> dict:
    found = next((d for d in DATASETS if d["id"] == str(dataset_id)), None)
    if not found:
        raise ValueError(f"지원하지 않는 도로 데이터셋입니다: {dataset_id}")
    return found


def _dataset_dir(dataset_id: str) -> str:
    return os.path.join(ROAD_CACHE, str(dataset_id))


def _region_dir(dataset_id: str, region: str) -> str:
    return os.path.join(_dataset_dir(dataset_id), _safe(region))


def _json_read(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _json_atomic(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(temp, path)


def _catalog_path(dataset_id: str) -> str:
    return os.path.join(_dataset_dir(dataset_id), "catalog.json")


def _parse_catalog(dataset_id: str, text: str) -> list[dict]:
    """자료실 HTML의 지역 ZIP 행만 읽는다."""
    rows = []
    pattern = re.compile(r"<li\b.*?</li>", re.I | re.S)
    for block in pattern.findall(text):
        title_hit = re.search(r'<div\s+class="tit min">(.*?)</div>', block, re.I | re.S)
        dl = re.search(
            rf"listFnc\.download\(\s*'{re.escape(str(dataset_id))}'\s*,\s*'([^']+)'\s*,\s*'([^']+)'",
            block,
        )
        if not title_hit or not dl:
            continue
        title = html.unescape(re.sub(r"<[^>]+>", "", title_hit.group(1))).strip()
        if not title.lower().endswith(".zip"):
            continue
        plain = html.unescape(re.sub(r"<[^>]+>", " ", block))
        plain = re.sub(r"\s+", " ", plain)
        ref = re.search(r"기준일\s*([^ ]+)", plain)
        updated = re.search(r"갱신일\s*([^ ]+)", plain)
        ref_value = ref.group(1) if ref else ""
        if ref_value in ("-", "없음"):
            ref_value = ""
        region = normalize_region(title, str(dataset_id))
        if not region:
            continue
        rows.append({
            "dataset_id": str(dataset_id),
            "region": region,
            "file_no": dl.group(1),
            "size_kb": int(float(dl.group(2).replace(",", ""))),
            "file_name": title,
            "reference_date": ref_value,
            "updated_date": updated.group(1) if updated else "",
        })
    return rows


def fetch_catalog(dataset_id: str, force: bool = False, session=None) -> dict:
    """최대 일주일에 한 번 공식 자료실의 버전 정보를 갱신한다."""
    path = _catalog_path(dataset_id)
    old = _json_read(path)
    if old and not force:
        try:
            age = datetime.now(timezone.utc).timestamp() - os.path.getmtime(path)
            if age < CATALOG_TTL_SECONDS:
                return old
        except OSError:
            pass

    own = session is None
    session = session or network_session()
    try:
        response = session.get(
            CATALOG_URL,
            params={"svcCde": "MK", "dsId": str(dataset_id), "datPageSize": 100},
            timeout=30,
        )
        response.raise_for_status()
        entries = _parse_catalog(str(dataset_id), response.text)
        if not entries:
            raise RuntimeError(f"VWorld dsId={dataset_id} 자료실 목록을 해석하지 못했습니다.")
        data = {"dataset_id": str(dataset_id), "checked_at": _now(), "entries": entries}
        _json_atomic(path, data)
        return data
    finally:
        if own:
            session.close()


def catalog_entry(dataset_id: str, region: str, force: bool = False, session=None) -> dict | None:
    catalog = fetch_catalog(dataset_id, force=force, session=session)
    wanted = normalize_region(region, dataset_id) or region
    return next((e for e in catalog.get("entries", []) if e.get("region") == wanted), None)


def _extract_zip(source: str, dest: str) -> None:
    root = os.path.realpath(dest)
    with zipfile.ZipFile(source) as zf:
        for item in zf.infolist():
            target = os.path.realpath(os.path.join(dest, item.filename))
            if os.path.commonpath([root, target]) != root:
                raise ValueError("ZIP 안에 허용되지 않은 경로가 있습니다.")
        zf.extractall(dest)


def _polygon_parts(geom):
    """make_valid 결과에서 면만 되살린다."""
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    if isinstance(geom, GeometryCollection):
        out = []
        for part in geom.geoms:
            out.extend(_polygon_parts(part))
        return out
    return []


def _normalize_archive(source_zip: str, output_gpkg: str) -> dict:
    """지역 ZIP의 Polygon SHP를 EPSG:4326 GeoPackage로 검증·변환한다."""
    extracted = os.path.join(os.path.dirname(output_gpkg), f".extract-{uuid.uuid4().hex}")
    os.makedirs(extracted)
    try:
        _extract_zip(source_zip, extracted)
        shp_files = sorted(Path(extracted).rglob("*.shp"))
        if not shp_files:
            raise ValueError("ZIP 안에서 SHP 파일을 찾지 못했습니다.")

        source_layers = []
        feature_count = 0
        total_bounds = [float("inf"), float("inf"), float("-inf"), float("-inf")]
        wrote = False
        for shp in shp_files:
            try:
                info = pyogrio.read_info(shp)
            except Exception:
                continue
            geometry_type = str(info.get("geometry_type") or "")
            if geometry_type and not any(x in geometry_type for x in ("Polygon", "Unknown")):
                continue
            source_feature_count = int(info.get("features") or 0)
            offset = 0
            layer_written = 0
            while source_feature_count <= 0 or offset < source_feature_count:
                try:
                    gdf = gpd.read_file(
                        shp, columns=[], skip_features=offset, max_features=50_000,
                    )
                except Exception:
                    break
                if gdf.empty:
                    break
                read_count = len(gdf)
                offset += read_count
                if not gdf.crs:
                    break
                gdf = gdf.to_crs("EPSG:4326")
                polygons = []
                for geom in gdf.geometry:
                    try:
                        polygons.extend(_polygon_parts(make_valid(geom)))
                    except Exception:
                        continue
                if polygons:
                    normalized = gpd.GeoDataFrame({"geometry": polygons}, crs="EPSG:4326")
                    bounds = normalized.total_bounds
                    total_bounds = [
                        min(total_bounds[0], float(bounds[0])),
                        min(total_bounds[1], float(bounds[1])),
                        max(total_bounds[2], float(bounds[2])),
                        max(total_bounds[3], float(bounds[3])),
                    ]
                    pyogrio.write_dataframe(
                        normalized, output_gpkg, layer="roads", driver="GPKG", append=wrote,
                    )
                    wrote = True
                    feature_count += len(normalized)
                    layer_written += len(normalized)
                if source_feature_count <= 0 and read_count < 50_000:
                    break
            if layer_written:
                source_layers.append(shp.name)

        if not wrote:
            raise ValueError("ZIP 안에 유효한 도로 Polygon이 없습니다.")

        # 좌표계 표기가 틀린 파일을 current로 바꾸는 일을 막는다.
        korea = box(123.5, 32.5, 132.5, 39.8)
        if not box(*total_bounds).intersects(korea):
            raise ValueError(f"변환 결과가 대한민국 좌표 범위와 만나지 않습니다: {total_bounds}")
        return {
            "feature_count": feature_count,
            "bounds_4326": [round(float(v), 8) for v in total_bounds],
            "source_layers": source_layers,
        }
    finally:
        shutil.rmtree(extracted, ignore_errors=True)


def install_archive(source_zip: str, dataset_id: str, region: str,
                    version: str | None = None, catalog_meta: dict | None = None) -> dict:
    """공식 ZIP을 불변 버전으로 설치한 뒤 current를 원자적으로 전환한다."""
    ds = _dataset(dataset_id)
    region = normalize_region(region, dataset_id) or region
    if not zipfile.is_zipfile(source_zip):
        raise ValueError(f"ZIP 파일이 아닙니다: {source_zip}")

    digest = hashlib.sha256()
    with open(source_zip, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    sha = digest.hexdigest()
    base_version = version or (catalog_meta or {}).get("reference_date") \
        or (catalog_meta or {}).get("updated_date") or datetime.now().strftime("%Y-%m-%d")
    version_id = f"{_safe(base_version)}_{sha[:12]}"
    region_dir = _region_dir(dataset_id, region)
    final_dir = os.path.join(region_dir, "versions", version_id)

    if not os.path.exists(final_dir):
        parent = os.path.dirname(final_dir)
        os.makedirs(parent, exist_ok=True)
        stage = os.path.join(parent, f".staging-{uuid.uuid4().hex}")
        os.makedirs(stage)
        try:
            copied = os.path.join(stage, "source.zip")
            shutil.copy2(source_zip, copied)
            validation = _normalize_archive(copied, os.path.join(stage, "roads.gpkg"))
            metadata = {
                "dataset_id": str(dataset_id),
                "dataset_name": ds["name"],
                "kind": ds["kind"],
                "region": region,
                "version": str(base_version),
                "version_id": version_id,
                "sha256": sha,
                "installed_at": _now(),
                "catalog": catalog_meta or {},
                "validation": validation,
            }
            _json_atomic(os.path.join(stage, "metadata.json"), metadata)
            os.replace(stage, final_dir)
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise

    metadata = _json_read(os.path.join(final_dir, "metadata.json")) or {}
    current = {
        "dataset_id": str(dataset_id),
        "dataset_name": ds["name"],
        "kind": ds["kind"],
        "region": region,
        "version": metadata.get("version") or str(base_version),
        "version_id": version_id,
        "sha256": sha,
        "gpkg": f"versions/{version_id}/roads.gpkg",
        "switched_at": _now(),
    }
    _json_atomic(os.path.join(region_dir, "current.json"), current)
    return current


def current_version(dataset_id: str, region: str) -> dict | None:
    region = normalize_region(region, dataset_id) or region
    path = os.path.join(_region_dir(dataset_id, region), "current.json")
    current = _json_read(path)
    if not current:
        return None
    gpkg = os.path.normpath(os.path.join(os.path.dirname(path), current.get("gpkg", "")))
    if not os.path.isfile(gpkg):
        return None
    current = dict(current)
    current["_gpkg"] = gpkg
    return current


def catalog_status(site: Site | None = None, refresh: bool = False) -> dict:
    """화면에서 쓸 도로 Polygon 카탈로그·설치판 상태.

    공식 목록 확인과 실제 ZIP 설치는 분리한다. 목록을 새로 확인하다 실패해도 이미
    검증된 ``current.json``과 대상지 도로면은 그대로 유지된다.
    """
    manifest = site.read_manifest() if site else {}
    address = ((manifest or {}).get("resolved_by") or {}).get("address")
    items = []
    for ds in DATASETS:
        region = site_region(site, ds["id"]) if site else None
        catalog = None
        error = ""
        try:
            catalog = fetch_catalog(ds["id"], force=refresh)
        except Exception as exc:
            catalog = _json_read(_catalog_path(ds["id"])) or {}
            error = str(exc)
        latest = None
        if region:
            latest = next((entry for entry in catalog.get("entries", [])
                           if entry.get("region") == region), None)
        current = current_version(ds["id"], region) if region else None
        version_root = (Path(_region_dir(ds["id"], region)) / "versions") if region else None
        versions = len(list(version_root.glob("*/metadata.json"))) if version_root and version_root.exists() else 0
        installed = ({k: v for k, v in current.items() if not k.startswith("_")}
                     if current else None)
        latest_version = ((latest or {}).get("reference_date") or
                          (latest or {}).get("updated_date") or "")
        items.append({
            "dataset_id": ds["id"], "name": ds["name"], "kind": ds["kind"],
            "region": region, "catalog_checked_at": catalog.get("checked_at"),
            "latest": latest, "installed": installed, "preserved_versions": versions,
            "update_available": bool(current and latest_version and
                                     current.get("version") != latest_version),
            "error": error,
        })
    site_source = {}
    if site:
        saved = _json_read(site.geojson(ROAD_AREA_ID)) or {}
        site_source = saved.get("road_source") or {}
    return {
        "site": site.name if site else None,
        "address": address,
        "source": site_source,
        "datasets": items,
    }


def _download_archive(entry: dict, target: str, session) -> None:
    """공식 자료실 파일을 받는다. 로그인 응답(0 byte/HTML)은 명확히 거절한다."""
    part = target + ".part"
    response = session.get(
        DOWNLOAD_URL,
        params={"ds_id": entry["dataset_id"], "fileNo": entry["file_no"]},
        timeout=120,
        stream=True,
    )
    response.raise_for_status()
    with open(part, "wb") as f:
        for chunk in response.iter_content(1024 * 1024):
            if chunk:
                f.write(chunk)
    if os.path.getsize(part) < 100 or not zipfile.is_zipfile(part):
        os.remove(part)
        raise RuntimeError(
            "VWorld 자료실이 로그인되지 않은 다운로드를 허용하지 않았습니다. "
            "공식 ZIP을 브라우저에서 받은 뒤 road_data.py import로 넣어주세요."
        )
    os.replace(part, target)


def refresh_region(region: str, force: bool = False) -> list[dict]:
    """새 공식판이 있으면 설치한다. 실패해도 기존 current는 그대로 둔다."""
    os.makedirs(ROAD_CACHE, exist_ok=True)
    session = network_session()
    results = []
    try:
        for ds in DATASETS:
            dataset_id = ds["id"]
            wanted = normalize_region(region, dataset_id) or region
            try:
                entry = catalog_entry(dataset_id, wanted, force=force, session=session)
                if not entry:
                    raise RuntimeError(f"{wanted} 지역 파일을 찾지 못했습니다.")
                current = current_version(dataset_id, wanted)
                version = entry.get("reference_date") or entry.get("updated_date")
                if current and current.get("version") == version and not force:
                    results.append({"dataset_id": dataset_id, "status": "current", "current": current})
                    continue
                temp = os.path.join(ROAD_CACHE, "_downloads", uuid.uuid4().hex)
                os.makedirs(temp, exist_ok=True)
                try:
                    archive = os.path.join(temp, entry["file_name"])
                    _download_archive(entry, archive, session)
                    current = install_archive(archive, dataset_id, wanted, version, entry)
                finally:
                    shutil.rmtree(temp, ignore_errors=True)
                results.append({"dataset_id": dataset_id, "status": "updated", "current": current})
            except Exception as exc:
                results.append({"dataset_id": dataset_id, "status": "error", "error": str(exc)})
    finally:
        session.close()
    return results


def _infer_archive(path: str) -> tuple[str | None, str | None]:
    name = os.path.basename(path)
    ds = next((d["id"] for d in DATASETS if d["marker"] in name), None)
    region = normalize_region(name, ds)
    return ds, region


def import_inbox() -> list[dict]:
    """cache/roads/inbox에 놓인, 이름을 판별할 수 있는 공식 ZIP을 가져온다."""
    if not os.path.isdir(INBOX):
        return []
    installed = []
    for path in sorted(Path(INBOX).glob("*.zip")):
        dataset_id, region = _infer_archive(str(path))
        if dataset_id and region:
            installed.append(install_archive(str(path), dataset_id, region))
    return installed


def _source_from_current(current: dict) -> dict:
    return {
        "mode": "regional_polygon",
        "dataset_id": current["dataset_id"],
        "label": current["dataset_name"],
        "kind": current.get("kind"),
        "region": current.get("region"),
        "version": current.get("version"),
        "version_id": current.get("version_id"),
        "sha256": current.get("sha256"),
    }


def _clip_regional(current: dict, bbox_4326) -> tuple[object, int]:
    gdf = gpd.read_file(current["_gpkg"], bbox=tuple(bbox_4326), columns=[])
    if gdf.empty:
        return GeometryCollection(), 0
    target_crs, _ = pick_crs((bbox_4326[0] + bbox_4326[2]) / 2)
    gdf = gdf.to_crs(target_crs)
    clip = gpd.GeoSeries([box(*bbox_4326)], crs="EPSG:4326").to_crs(target_crs).iloc[0]
    parts = []
    for geom in gdf.geometry:
        try:
            parts.extend(_polygon_parts(make_valid(geom).intersection(clip)))
        except Exception:
            continue
    geom = unary_union(parts) if parts else GeometryCollection()
    if not geom.is_empty:
        from pyproj import Transformer
        to_wgs = Transformer.from_crs(target_crs, "EPSG:4326", always_xy=True).transform
        geom = shapely_transform(to_wgs, geom)
    return geom, len(parts)


def _number(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _centerline_fallback(api: VWorld, bbox_4326, on_progress=None,
                         features: list[dict] | None = None) -> tuple[object, dict]:
    if features is None:
        features = api.get_feature_tiled(
            "lt_l_n3a0020000", bbox_4326, cell_deg=0.004, on_progress=on_progress,
        )
    target_crs, _ = pick_crs((bbox_4326[0] + bbox_4326[2]) / 2)
    from pyproj import Transformer

    to_target = Transformer.from_crs("EPSG:4326", target_crs, always_xy=True).transform
    clip = shapely_transform(to_target, box(*bbox_4326))
    surfaces = []
    for feature in features:
        try:
            line = shapely_transform(to_target, shape(feature.get("geometry")))
        except Exception:
            continue
        props = feature.get("properties") or {}
        width = _number(props.get("rvwd"))
        if width <= 0:
            lanes = max(1.0, _number(props.get("rdln"), 1.0))
            width = lanes * 3.25
        width = max(1.5, min(80.0, width))
        # round cap은 타일/객체 경계에서 아주 작은 틈이 생기는 것을 막는다.
        try:
            surfaces.append(line.buffer(width / 2 + 0.12, cap_style="round", join_style="round"))
        except Exception:
            continue
    geom = unary_union(surfaces).intersection(clip) if surfaces else GeometryCollection()
    if not geom.is_empty:
        to_wgs = Transformer.from_crs(target_crs, "EPSG:4326", always_xy=True).transform
        geom = shapely_transform(to_wgs, geom)
    return geom, {
        "mode": "centerline_fallback",
        "dataset_id": "lt_l_n3a0020000",
        "label": "VWorld NGII 도로중심선 폭 기반 fallback",
        "kind": "buffered_centerline",
        "version": "live",
        "source_feature_count": len(features),
    }


def _read_site_centerlines(site: Site) -> list[dict]:
    old = _json_read(site.geojson(ROAD_CENTERLINE_ID)) or {}
    return old.get("features") or []


def _write_site_centerlines(site: Site, features: list[dict]) -> None:
    """도로망 분석에 쓸 NGII 중심선과 속성을 도로면과 별도로 보존한다.

    ROAD_AREA는 dissolve된 면이라 어느 도로에서 온 값인지 되찾을 수 없다. 따라서
    폭·차로수 같은 원래 속성을 가진 중심선을 같이 저장하고, 장면을 만들 때 도로면
    위에 분석색으로 투영한다.
    """
    clean = []
    for feature in features:
        geom = feature.get("geometry") or {}
        if geom.get("type") not in ("LineString", "MultiLineString"):
            continue
        clean.append({
            "type": "Feature",
            "geometry": geom,
            "properties": dict(feature.get("properties") or {}),
        })
    data = {
        "type": "FeatureCollection",
        "crs": "EPSG:4326",
        "analysis_source": {
            "dataset_id": "lt_l_n3a0020000",
            "label": "VWorld NGII 도로중심선",
            "generated_at": _now(),
            "count": len(clean),
        },
        "features": clean,
    }
    path = site.geojson(ROAD_CENTERLINE_ID)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(temp, path)


def _collect_site_centerlines(site: Site, bbox_4326, api: VWorld | None,
                              on_progress=None) -> tuple[list[dict], str | None, VWorld | None]:
    """최신 중심선을 받되, 일시적인 오류면 직전 로컬 자료를 계속 쓴다."""
    try:
        if api is None:
            key, domain = load_key(ENV_PATH)
            api = VWorld(key, domain)
        features = api.get_feature_tiled(
            "lt_l_n3a0020000", bbox_4326, cell_deg=0.004, on_progress=on_progress,
        )
        _write_site_centerlines(site, features)
        return features, None, api
    except Exception as exc:
        old = _read_site_centerlines(site)
        return old, str(exc), api


def materialize_analysis(site: Site, bbox_4326=None, api: VWorld | None = None,
                         on_progress=None) -> dict:
    """기존 대상지의 경계·DB·프리셋은 건드리지 않고 도로 분석 자료만 보충한다."""
    site.ensure()
    manifest = site.read_manifest() or {}
    bbox_4326 = tuple(bbox_4326 or manifest.get("bbox_4326") or ())
    if len(bbox_4326) != 4:
        raise ValueError("대상지 BBOX가 없습니다.")
    features, error, _ = _collect_site_centerlines(site, bbox_4326, api, on_progress)
    if not features:
        raise VWorldError(error or "NGII 도로중심선 결과가 비어 있습니다.")

    # 사이트 목록의 기존 ROAD_AREA 항목에 분석 자료 상태만 덧붙인다. 다른 레이어와
    # PROJECT SITE/DESIGN AREA 파일은 그대로라 저장해 둔 프리셋을 다시 적용할 필요가 없다.
    for layer in manifest.get("layers", []):
        if layer.get("data_id") == ROAD_AREA_ID:
            layer["analysis_count"] = len(features)
            layer["analysis_dataset_id"] = "lt_l_n3a0020000"
            layer.pop("analysis_warning", None)
            break
    if manifest:
        _json_atomic(site.manifest, manifest)
    return {
        "data_id": ROAD_CENTERLINE_ID,
        "dataset_id": "lt_l_n3a0020000",
        "count": len(features),
        "warning": error,
    }


def _geojson_features(geom) -> list[dict]:
    parts = _polygon_parts(make_valid(geom)) if geom is not None and not geom.is_empty else []
    return [
        {"type": "Feature", "properties": {}, "geometry": mapping(part)}
        for part in parts if not part.is_empty
    ]


def _write_site_geojson(site: Site, geom, source: dict, source_count: int = 0) -> dict:
    features = _geojson_features(geom)
    data = {
        "type": "FeatureCollection",
        "crs": "EPSG:4326",
        "road_source": {**source, "generated_at": _now()},
        "features": features,
    }
    path = site.geojson(ROAD_AREA_ID)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(temp, path)
    return {
        "data_id": ROAD_AREA_ID,
        "name": "도로면",
        "count": len(features),
        "source_count": source_count,
        "source": data["road_source"],
    }


def materialize_site(site: Site, bbox_4326=None, api: VWorld | None = None,
                     check_updates: bool = True, on_progress=None) -> dict:
    """지역 Polygon을 BBOX clip한다. 없으면 NGII 중심선 fallback을 만든다."""
    site.ensure()
    manifest = site.read_manifest() or {}
    bbox_4326 = tuple(bbox_4326 or manifest.get("bbox_4326") or ())
    if len(bbox_4326) != 4:
        raise ValueError("대상지 BBOX가 없습니다.")

    # 도로면이 공식 Polygon에서 오더라도 도로망 분석에는 NGII 중심선 속성이
    # 필요하다. 한 번 받은 것은 ROAD_CENTERLINE.geojson으로 남겨 네트워크 오류 때도
    # 기존 분석 도판을 유지한다. fallback 면을 만들 때는 같은 응답을 재사용한다.
    centerlines, centerline_error, api = _collect_site_centerlines(
        site, bbox_4326, api, on_progress,
    )

    def with_analysis(summary: dict) -> dict:
        summary["analysis_count"] = len(centerlines)
        summary["analysis_dataset_id"] = "lt_l_n3a0020000"
        if centerline_error:
            summary["analysis_warning"] = centerline_error
        return summary

    update_errors = []
    try:
        import_inbox()
    except Exception as exc:
        update_errors.append(f"도로 ZIP inbox 설치 실패: {exc}")
    address = (manifest.get("resolved_by") or {}).get("address")
    region = normalize_region(address)
    if region and check_updates:
        for result in refresh_region(region):
            if result.get("status") == "error":
                update_errors.append(result.get("error", ""))

    for ds in DATASETS:
        ds_region = normalize_region(address, ds["id"]) or normalize_region(region, ds["id"])
        if not ds_region:
            continue
        current = current_version(ds["id"], ds_region)
        if not current:
            continue
        geom, source_count = _clip_regional(current, bbox_4326)
        if not geom.is_empty:
            return with_analysis(
                _write_site_geojson(site, geom, _source_from_current(current), source_count)
            )

    if api is None:
        key, domain = load_key(ENV_PATH)
        api = VWorld(key, domain)
    try:
        geom, source = _centerline_fallback(
            api, bbox_4326, on_progress, centerlines or None,
        )
        if update_errors:
            source["regional_polygon_note"] = update_errors[0]
        return with_analysis(
            _write_site_geojson(site, geom, source, source.get("source_feature_count", 0))
        )
    except Exception as exc:
        # 이미 지역 Polygon으로 만든 정상 파일이 있다면 일시적인 네트워크 실패로
        # 덮어쓰지 않는다. 지목=도 fallback으로 돌아가는 일도 없다.
        old = _json_read(site.geojson(ROAD_AREA_ID))
        if old and old.get("features"):
            source = old.get("road_source") or {}
            return with_analysis({
                "data_id": ROAD_AREA_ID, "name": "도로면",
                "count": len(old["features"]), "source": source,
                "warning": str(exc),
            })
        source = {
            "mode": "unavailable", "dataset_id": "", "label": "도로면 자료 없음",
            "error": str(exc),
        }
        if update_errors:
            source["regional_polygon_note"] = update_errors[0]
        return with_analysis(_write_site_geojson(site, GeometryCollection(), source))


def update_manifest(site: Site, road_summary: dict) -> None:
    manifest = site.read_manifest()
    if not manifest:
        return
    layers = [x for x in manifest.get("layers", []) if x.get("data_id") != ROAD_AREA_ID]
    layers.append(road_summary)
    manifest["layers"] = layers
    _json_atomic(site.manifest, manifest)


def _build_one(name: str, check_updates: bool = True) -> dict:
    site = resolve_site(name)
    summary = materialize_site(site, check_updates=check_updates)
    update_manifest(site, summary)
    return summary


def _print_status() -> None:
    print("\n[지역별 도로 Polygon 캐시]")
    any_current = False
    for ds in DATASETS:
        root = _dataset_dir(ds["id"])
        if not os.path.isdir(root):
            continue
        for path in Path(root).glob("*/current.json"):
            current = _json_read(str(path)) or {}
            if not current:
                continue
            any_current = True
            versions = list((path.parent / "versions").glob("*/metadata.json"))
            print(f"  {ds['id']} · {current.get('region')} · {current.get('version')} "
                  f"(보존 {len(versions)}판)")
    if not any_current:
        print("  없음 — 공식 ZIP을 road_data.py import로 넣으면 됩니다.")
    print("\n[대상지 도로면]")
    for name in list_sites():
        site = Site(name)
        fc = _json_read(site.geojson(ROAD_AREA_ID)) or {}
        source = fc.get("road_source") or {}
        print(f"  {name}: {len(fc.get('features') or []):,}개 면 · "
              f"{source.get('label') or '없음'}")


def _cli() -> None:
    parser = argparse.ArgumentParser(description="VWorld 도로 Polygon 지역 캐시")
    sub = parser.add_subparsers(dest="command", required=True)

    p_import = sub.add_parser("import", help="공식 지역 ZIP 검증·변환·설치")
    p_import.add_argument("zip")
    p_import.add_argument("--dataset", choices=[d["id"] for d in DATASETS])
    p_import.add_argument("--region")
    p_import.add_argument("--version")

    p_build = sub.add_parser("build", help="대상지 BBOX로 도로면 생성")
    p_build.add_argument("--name")
    p_build.add_argument("--all", action="store_true")
    p_build.add_argument("--no-check", action="store_true", help="공식판 갱신 확인 생략")

    p_refresh = sub.add_parser("refresh", help="공식판 확인 후 새 판 설치 시도")
    p_refresh.add_argument("--region", required=True)
    p_refresh.add_argument("--force", action="store_true")
    sub.add_parser("status", help="지역 current와 대상지 clip 점검")

    args = parser.parse_args()
    if args.command == "import":
        inferred_ds, inferred_region = _infer_archive(args.zip)
        dataset_id = args.dataset or inferred_ds
        region = args.region or inferred_region
        if not dataset_id or not region:
            raise SystemExit("파일명에서 데이터셋/지역을 알 수 없습니다. --dataset과 --region을 지정하세요.")
        current = install_archive(args.zip, dataset_id, region, args.version)
        print(f"설치 완료: {current['dataset_name']} · {current['region']} · {current['version_id']}")
    elif args.command == "build":
        names = list_sites() if args.all else [resolve_site(args.name).name]
        for name in names:
            result = _build_one(name, check_updates=not args.no_check)
            print(f"{name}: {result['count']}개 면 · {result['source'].get('label')}")
    elif args.command == "refresh":
        for result in refresh_region(args.region, force=args.force):
            print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        _print_status()


if __name__ == "__main__":
    try:
        _cli()
    except (VWorldError, OSError, ValueError, RuntimeError) as exc:
        raise SystemExit(f"오류: {exc}")
