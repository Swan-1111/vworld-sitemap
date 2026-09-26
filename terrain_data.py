"""국토지리정보원 DEM을 도엽별로 보존하고 대상지에 맞는 높이를 읽는다.

국토정보플랫폼의 공개 DEM은 로그인 후 ZIP/IMG/GeoTIFF로 내려받아야 해서 VWorld API처럼
자동 수집할 수 없다. 대신 한 번 설치하면 파일의 실제 좌표계를 읽어 WGS84 범위를 색인하고,
이후 모든 대상지가 현재 버전의 도엽을 BBOX로 자동 선택한다.

    python terrain_data.py import "C:\\Downloads\\공개DEM.zip"
    python terrain_data.py status

버전은 ``cache/terrain/versions`` 아래 계속 보존한다. 새 설치는 이전 도엽 목록에 추가되고
``current.json``만 새 색인을 가리키므로, 기존 원본을 지우지 않고 되돌릴 수 있다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely.geometry import LineString, box

from common import HERE


CACHE_ROOT = os.environ.get("VWORLD_TERRAIN_CACHE", os.path.join(HERE, "cache", "terrain"))
VERSIONS = os.path.join(CACHE_ROOT, "versions")
CURRENT = os.path.join(CACHE_ROOT, "current.json")
RASTER_EXTENSIONS = {".img", ".tif", ".tiff"}
MAX_CONTOUR_LEVELS = 120


def _rasterio():
    try:
        import rasterio
        from rasterio.transform import from_bounds
        from rasterio.warp import Resampling, reproject, transform_bounds
    except ImportError as exc:
        raise RuntimeError(
            "NGII DEM을 읽으려면 rasterio가 필요합니다. "
            "프로젝트 폴더에서 `python -m pip install -r requirements.txt`를 실행하세요."
        ) from exc
    return rasterio, from_bounds, Resampling, reproject, transform_bounds


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_json_atomic(path: str, value: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(temp, path)


def _absolute(relative: str) -> str:
    return os.path.normpath(os.path.join(CACHE_ROOT, relative.replace("/", os.sep)))


def _relative(path: str) -> str:
    return os.path.relpath(path, CACHE_ROOT).replace("\\", "/")


def load_current() -> dict:
    pointer = _read_json(CURRENT)
    manifest_rel = pointer.get("manifest")
    if not manifest_rel:
        return {}
    manifest = _read_json(_absolute(str(manifest_rel)))
    if not manifest:
        return {}
    manifest["current"] = pointer
    return manifest


def current_sources() -> list[str]:
    """장면 캐시 지문에 넣을 현재 포인터와 색인 경로."""
    out = [CURRENT]
    pointer = _read_json(CURRENT)
    if pointer.get("manifest"):
        out.append(_absolute(str(pointer["manifest"])))
    return out


def _intersects(a: list[float], b: tuple[float, float, float, float] | list[float]) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def tiles_for_bbox(bbox_4326) -> tuple[list[dict], dict]:
    manifest = load_current()
    files = []
    for item in manifest.get("files") or []:
        bounds = item.get("bbox_4326")
        path = _absolute(str(item.get("path") or ""))
        if bounds and len(bounds) == 4 and os.path.exists(path) and _intersects(bounds, bbox_4326):
            files.append({**item, "absolute_path": path})
    return files, manifest


def status(bbox_4326=None) -> dict:
    manifest = load_current()
    files = manifest.get("files") or []
    matched = files
    if bbox_4326 is not None:
        matched, _ = tiles_for_bbox(tuple(float(v) for v in bbox_4326))
    return {
        "installed": bool(files),
        "version": manifest.get("version") or "",
        "tiles": len(files),
        "matched_tiles": len(matched),
        "bbox_4326": manifest.get("bbox_4326") or [],
        "updated_at": manifest.get("updated_at") or "",
    }


def _safe_extract(source: str, destination: str) -> None:
    root = os.path.realpath(destination)
    with zipfile.ZipFile(source) as archive:
        for member in archive.infolist():
            target = os.path.realpath(os.path.join(root, member.filename))
            if target != root and not target.startswith(root + os.sep):
                raise ValueError(f"ZIP 안에 안전하지 않은 경로가 있습니다: {member.filename}")
        archive.extractall(root)


def _copy_source(source: str, destination: str, source_name: str | None = None) -> None:
    os.makedirs(destination, exist_ok=True)
    if os.path.isdir(source):
        shutil.copytree(source, os.path.join(destination, Path(source).name), dirs_exist_ok=True)
        return
    if zipfile.is_zipfile(source):
        _safe_extract(source, destination)
        return

    suffix = Path(source_name or source).suffix.lower()
    if suffix not in RASTER_EXTENSIONS:
        raise ValueError("NGII DEM ZIP, IMG, TIF, TIFF 파일만 설치할 수 있습니다.")
    name = os.path.basename(source_name or source)
    shutil.copy2(source, os.path.join(destination, name))

    # IMG/GeoTIFF의 투영·통계 sidecar가 같은 폴더에 있으면 함께 보존한다.
    source_path = Path(source)
    for sibling in source_path.parent.glob(source_path.name + ".*"):
        if sibling.is_file():
            shutil.copy2(sibling, os.path.join(destination, name + sibling.name[len(source_path.name):]))
    for extension in (".prj", ".ige", ".rrd"):
        sibling = source_path.with_suffix(extension)
        if sibling.is_file():
            shutil.copy2(sibling, os.path.join(destination, Path(name).with_suffix(extension).name))


def _raster_files(root: str) -> list[str]:
    return sorted(
        str(path) for path in Path(root).rglob("*")
        if path.is_file() and path.suffix.lower() in RASTER_EXTENSIONS
    )


def _version_id(paths: list[str]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        st = os.stat(path)
        digest.update(os.path.basename(path).encode("utf-8", "replace"))
        digest.update(f":{st.st_size}".encode())
    base = time.strftime("%Y%m%d-%H%M%S") + "-" + digest.hexdigest()[:8]
    version = base
    counter = 2
    while os.path.exists(os.path.join(VERSIONS, version)):
        version = f"{base}-{counter}"
        counter += 1
    return version


def _tile_metadata(path: str, transform_bounds) -> dict:
    rasterio, *_ = _rasterio()
    try:
        with rasterio.open(path) as src:
            if src.count < 1:
                raise ValueError("높이 밴드가 없습니다.")
            if not src.crs:
                raise ValueError("좌표계가 없습니다. PRJ/AUX.XML sidecar를 포함한 ZIP으로 설치하세요.")
            bounds = transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21)
            return {
                "path": _relative(path),
                "name": os.path.basename(path),
                "driver": src.driver,
                "crs": src.crs.to_string(),
                "bbox_4326": [round(float(v), 9) for v in bounds],
                "width": src.width,
                "height": src.height,
                "resolution": [abs(float(src.transform.a)), abs(float(src.transform.e))],
                "dtype": str(src.dtypes[0]),
                "nodata": None if src.nodata is None else float(src.nodata),
                "bytes": os.path.getsize(path),
            }
    except Exception as exc:
        raise ValueError(f"DEM을 읽지 못했습니다 ({os.path.basename(path)}): {exc}") from exc


def import_source(source: str, source_name: str | None = None) -> dict:
    """DEM 파일/ZIP/폴더를 새 버전으로 보존하고 현재 색인을 원자적으로 전환한다."""
    source = os.path.abspath(source)
    if not os.path.exists(source):
        raise FileNotFoundError(source)
    os.makedirs(VERSIONS, exist_ok=True)

    # 먼저 임시 폴더에 풀어 실제 래스터가 있는지 검사한 뒤 버전명을 확정한다.
    staging = os.path.join(CACHE_ROOT, "staging", f"import-{os.getpid()}-{time.time_ns()}")
    source_dir = os.path.join(staging, "source")
    os.makedirs(source_dir, exist_ok=False)
    try:
        _copy_source(source, source_dir, source_name)
        rasters = _raster_files(source_dir)
        if not rasters:
            raise ValueError("설치 파일에서 IMG/GeoTIFF DEM을 찾지 못했습니다.")
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    version = _version_id(rasters)
    version_dir = os.path.join(VERSIONS, version)
    os.makedirs(version_dir, exist_ok=False)
    final_source = os.path.join(version_dir, "source")
    shutil.move(source_dir, final_source)
    try:
        os.rmdir(staging)
    except OSError:
        pass
    rasters = _raster_files(final_source)

    *_, transform_bounds = _rasterio()
    try:
        added = [_tile_metadata(path, transform_bounds) for path in rasters]
    except Exception:
        shutil.rmtree(version_dir, ignore_errors=True)
        raise
    previous = load_current().get("files") or []
    files = [item for item in previous if os.path.exists(_absolute(str(item.get("path") or "")))]
    files.extend(added)  # 겹치면 뒤에 설치한 도엽이 읽을 때 우선한다.

    all_bounds = [item["bbox_4326"] for item in files]
    union = ([min(b[0] for b in all_bounds), min(b[1] for b in all_bounds),
              max(b[2] for b in all_bounds), max(b[3] for b in all_bounds)]
             if all_bounds else [])
    manifest = {
        "version": version,
        "source": "국토지리정보원 공개 DEM",
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "bbox_4326": [round(float(v), 9) for v in union],
        "files": files,
        "added": len(added),
    }
    manifest_path = os.path.join(version_dir, "manifest.json")
    _write_json_atomic(manifest_path, manifest)
    _write_json_atomic(CURRENT, {
        "version": version,
        "manifest": _relative(manifest_path),
        "updated_at": manifest["updated_at"],
    })
    return manifest


def sample_grid(target_crs: str, bounds_target, n: int = 65):
    """대상 좌표계의 정사각 격자로 현재 DEM 도엽들을 재투영한다.

    반환 배열은 장면 좌표처럼 아래→위(y 증가) 순서다. 도엽이 겹치면 나중에 설치한
    파일을 우선하며, 자료가 없는 셀은 NaN으로 둔다.
    """
    rasterio, from_bounds, Resampling, reproject, _ = _rasterio()
    bounds_target = tuple(float(v) for v in bounds_target)
    to_wgs = Transformer.from_crs(target_crs, "EPSG:4326", always_xy=True).transform
    corners = [to_wgs(x, y) for x in (bounds_target[0], bounds_target[2])
               for y in (bounds_target[1], bounds_target[3])]
    bbox_4326 = (min(p[0] for p in corners), min(p[1] for p in corners),
                 max(p[0] for p in corners), max(p[1] for p in corners))
    tiles, manifest = tiles_for_bbox(bbox_4326)
    if not tiles:
        return None, {"tiles": 0, "version": manifest.get("version") or ""}

    n = max(3, int(n))
    destination_transform = from_bounds(*bounds_target, n, n)
    merged = np.full((n, n), np.nan, dtype=np.float32)
    used = []
    for tile in tiles:
        part = np.full((n, n), np.nan, dtype=np.float32)
        try:
            with rasterio.open(tile["absolute_path"]) as src:
                reproject(
                    source=rasterio.band(src, 1), destination=part,
                    src_transform=src.transform, src_crs=src.crs, src_nodata=src.nodata,
                    dst_transform=destination_transform, dst_crs=target_crs, dst_nodata=np.nan,
                    resampling=Resampling.bilinear, init_dest_nodata=True,
                )
        except Exception:
            continue
        valid = np.isfinite(part)
        if valid.any():
            merged[valid] = part[valid]
            used.append(tile["name"])

    # raster 배열은 위→아래지만 사이트 좌표와 np.meshgrid는 아래→위다.
    merged = np.flipud(merged)
    return merged, {
        "kind": "ngii-dem",
        "label": "국토지리정보원 공개 DEM",
        "version": manifest.get("version") or "",
        "tiles": len(used),
        "files": used,
    }


def _line_parts(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "LineString":
        return [geometry]
    if geometry.geom_type in ("MultiLineString", "GeometryCollection"):
        return [part for item in geometry.geoms for part in _line_parts(item)]
    return []


def _contours(axis: np.ndarray, z: np.ndarray, view_box) -> list[dict]:
    finite = z[np.isfinite(z)]
    if not len(finite) or float(finite.max() - finite.min()) < 0.01:
        return []
    try:
        import contourpy
    except ImportError:
        return []

    interval = 5.0
    span = float(finite.max() - finite.min())
    if span / interval > MAX_CONTOUR_LEVELS:
        interval = math.ceil(span / MAX_CONTOUR_LEVELS / 5.0) * 5.0
    first = math.ceil(float(finite.min()) / interval) * interval
    last = math.floor(float(finite.max()) / interval) * interval
    if last < first:
        return []

    generator = contourpy.contour_generator(x=axis, y=axis, z=np.ma.masked_invalid(z))
    out = []
    level = first
    while level <= last + 1e-7:
        for raw in generator.lines(level):
            if len(raw) < 2:
                continue
            clipped = LineString(raw).intersection(view_box)
            for line in _line_parts(clipped):
                points = [[round(float(x), 2), round(float(y), 2)]
                          for x, y in line.simplify(0.7).coords]
                if len(points) >= 2:
                    out.append({"z": round(float(level), 2), "pts": points})
        level += interval
    return out


def scene_terrain(target_crs: str, ox: float, oy: float, view,
                  pad_fraction: float = 0.35):
    """현재 DEM으로 ``scene._terrain`` 형식의 높이 표본과 등고선을 만든다."""
    radius = max(abs(float(v)) for v in view.bounds)
    outer = radius * (1 + max(0.0, float(pad_fraction)))
    # 지나치게 촘촘한 원본 DEM을 브라우저 장면에 전부 싣지 않는다. 장면 자체의 지형
    # 삼각망은 별도 grid_n 설정을 쓰므로, 여기서는 그보다 약간 촘촘한 높이 표본이면 된다.
    n = max(33, min(73, int(math.ceil(outer * 2 / 12.0)) + 1))
    if n % 2 == 0:
        n += 1
    bounds = (ox - outer, oy - outer, ox + outer, oy + outer)
    grid, source = sample_grid(target_crs, bounds, n)
    if grid is None or int(np.isfinite(grid).sum()) < 9:
        return None

    axis = np.linspace(-outer, outer, n)
    samples = []
    for row, y in enumerate(axis):
        for col, x in enumerate(axis):
            value = grid[row, col]
            if np.isfinite(value):
                samples.append([round(float(x), 2), round(float(y), 2), round(float(value), 2)])
    contours = _contours(axis, grid, view)
    source["samples"] = len(samples)
    source["min"] = round(float(np.nanmin(grid)), 2)
    source["max"] = round(float(np.nanmax(grid)), 2)
    return [], contours, samples, source


def main() -> None:
    parser = argparse.ArgumentParser(description="국토지리정보원 공개 DEM 지역 캐시")
    sub = parser.add_subparsers(dest="command", required=True)
    install = sub.add_parser("import", help="NGII DEM ZIP/IMG/GeoTIFF 설치")
    install.add_argument("source")
    sub.add_parser("status", help="설치된 DEM 도엽 확인")
    args = parser.parse_args()

    try:
        if args.command == "import":
            result = import_source(args.source)
            print(f"[DEM] {result['added']}개 도엽 설치 · 현재 {len(result['files'])}개")
            print(f"[버전] {result['version']}")
            print(f"[범위] {result['bbox_4326']}")
        else:
            print(json.dumps(status(), ensure_ascii=False, indent=2))
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
