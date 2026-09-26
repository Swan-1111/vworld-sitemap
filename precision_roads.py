"""VWorld 정밀도로 요소를 대상지별로 필요할 때만 수집·캐시한다.

도로면과 중심선은 기본 장면에 항상 있지만, 신호등·노면표시 같은 고밀도 자료까지
매번 받으면 첫 분석이 느려진다. 화면에서 사용자가 하위 레이어를 켠 순간에만 이
모듈을 호출하고, 같은 대상지/BBOX에서는 저장한 결과를 다시 쓴다.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone

from shapely.geometry import GeometryCollection, box, shape
from shapely.ops import transform as shapely_transform

from common import Frame, Site, load_config
from vworld import VWorld, VWorldError

CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
WFS_URL = "https://api.vworld.kr/req/wfs"

# VWorld WFS GetCapabilities(정밀도로지도)에서 확인한 레이어만 공개한다.
# a4는 명칭 그대로 도로 부속 구간이며, 보도라고 단정하지 않는다.
LAYERS = {
    "driveway": {
        "data_id": "lt_c_a3drivewaysection", "name": "차도 구간", "geometry": "polygon",
        "style": {"fill": "#7f8792", "stroke": "#626974", "w": 0.35, "size": 0},
    },
    "subsidiary": {
        "data_id": "lt_c_a4subsidiarysection", "name": "도로 부속 구간", "geometry": "polygon",
        "style": {"fill": "#b8b0a2", "stroke": "#857e73", "w": 0.35, "size": 0},
    },
    "surface_line": {
        "data_id": "lt_l_b2surfacelinemark", "name": "노면 선형표시", "geometry": "line",
        "style": {"fill": None, "stroke": "#f2c94c", "w": 0.8, "size": 0},
    },
    "surface_mark": {
        "data_id": "lt_c_b3surfacemark", "name": "노면 문자·기호", "geometry": "polygon",
        "style": {"fill": "#f2c94c", "stroke": "#c9a22c", "w": 0.25, "size": 0},
    },
    "traffic_light": {
        "data_id": "lt_p_c1trafficlight", "name": "신호등", "geometry": "point",
        "style": {"fill": "#e2564a", "stroke": "#7d2e29", "w": 0.5, "size": 2.3},
    },
    "safety_sign": {
        "data_id": "lt_p_b1safetysign", "name": "안전표지", "geometry": "point",
        "style": {"fill": "#4f7ea8", "stroke": "#294b69", "w": 0.5, "size": 2.0},
    },
    "speed_bump": {
        "data_id": "lt_c_c4speedbump", "name": "과속방지턱", "geometry": "polygon",
        "style": {"fill": "#d1903d", "stroke": "#8d5b20", "w": 0.3, "size": 0},
    },
    "vehicle_safety": {
        "data_id": "lt_l_c3vehicleprotectionsafety", "name": "차량 방호시설", "geometry": "line",
        "style": {"fill": None, "stroke": "#61717d", "w": 0.7, "size": 0},
    },
    "height_barrier": {
        "data_id": "lt_l_c5heightbarrier", "name": "높이 제한시설", "geometry": "line",
        "style": {"fill": None, "stroke": "#8c5b98", "w": 0.8, "size": 0},
    },
}


def layer_catalog() -> list[dict]:
    return [{"id": key, **value} for key, value in LAYERS.items()]


def _cache_path(site: Site, layer_id: str) -> str:
    return os.path.join(site.dir, "cache", "precision_roads", f"{layer_id}.json")


def _read(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as file:
            return json.load(file)
    except (OSError, ValueError):
        return None


def _write(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=os.path.basename(path) + ".",
                                     suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.remove(temporary)
        except OSError:
            pass


def _cache_valid(data: dict | None, bbox: list[float], layer: dict) -> bool:
    if not data or data.get("data_id") != layer["data_id"]:
        return False
    saved_bbox = data.get("bbox_4326") or []
    if len(saved_bbox) != 4 or any(abs(float(a) - float(b)) > 1e-8
                                   for a, b in zip(saved_bbox, bbox)):
        return False
    try:
        checked = datetime.fromisoformat(data["collected_at"]).timestamp()
    except (KeyError, TypeError, ValueError):
        return False
    return datetime.now(timezone.utc).timestamp() - checked < CACHE_TTL_SECONDS


def _rounded_point(point) -> list[float]:
    return [round(float(point[0]), 2), round(float(point[1]), 2)]


def _paths(geometry) -> list[list[list[float]]]:
    if geometry.geom_type == "LineString":
        parts = [geometry]
    else:
        parts = [part for part in getattr(geometry, "geoms", [])
                 if part.geom_type == "LineString"]
    return [[_rounded_point(point) for point in part.coords]
            for part in parts if len(part.coords) >= 2]


def _polygons(geometry) -> list[list[list[list[float]]]]:
    if geometry.geom_type == "Polygon":
        parts = [geometry]
    else:
        parts = [part for part in getattr(geometry, "geoms", [])
                 if part.geom_type == "Polygon"]
    output = []
    for polygon in parts:
        rings = [[_rounded_point(point) for point in ring.coords]
                 for ring in [polygon.exterior, *polygon.interiors]
                 if len(ring.coords) >= 4]
        if rings:
            output.append(rings)
    return output


def _scalar_properties(properties: dict) -> dict:
    output = {}
    for key, value in properties.items():
        if len(output) >= 40:
            break
        if value is None or isinstance(value, (str, int, float, bool)):
            output[str(key)] = value
    return output


def _feature_key(feature: dict) -> str:
    properties = feature.get("properties") or {}
    for key in ("ufid", "id", "uid", "manage", "objectid"):
        if properties.get(key):
            return f"{key}:{properties[key]}"
    if feature.get("id"):
        return "fid:" + str(feature["id"])
    raw = json.dumps(feature.get("geometry"), sort_keys=True).encode()
    return "geom:" + hashlib.md5(raw).hexdigest()


def _wfs_features(api: VWorld, data_id: str, bbox: list[float]) -> tuple[list[dict], list[list[float]]]:
    """WFS의 1,000건 상한에 닿은 셀만 재귀 분할해 누락을 줄인다."""
    collected: dict[str, dict] = {}
    truncated_cells: list[list[float]] = []

    def request_cell(cell, depth=0):
        response = api._request(WFS_URL, {
            "service": "WFS", "version": "1.1.0", "request": "GetFeature",
            "typename": data_id, "srsname": "EPSG:4326",
            "bbox": ",".join(f"{value:.9f}" for value in cell),
            "output": "application/json", "maxfeatures": 1000,
            "key": api.key, "domain": api.domain,
        }, 60)
        try:
            data = response.json()
        except ValueError as exc:
            raise VWorldError(f"[{data_id}] WFS 응답을 해석하지 못했습니다.") from exc
        features = data.get("features") or []
        if len(features) >= 1000 and depth < 6:
            minx, miny, maxx, maxy = cell
            midx, midy = (minx + maxx) / 2, (miny + maxy) / 2
            for child in ((minx, miny, midx, midy), (midx, miny, maxx, midy),
                          (minx, midy, midx, maxy), (midx, midy, maxx, maxy)):
                request_cell(child, depth + 1)
            return
        if len(features) >= 1000:
            truncated_cells.append([float(value) for value in cell])
        for feature in features:
            collected[_feature_key(feature)] = feature

    request_cell(tuple(bbox))
    return list(collected.values()), truncated_cells


def collect(site: Site, layer_id: str, api: VWorld, refresh: bool = False,
            on_progress=None) -> dict:
    if layer_id not in LAYERS:
        raise ValueError(f"지원하지 않는 정밀도로 레이어입니다: {layer_id}")
    manifest = site.read_manifest() or {}
    bbox = [float(value) for value in manifest.get("bbox_4326") or []]
    if len(bbox) != 4:
        raise ValueError("대상지 BBOX가 없습니다.")
    layer = LAYERS[layer_id]
    path = _cache_path(site, layer_id)
    cached = _read(path)
    if not refresh and _cache_valid(cached, bbox, layer):
        return {**cached, "cached": True}

    if on_progress:
        on_progress(0, 1, 0)
    features, truncated_cells = _wfs_features(api, layer["data_id"], bbox)
    if on_progress:
        on_progress(1, 1, len(features))
    frame = Frame(load_config(), manifest)
    context = box(*frame.box)
    output = []
    dropped_count = 0
    for feature in features:
        try:
            geometry = shape(feature.get("geometry"))
            if geometry.is_empty:
                continue
            projected = shapely_transform(frame.to_target, geometry).intersection(context)
            local = shapely_transform(frame.shift, projected)
        except Exception:
            dropped_count += 1
            continue
        if local.is_empty or isinstance(local, GeometryCollection) and not local.geoms:
            continue
        item = {"properties": _scalar_properties(feature.get("properties") or {})}
        points = []
        if local.geom_type == "Point":
            points = [[round(local.x, 2), round(local.y, 2)]]
        elif local.geom_type == "MultiPoint":
            points = [[round(point.x, 2), round(point.y, 2)] for point in local.geoms]
        paths = _paths(local)
        polygons = _polygons(local)
        if points:
            item["points"] = points
        if paths:
            item["paths"] = paths
        if polygons:
            item["polygons"] = polygons
        if len(item) > 1:
            output.append(item)

    result = {
        "layer_id": layer_id,
        "data_id": layer["data_id"],
        "name": layer["name"],
        "geometry": layer["geometry"],
        "style": layer["style"],
        "bbox_4326": bbox,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "source_count": len(features),
        "count": len(output),
        "dropped_count": dropped_count,
        "truncated": bool(truncated_cells),
        "truncated_cells": truncated_cells,
        "warnings": ([f"WFS 1,000건 상한에 남은 셀 {len(truncated_cells)}개가 있어 일부 누락될 수 있습니다."]
                     if truncated_cells else [])
                    + ([f"해석하지 못한 도형 {dropped_count}건을 제외했습니다."]
                       if dropped_count else []),
        "features": output,
        "cached": False,
    }
    _write(path, result)
    return result
