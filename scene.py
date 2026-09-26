"""다이어그램용 3차원 장면 데이터.

필지·건물·지형을 **DXF와 같은 좌표계·같은 원점**의 미터 좌표로 내보낸다.
화면에서 본 것과 CAD로 뽑은 것이 어긋나면 안 되기 때문에 변환 규칙을 to_dxf.py와 맞춘다.

건물 높이는 층수 × 층고로 세운다. 실제 높이가 아니라 **추정 매스**다.
"""

from __future__ import annotations

import heapq
import json
import math
import os
import sqlite3
import sys
import tempfile
from collections import Counter

import numpy as np
from pyproj import Transformer
from shapely.geometry import box, shape
from shapely.ops import transform as shapely_transform

from common import Frame, Site, load_config

# 도형이 너무 촘촘하면 브라우저가 버벅인다. 1:5000 도면 수준에서 이 정도면 형태가 유지된다.
SIMPLIFY_M = 0.3
MAX_RING_PTS = 200

# 지형 만드는 방식이 바뀌면 올린다. 캐시 지문에 섞여서 예전 장면을 자동으로 버린다.
SCENE_VERSION = 17         # 17: 내부 링·지반 표본점·자료 제외 경고·분석 방법 표기

ROAD_CATEGORY_FIELDS = {
    "rddv": {
        "name": "도로 구분", "group": "원본 속성",
        "categories": {
            "RDD000": ("미분류", "#c8c8c8"),
            "RDD001": ("고속국도", "#7f0000"),
            "RDD002": ("일반국도", "#b2182b"),
            "RDD003": ("지방도", "#d6604d"),
            "RDD004": ("특별시도", "#f4a582"),
            "RDD005": ("광역시도", "#f6c6a8"),
            "RDD006": ("시도", "#92a86e"),
            "RDD007": ("군도", "#5f8f7b"),
            "RDD008": ("면리간도로", "#6f91b2"),
            "RDD009": ("소로", "#9aa6b2"),
        },
    },
    "pvqt": {
        "name": "포장 재질", "group": "원본 속성",
        "categories": {
            "RDQ000": ("미분류", "#c8c8c8"),
            "RDQ001": ("아스팔트", "#3f4650"),
            "RDQ002": ("아스팔트콘크리트", "#59616c"),
            "RDQ003": ("콘크리트", "#a7a7a7"),
            "RDQ004": ("블록", "#b58c6b"),
            "RDQ005": ("비포장", "#9b7653"),
            "RDQ006": ("포장", "#68727d"),
            "RDQ999": ("기타", "#8f8f8f"),
        },
    },
    "dvyn": {
        "name": "중앙분리대", "group": "원본 속성",
        "categories": {
            "CSU000": ("미분류", "#c8c8c8"),
            "CSU001": ("있음", "#e2564a"),
            "CSU002": ("없음", "#9ca3aa"),
        },
    },
    "onsd": {
        "name": "통행 방향", "group": "원본 속성",
        "categories": {
            "ITH000": ("미분류", "#c8c8c8"),
            "ITH001": ("일방통행", "#e2564a"),
            "ITH002": ("양방통행", "#657b8a"),
        },
    },
}

ROAD_ANALYSIS_FIELDS = {
    "rvwd": {"name": "도로폭", "unit": "m", "group": "원본 속성", "type": "number"},
    "rdln": {"name": "차로수", "unit": "차로", "group": "원본 속성", "type": "number"},
    "hierarchy": {"name": "도로 위계", "unit": "단계", "group": "원본 속성", "type": "number"},
    **{key: {"name": meta["name"], "unit": "", "group": meta["group"], "type": "category"}
       for key, meta in ROAD_CATEGORY_FIELDS.items()},
    "length_m": {"name": "구간 길이", "unit": "m", "group": "계산 지표", "type": "number"},
    "connectivity": {"name": "연결성", "unit": "연결", "group": "계산 지표", "type": "number"},
    "centrality": {"name": "네트워크 중심성", "unit": "지수", "group": "계산 지표", "type": "number"},
    "capacity": {"name": "수용력 추정", "unit": "지수", "group": "계산 지표", "type": "number"},
}

# 큰 도로일수록 높은 값. RDD000은 분류가 없다는 뜻이므로 최저 단계로 둔다.
ROAD_HIERARCHY = {
    "RDD000": 1, "RDD009": 2, "RDD008": 3, "RDD007": 4, "RDD006": 5,
    "RDD005": 6, "RDD004": 6, "RDD003": 7, "RDD002": 8, "RDD001": 9,
}


def _rings(geom) -> list[list[list[float]]]:
    """폴리곤(멀티 포함)을 외곽선 좌표열 목록으로. 소수 둘째 자리면 mm 단위다."""
    out = []
    if geom.geom_type == "Polygon":
        polys = [geom]
    else:
        # CONTEXT 절단 결과가 GeometryCollection이 되는 경우에도 그 안의 면은 살린다.
        polys = [p for p in getattr(geom, "geoms", []) if p.geom_type == "Polygon"]
    for p in polys:
        if p.is_empty or p.geom_type != "Polygon":
            continue
        ring = list(p.exterior.coords)
        if len(ring) > MAX_RING_PTS:
            ring = list(p.exterior.simplify(SIMPLIFY_M * 3).coords)
        out.append([[round(x, 2), round(y, 2)] for x, y in ring])
    return out


def _polygon_groups(geom) -> list[list[list[list[float]]]]:
    """Polygon별 [외곽, 구멍...] 묶음. 도로면의 섬·중앙분리대 구멍을 보존한다."""
    out = []
    if geom.geom_type == "Polygon":
        polys = [geom]
    else:
        polys = [p for p in getattr(geom, "geoms", []) if p.geom_type == "Polygon"]
    for poly in polys:
        if poly.is_empty:
            continue
        rings = [poly.exterior, *poly.interiors]
        group = []
        for line in rings:
            coords = list(line.coords)
            if len(coords) > MAX_RING_PTS:
                coords = list(line.simplify(SIMPLIFY_M * 3).coords)
            if len(coords) >= 4:
                group.append([[round(x, 2), round(y, 2)] for x, y in coords])
        if group:
            out.append(group)
    return out


def _paths(geom) -> list[list[list[float]]]:
    """라인(멀티 포함)을 좌표열 목록으로. 도로처럼 선으로 오는 레이어에 쓴다."""
    out = []
    if geom.geom_type == "LineString":
        parts = [geom]
    else:
        parts = [p for p in getattr(geom, "geoms", []) if p.geom_type == "LineString"]
    for p in parts:
        if p.is_empty or p.geom_type != "LineString":
            continue
        out.append([[round(x, 2), round(y, 2)] for x, y in p.coords])
    return out


def _floors(props: dict) -> int:
    for key in ("gro_flo_co", "grnd_flr_cnt"):
        v = props.get(key)
        try:
            n = int(float(v))
        except (TypeError, ValueError):
            continue
        if n > 0:
            return min(n, 80)      # 대장 오류로 세 자리가 들어오는 경우가 있다
    return 0


def _number(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _road_graph_metrics(records: list[dict], snap_m: float = 1.0) -> None:
    """중심선 구간에 연결성과 근사 edge-betweenness를 붙인다.

    원자료가 교차점에서 잘려 있다는 NGII 중심선의 위상을 이용한다. 좌표 오차로 끝점이
    아주 조금 떨어진 경우는 1m 격자에 스냅한다. 중심성은 큰 대상지에서도 장면 생성이
    오래 멈추지 않도록 최대 72개 노드만 균등 표본으로 삼아 계산한다.
    """
    if not records:
        return

    node_ids: dict[tuple[int, int], int] = {}
    edge_nodes: list[tuple[int, int]] = []
    adjacency: list[list[tuple[int, int, float]]] = []

    def node_of(point) -> int:
        key = (round(point[0] / snap_m), round(point[1] / snap_m))
        node = node_ids.get(key)
        if node is None:
            node = len(node_ids)
            node_ids[key] = node
            adjacency.append([])
        return node

    for edge, record in enumerate(records):
        path = record["paths"][0]
        a, b = node_of(path[0]), node_of(path[-1])
        edge_nodes.append((a, b))
        length = max(0.01, float(record["values"]["length_m"]))
        adjacency[a].append((b, edge, length))
        if b != a:
            adjacency[b].append((a, edge, length))

    degrees = [len({edge for _other, edge, _length in links}) for links in adjacency]
    for edge, record in enumerate(records):
        a, b = edge_nodes[edge]
        record["values"]["connectivity"] = max(degrees[a], degrees[b])

    node_count = len(adjacency)
    if node_count <= 72:
        sources = list(range(node_count))
    else:
        sources = sorted({round(i * (node_count - 1) / 71) for i in range(72)})
    edge_scores = [0.0] * len(records)

    # 가중 Brandes 알고리즘. 도로 길이를 거리로 쓰며 표본 출발점만 줄인다.
    for source in sources:
        stack: list[int] = []
        predecessors: list[list[tuple[int, int]]] = [[] for _ in adjacency]
        paths = [0.0] * node_count
        paths[source] = 1.0
        distance = [math.inf] * node_count
        distance[source] = 0.0
        queue = [(0.0, source)]
        while queue:
            dist_v, vertex = heapq.heappop(queue)
            if dist_v > distance[vertex] + 1e-9:
                continue
            stack.append(vertex)
            for neighbor, edge, length in adjacency[vertex]:
                candidate = dist_v + length
                if candidate < distance[neighbor] - 1e-9:
                    distance[neighbor] = candidate
                    heapq.heappush(queue, (candidate, neighbor))
                    paths[neighbor] = paths[vertex]
                    predecessors[neighbor] = [(vertex, edge)]
                elif abs(candidate - distance[neighbor]) <= 1e-9:
                    paths[neighbor] += paths[vertex]
                    predecessors[neighbor].append((vertex, edge))

        dependency = [0.0] * node_count
        for vertex in reversed(stack):
            if paths[vertex] <= 0:
                continue
            scale = (1.0 + dependency[vertex]) / paths[vertex]
            for previous, edge in predecessors[vertex]:
                contribution = paths[previous] * scale
                edge_scores[edge] += contribution
                dependency[previous] += contribution

    peak = max(edge_scores, default=0.0)
    for edge, record in enumerate(records):
        record["values"]["centrality"] = round(
            100.0 * edge_scores[edge] / peak if peak > 0 else 0.0, 4)


def _ledger(db: str) -> dict[str, dict]:
    if not os.path.exists(db):
        return {}
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    try:
        # 필지 쪽 속성(지목·용도지역·면적)도 함께 싣는다 —
        # 2D 도판에서 필지에도 조건을 걸 수 있어야 하기 때문이다.
        # 면적 열 이름은 parcel_full 에서 「필지면적_m2」다.
        rows = con.execute(
            "SELECT pnu, grnd_flr_cnt, main_purps, strct, use_apr_year,"
            '       jimok, zone, district, "필지면적_m2" AS area_m2 FROM parcel_full'
        ).fetchall()
    except sqlite3.Error as e:
        # 조용히 넘기면 건물 속성까지 통째로 비어 조건이 하나도 안 걸린다.
        print(f"  ! 대장 속성을 읽지 못했습니다: {e}", file=sys.stderr)
        return {}
    finally:
        con.close()
    return {r["pnu"]: dict(r) for r in rows}


# ------------------------------------------------------------------ 캐시
#
# 장면은 이미 받아둔 파일만으로 만든다 — 바깥 서비스를 부르지 않는다.
# 그래도 투영·보간이 1~2초 걸려서, 탭을 오갈 때마다 다시 하면 답답하다.
# 원본 파일이 바뀌면 자동으로 다시 만든다(수정 시각을 지문으로 쓴다).

def _sources(site: Site) -> list[str]:
    files = [site.geojson(d) for d in
             ("LP_PA_CBND_BUBUN", "LT_C_SPBD", "LT_L_SPRD", "LT_C_UQ111",
              "ROAD_AREA", "ROAD_CENTERLINE")]
    try:
        from terrain_data import current_sources
        terrain_files = current_sources()
    except ImportError:
        terrain_files = []
    return files + [site.db, site.boundary, site.manifest] + terrain_files


def fingerprint(site: Site) -> str:
    """원본 파일들의 수정 시각·크기를 묶은 지문."""
    parts = []
    for p in _sources(site):
        try:
            st = os.stat(p)
            parts.append(f"{os.path.basename(p)}:{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            parts.append(f"{os.path.basename(p)}:-")
    parts.append(f"v{SCENE_VERSION}")
    return "|".join(parts)


def _write_json_atomic(path: str, data: dict) -> None:
    """동시 요청이 있어도 독자가 반쪽짜리 JSON을 보지 않게 교체한다."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=os.path.basename(path) + ".",
                                     suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.remove(temporary)
        except OSError:
            pass



def _full_radius(name: str) -> float:
    """수집 범위 전체를 담는 반경(원점 기준 정사각형의 반변)."""
    site = Site(name)
    manifest = site.read_manifest()
    if not manifest:
        return 250.0
    return round(Frame(load_config(), manifest).radius)


def build_cached(name: str, radius: float = 0.0, grid_n: int = 56) -> dict:
    """캐시가 맞으면 그대로, 아니면 다시 만들어 저장한다."""
    site = Site(name)
    if not site.exists():
        raise FileNotFoundError(f"'{name}' 수집 결과가 없습니다.")

    if radius is None or radius <= 0:
        radius = _full_radius(name)          # 파일명이 겹치지 않게 실제 값으로
    path = os.path.join(site.dir, f"_scene_{int(radius)}m_g{grid_n}.json")
    fp = fingerprint(site)
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                cached = json.load(f)
            if cached.get("_fingerprint") == fp:
                return cached
        except (ValueError, OSError):
            pass

    data = with_ground(build(name, radius), grid_n)
    data["_fingerprint"] = fp
    try:
        _write_json_atomic(path, data)
    except OSError:
        pass                      # 캐시를 못 써도 결과는 돌려준다
    return data


def build_context_cached(name: str, radius: float, grid_n: int, context_dir: str) -> dict:
    """확장된 3D 전용 필지·건물 캐시에서 장면을 만든다."""
    site = Site(name)
    manifest_path = os.path.join(context_dir, "_manifest.json")
    with open(manifest_path, encoding="utf-8") as f:
        source_manifest = json.load(f)
    sources = [manifest_path, site.db, site.boundary, site.geojson("ROAD_AREA"),
               site.geojson("ROAD_CENTERLINE")]
    try:
        from terrain_data import current_sources
        sources += current_sources()
    except ImportError:
        pass
    sources += [os.path.join(context_dir, f"{data_id}.geojson")
                for data_id in ("LP_PA_CBND_BUBUN", "LT_C_SPBD")]
    parts = []
    for source in sources:
        try:
            st = os.stat(source)
            parts.append(f"{os.path.basename(source)}:{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            parts.append(f"{os.path.basename(source)}:-")
    parts.append(f"v{SCENE_VERSION}")
    fp = "|".join(parts)
    path = os.path.join(context_dir, f"_scene_{int(radius)}m_g{grid_n}.json")
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                cached = json.load(f)
            if cached.get("_fingerprint") == fp:
                return cached
        except (ValueError, OSError):
            pass

    data = with_ground(build(name, radius, source_manifest, context_dir), grid_n)
    data["_fingerprint"] = fp
    data["context_source_radius"] = source_manifest.get("radius")
    try:
        _write_json_atomic(path, data)
    except OSError:
        pass
    return data


def build(name: str, radius: float = 0.0, source_manifest: dict | None = None,
          source_geojson_dir: str | None = None) -> dict:
    """대상지 중심에서 radius 안의 필지·건물·지형을 장면으로 만든다.

    radius 를 0 이하로 주면 수집 범위 전체를 담는다.
    """
    site = Site(name)
    base_manifest = site.read_manifest()
    if not base_manifest:
        raise FileNotFoundError(f"'{name}' 수집 결과가 없습니다.")

    manifest = source_manifest or base_manifest

    cfg = load_config()
    # 원점은 **원래 대상지** 기준. 확장 자료를 얹어도 도면과 같은 자리에 놓이게.
    base_frame = Frame(cfg, base_manifest)
    target_crs, crs_label = base_frame.crs, base_frame.crs_label
    to_target = base_frame.to_target
    ox, oy = base_frame.ox, base_frame.oy

    # 자르는 상자는 지금 보는 자료의 범위 (확장했으면 그만큼 넓다)
    clip_box = box(*Frame(cfg, manifest).box)

    # radius <= 0 이면 수집 범위 전체를 담는다.
    # 대상지를 법정동 전체로 잡으면 반경 600m 로는 가운데만 나와서, 경계는 큰데
    # 내용은 작은 정사각형만 그려지는 일이 생긴다.
    half_w = (clip_box.bounds[2] - clip_box.bounds[0]) / 2
    half_h = (clip_box.bounds[3] - clip_box.bounds[1]) / 2
    if radius is None or radius <= 0:
        radius = round(max(half_w, half_h))
    square_view = box(-radius, -radius, radius, radius)
    context_view = shapely_transform(
        lambda x, y, z=None: (x - ox, y - oy), clip_box
    )
    # 사용자가 정한 수집 범위(CONTEXT)와 현재 반경을 모두 지킨다. 예전에는
    # 교차 여부만 확인한 뒤 원본 도형 전체를 실어, 가장자리 밖 건물·필지가 삐져나왔다.
    view = square_view.intersection(context_view)

    def to_local(geom):
        """GeoJSON은 EPSG:4326이다. 목표 좌표계로 투영한 뒤에 원점을 옮긴다."""
        g = shapely_transform(to_target, geom)
        g = shapely_transform(lambda x, y, z=None: (x - ox, y - oy), g)
        return g.simplify(SIMPLIFY_M, preserve_topology=True)

    def source_path(data_id: str, base_fallback: bool = False):
        path = (os.path.join(source_geojson_dir, f"{data_id}.geojson")
                if source_geojson_dir else site.geojson(data_id))
        if base_fallback and not os.path.exists(path):
            path = site.geojson(data_id)
        return path

    load_warnings = []

    def load(data_id: str, base_fallback: bool = False):
        path = source_path(data_id, base_fallback)
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as f:
            fc = json.load(f)
        items = []
        invalid_count = 0
        clip_error_count = 0
        for feat in fc.get("features", []):
            try:
                g = to_local(shape(feat["geometry"]))
            except Exception:
                invalid_count += 1
                continue
            if g.is_empty or not g.intersects(view):
                continue
            try:
                g = g.intersection(view)
            except Exception:
                clip_error_count += 1
                continue
            if not g.is_empty:
                items.append((g, feat.get("properties") or {}))
        if invalid_count or clip_error_count:
            load_warnings.append({
                "dataset_id": data_id,
                "invalid_geometry": invalid_count,
                "clip_errors": clip_error_count,
            })
        return items

    ledger = _ledger(site.db)

    parcels = []
    for g, props in load("LP_PA_CBND_BUBUN"):
        polygons = _polygon_groups(g)
        if not polygons:
            continue
        rings = [polygon[0] for polygon in polygons]
        anchor = g.representative_point()
        pnu = str(props.get("pnu") or "")
        row = ledger.get(pnu, {})
        jimok = row.get("jimok") or props.get("jimok") or ""
        parcels.append({"pnu": pnu,
                        "jibun": props.get("jibun") or "",
                        "jimok": jimok,
                        "zone": row.get("zone") or "",
                        "district": row.get("district") or "",
                        "area": row.get("area_m2") or 0,
                        "rings": rings, "polygons": polygons,
                        "base_point": [round(anchor.x, 2), round(anchor.y, 2)]})

    buildings = []
    for g, props in load("LT_C_SPBD"):
        polygons = _polygon_groups(g)
        if not polygons:
            continue
        rings = [polygon[0] for polygon in polygons]
        pnu = str(props.get("bd_mgt_sn") or "")[:19]
        row = ledger.get(pnu, {})
        floors = _floors(props) or _floors(row)
        center = g.representative_point()
        center_lon, center_lat = base_frame.to_wgs(center.x + ox, center.y + oy)
        buildings.append({
            "pnu": pnu, "floors": floors,
            "purps": row.get("main_purps") or "",
            "strct": row.get("strct") or "",
            "year": row.get("use_apr_year") or "",
            "center_4326": [round(center_lon, 8), round(center_lat, 8)],
            "rings": rings, "polygons": polygons,
            "base_point": [round(center.x, 2), round(center.y, 2)],
        })

    # 2D 도판에서 쓸 선·면 레이어. 3D에서는 안 쓰지만 같은 좌표라 같이 실어 보낸다.
    roads = []
    for g, props in load("LT_L_SPRD"):
        paths = _paths(g.intersection(view))
        if paths:
            roads.append({"name": props.get("rn") or "", "paths": paths})

    # 도로면은 dissolve된 Polygon이라 구간별 속성을 잃는다. NGII 중심선을 별도로
    # 싣고 원본 속성 및 이 선들의 위상으로 계산한 네트워크 지표를 도로면 위에 입힌다.
    road_analysis_features = []
    for g, props in load("ROAD_CENTERLINE", base_fallback=True):
        paths = _paths(g.intersection(view))
        if not paths:
            continue
        base_values = {}
        for key in ("rvwd", "rdln"):
            value = _number(props.get(key))
            if value is not None and value >= 0:
                base_values[key] = round(value, 4)
        for key in ROAD_CATEGORY_FIELDS:
            value = str(props.get(key) or "").strip().upper()
            if value:
                base_values[key] = value
        hierarchy = ROAD_HIERARCHY.get(base_values.get("rddv"))
        if hierarchy is not None:
            base_values["hierarchy"] = hierarchy
        width = base_values.get("rvwd")
        if width is None or width <= 0:
            width = max(1.0, base_values.get("rdln", 1.0)) * 3.25

        # MultiLineString도 각 path를 네트워크 edge 하나로 다뤄야 끝점 연결성이 맞는다.
        for part_index, path in enumerate(paths):
            length_m = sum(math.hypot(b[0] - a[0], b[1] - a[1])
                           for a, b in zip(path, path[1:]))
            if length_m <= 0:
                continue
            values = dict(base_values)
            values["length_m"] = round(length_m, 4)
            values["capacity"] = round(
                max(1.0, width) * max(1.0, values.get("rdln", 1.0)), 4)
            road_analysis_features.append({
                "paths": [path],
                "values": values,
                "width": round(max(1.5, min(80.0, width)), 2),
                "name": props.get("name") or props.get("rdnm") or "",
                "road_number": props.get("rdnu") or "",
                "ufid": props.get("ufid") or "",
                "part": part_index,
            })

    _road_graph_metrics(road_analysis_features)

    field_values = {key: [] for key, meta in ROAD_ANALYSIS_FIELDS.items()
                    if meta["type"] == "number"}
    category_counts = {key: Counter() for key in ROAD_CATEGORY_FIELDS}
    for feature in road_analysis_features:
        for key, value in feature["values"].items():
            if key in field_values and isinstance(value, (int, float)):
                field_values[key].append(value)
            elif key in category_counts and value:
                category_counts[key][str(value)] += 1

    road_analysis_fields = []
    for key, meta in ROAD_ANALYSIS_FIELDS.items():
        field = {"id": key, "name": meta["name"], "unit": meta["unit"],
                 "group": meta["group"], "type": meta["type"]}
        if meta["type"] == "number":
            values = field_values.get(key) or []
            if not values:
                continue
            field.update({"min": round(min(values), 4), "max": round(max(values), 4),
                          "count": len(values)})
        else:
            counts = category_counts.get(key) or Counter()
            if not counts:
                continue
            definitions = ROAD_CATEGORY_FIELDS[key]["categories"]
            categories = []
            for value, count in counts.most_common():
                label, color = definitions.get(value, (value, "#8f8f8f"))
                categories.append({"id": value, "name": label, "color": color, "count": count})
            field.update({"count": sum(counts.values()), "categories": categories})
        road_analysis_fields.append(field)
    road_analysis_source = {}
    centerline_path = source_path("ROAD_CENTERLINE", base_fallback=True)
    if os.path.exists(centerline_path):
        try:
            with open(centerline_path, encoding="utf-8") as f:
                road_analysis_source = json.load(f).get("analysis_source") or {}
        except (OSError, ValueError):
            pass

    # 도로면은 연속지적도 지목으로 만들지 않는다. 지역별 실폭도로/도로경계 Polygon을
    # BBOX clip한 ROAD_AREA만 싣고, 지역 SHP가 없을 때도 NGII 중심선 fallback은
    # road_data.py가 별도 출처로 만들어 둔다.
    road_areas = []
    for g, _props in load("ROAD_AREA", base_fallback=True):
        for rings in _polygon_groups(g.intersection(view)):
            road_areas.append({"rings": rings})
    road_area_source = {}
    road_path = source_path("ROAD_AREA", base_fallback=True)
    if os.path.exists(road_path):
        try:
            with open(road_path, encoding="utf-8") as f:
                road_area_source = json.load(f).get("road_source") or {}
        except (OSError, ValueError):
            pass

    zones = []
    for g, props in load("LT_C_UQ111"):
        rings = _rings(g.intersection(view))
        if rings:
            zones.append({"name": props.get("uname") or "", "rings": rings})

    # 지도에서 점으로 찍어 그린 구역 경계 (있을 때만)
    boundary = []
    if os.path.exists(site.boundary):
        with open(site.boundary, encoding="utf-8") as f:
            bfc = json.load(f)
        for feat in bfc.get("features", []):
            try:
                g = to_local(shape(feat["geometry"]))
            except Exception:
                continue
            boundary.extend(_rings(g.intersection(view)))

    # 지형 — terrain.py 가 만든 것과 같은 자료를 같은 원점으로
    spots, contours, pad, terrain_source = _terrain(site, target_crs, ox, oy, view)

    return {
        "name": site.name,
        "crs": target_crs, "crs_label": crs_label,
        "origin": [ox, oy],
        "radius": radius,
        "context_bounds": [round(v, 2) for v in view.bounds],
        "parcels": parcels,
        "buildings": buildings,
        "roads": roads,
        "road_areas": road_areas,
        "road_area_source": road_area_source,
        "road_analysis": {
            "source": road_analysis_source,
            "method": {
                "kind": "heuristic",
                "label": "근사 도로망 지표",
                "note": "끝점 연결 그래프의 근사 중심성과 도로폭·차로수 기반 값이며 Space Syntax 또는 실제 교통량 모델이 아닙니다.",
            },
            "fields": road_analysis_fields,
            "features": road_analysis_features,
        },
        "zones": zones,
        "boundary": boundary,
        "spots": spots,
        "contours": contours,
        "pad": pad,                       # 그리지 않는다. 가장자리 보간용.
        "terrain_source": terrain_source,
        "has_terrain": bool(spots or contours or pad),
        "warnings": load_warnings,
    }


# 보간용 표본을 박스 밖으로 이만큼 더 읽는다.
# 박스에 딱 맞춰 자르면 가장자리가 삼각망 밖으로 나가 IDW 로 지어낸 값이 되고,
# 그 자리에서 지면이 접히거나 솟는다. 밖에도 표본이 있으면 가장자리까지 삼각망이 덮는다.
TERRAIN_PAD = 0.35
PAD_STEP_M = 8.0                 # 여분 표본 간격 — 가장자리를 붙잡는 용도라 성겨도 된다


def _walk(coords, step: float):
    """좌표열을 일정 간격으로 훑어 점을 낸다. 양 끝은 항상 포함."""
    out, prev, acc = [], None, 0.0
    for x, y in coords:
        if prev is None:
            out.append((x, y))
        else:
            acc += math.hypot(x - prev[0], y - prev[1])
            if acc >= step:
                out.append((x, y))
                acc = 0.0
        prev = (x, y)
    if prev and (not out or out[-1] != prev):
        out.append(prev)
    return out


def _terrain(site: Site, target_crs: str, ox: float, oy: float, view):
    """등고선·표고점을 장면 좌표로.

    돌려주는 것은 (표고점, 등고선, 여분표본) 세 가지다. 앞의 둘은 **그려지는** 것이라
    보이는 박스에 맞춰 자르고, 여분표본은 **보간에만** 쓰는 박스 바깥의 점이다.
    원자료가 없으면 빈 목록. 설치된 전국 NGII DEM을 먼저 쓰고, 해당 도엽이 없을 때만
    기존 서울시 등고선·표고점으로 내려간다.
    """
    try:
        from terrain_data import scene_terrain
        dem = scene_terrain(target_crs, ox, oy, view, TERRAIN_PAD)
        if dem is not None:
            return dem
    except (ImportError, OSError, RuntimeError, ValueError):
        pass

    try:
        import geopandas as gpd
    except ImportError:
        return [], [], [], {}

    from terrain import CACHE, SOURCE_CRS, _find

    line_shp, point_shp = _find(CACHE, "N3L_F001.shp"), _find(CACHE, "N3P_F002.shp")
    if not (line_shp and point_shp):
        return [], [], [], {}

    r = max(abs(float(v)) for v in view.bounds)
    R = r * (1 + TERRAIN_PAD)

    # 읽을 때 쓸 bbox 를 원자료 좌표계로 — 여분까지 덮게 넓힌다
    back = Transformer.from_crs(target_crs, SOURCE_CRS, always_xy=True).transform
    pts = [back(ox + dx, oy + dy) for dx in (-R, R) for dy in (-R, R)]
    sx, sy = [p[0] for p in pts], [p[1] for p in pts]
    src_bbox = (min(sx), min(sy), max(sx), max(sy))

    view_box = box(ox - r, oy - r, ox + r, oy + r)
    ext_box = box(ox - R, oy - R, ox + R, oy + R)

    spots, contours, pad = [], [], []
    try:
        sp = gpd.read_file(point_shp, bbox=src_bbox).to_crs(target_crs)
        for _, row in sp.iterrows():
            g = row.geometry
            x, y = g.x - ox, g.y - oy
            z = round(float(row.get("NUME") or row.get("HEIGHT") or 0), 2)
            if abs(x) > R or abs(y) > R:
                continue
            if abs(x) > r or abs(y) > r:
                pad.append([round(x, 2), round(y, 2), z])
            else:
                spots.append([round(x, 2), round(y, 2), z])

        ct = gpd.read_file(line_shp, bbox=src_bbox).to_crs(target_crs)
        for _, row in ct.iterrows():
            z = round(float(row.get("CONT") or row.get("HEIGHT") or 0), 2)
            geom = row.geometry.intersection(ext_box)
            if geom.is_empty:
                continue

            inner = geom.intersection(view_box)          # 그려지는 몫
            for p in (inner.geoms if inner.geom_type.startswith("Multi") else [inner]):
                if p.geom_type != "LineString" or p.is_empty:
                    continue
                pts2 = [[round(x - ox, 2), round(y - oy, 2)] for x, y in p.simplify(1.0).coords]
                if len(pts2) >= 2:
                    contours.append({"z": z, "pts": pts2})

            outer = geom.difference(view_box)            # 보간만 붙잡는 몫
            for p in (outer.geoms if outer.geom_type.startswith("Multi") else [outer]):
                if p.geom_type != "LineString" or p.is_empty:
                    continue
                for x, y in _walk(p.coords, PAD_STEP_M):
                    pad.append([round(x - ox, 2), round(y - oy, 2), z])
    except Exception:
        return spots, contours, pad, {}
    return spots, contours, pad, {
        "kind": "seoul-contour",
        "label": "서울 열린데이터광장 서울시 경사도",
        "version": "2023",
    }


# 등고선을 표고 표본으로 쓸 때의 점 간격.
# 격자 간격(9m)보다 촘촘해야 삼각망이 등고선을 따라간다.
CONTOUR_STEP_M = 4.0


def height_samples(scene: dict) -> np.ndarray:
    """지형을 만들 표본점 (x, y, z).

    표고점만 쓰면 경사지가 밋밋해진다. **등고선이 훨씬 촘촘하고 정확한 표본**이라
    선을 일정 간격으로 잘라 점으로 바꿔 함께 쓴다. 평지에서는 등고선이 거의 없으므로
    표고점이 주가 되고, 경사지에서는 등고선이 주가 된다.
    """
    pts: list[tuple[float, float, float]] = []
    for s in (scene.get("spots") or []) + (scene.get("pad") or []):
        pts.append((s[0], s[1], s[2]))

    for c in scene.get("contours") or []:
        z = c["z"]
        prev = None
        acc = 0.0
        for x, y in c["pts"]:
            if prev is None:
                pts.append((x, y, z))
                prev = (x, y)
                continue
            d = math.hypot(x - prev[0], y - prev[1])
            acc += d
            if acc >= CONTOUR_STEP_M:           # 너무 촘촘하면 표본만 늘고 형태는 그대로다
                pts.append((x, y, z))
                acc = 0.0
            prev = (x, y)
        if prev and (not pts or pts[-1][:2] != prev):
            pts.append((prev[0], prev[1], z))

    return np.asarray(pts, dtype=float) if pts else np.empty((0, 3))


def _idw(samples: np.ndarray, qx: np.ndarray, qy: np.ndarray, power: int = 2) -> np.ndarray:
    """거리 역수 가중 보간. 삼각망 밖(볼록껍질 바깥)을 메울 때만 쓴다."""
    dx = qx[:, None] - samples[None, :, 0]
    dy = qy[:, None] - samples[None, :, 1]
    d2 = dx * dx + dy * dy
    np.maximum(d2, 1e-6, out=d2)                # 표본 위에 정확히 얹힌 점 방어
    w = 1.0 / (d2 ** (power / 2))
    return (w @ samples[:, 2]) / w.sum(axis=1)


def interpolate(samples: np.ndarray, qx: np.ndarray, qy: np.ndarray) -> np.ndarray:
    """표본 높이를 임의 지점으로 옮긴다.

    **삼각망(TIN) 선형보간**을 쓴다. 등고선으로 지형을 만들 때 IDW 를 쓰면
    모든 표본의 가중평균이라 등고선을 지나가지 않고 뭉갠다 — 지면이 등고선
    아래위로 어긋나 보이는 이유가 그것이다. 삼각망은 표본을 정확히 지난다.

    볼록껍질 밖은 삼각망이 못 채우므로 그 부분만 IDW 로 메운다.
    """
    from scipy.interpolate import griddata

    pts, val = samples[:, :2], samples[:, 2]
    q = np.column_stack([qx, qy])
    z = griddata(pts, val, q, method="linear")
    holes = ~np.isfinite(z)
    if holes.any():
        z[holes] = _idw(samples, qx[holes], qy[holes])
    return z


def _smooth(z: np.ndarray, samples: np.ndarray, radius: float, step: float,
            rounds: int = 2, lam: float = 0.5) -> np.ndarray:
    """표본에 닿은 칸은 붙잡아 두고 나머지만 이웃 평균으로 살짝 편다.

    삼각망은 표본을 정확히 지나는 대신 삼각형 경계마다 각이 선다. 표본 근처를 고정하면
    등고선과의 어긋남은 그대로 두고 그 사이의 각만 눕힐 수 있다.
    """
    try:
        from scipy.spatial import cKDTree
    except ImportError:
        return z

    n = z.shape[0] - 1
    axis = np.linspace(-radius, radius, n + 1)
    GX, GY = np.meshgrid(axis, axis)
    d, _ = cKDTree(samples[:, :2]).query(np.column_stack([GX.ravel(), GY.ravel()]))
    pinned = (d.reshape(z.shape) <= step * 0.6)

    for _ in range(rounds):
        nb = np.zeros_like(z)
        cn = np.zeros_like(z)
        nb[1:, :] += z[:-1, :]; cn[1:, :] += 1
        nb[:-1, :] += z[1:, :]; cn[:-1, :] += 1
        nb[:, 1:] += z[:, :-1]; cn[:, 1:] += 1
        nb[:, :-1] += z[:, 1:]; cn[:, :-1] += 1
        z = np.where(pinned, z, z + lam * (nb / cn - z))
    return z


def ground_grid(samples: np.ndarray, radius: float, n: int = 56) -> dict:
    """표고점 + 등고선 표본으로 지형 격자를 만든다.

    격자 간격이 등고선 간격보다 성기면 아무리 잘 보간해도 등고선이 담기지 않는다.
    반경 250m 에 n=56 이면 약 9m 간격이다.

    삼각망으로 뜬 뒤 표본 사이의 각만 눕힌다. 평평하게 나오는 곳은 **그대로 둔다** —
    남창동 시장통이나 북촌 아래쪽처럼 실제로 평지이거나 가장 낮은 등고선 아래라
    자료가 없는 곳이고, 여기를 부풀리면 없는 지형을 지어내는 것이 된다.
    """
    if not len(samples):
        return {"n": 0, "z": [], "step": 0, "min": 0, "max": 0}

    step = (radius * 2) / n
    axis = np.linspace(-radius, radius, n + 1)
    GX, GY = np.meshgrid(axis, axis)            # 행 = y, 열 = x
    z = interpolate(samples, GX.ravel(), GY.ravel()).reshape(GX.shape)
    z = _smooth(z, samples, radius, step)
    z = np.round(z, 2)
    return {"n": n, "step": round(step, 3), "z": z.tolist(),
            "min": float(z.min()), "max": float(z.max()),
            "samples": int(len(samples))}


def _on_grid(ground: dict, radius: float, qx: np.ndarray, qy: np.ndarray) -> np.ndarray:
    """완성된 지형 격자 위에서 높이를 읽는다(겹선형).

    건물 지반고를 표본에서 따로 보간하면 화면에 그려진 지면과 미세하게 어긋나
    건물이 땅에 묻히거나 뜬다. **그려진 그 격자**에서 읽어야 정확히 얹힌다.
    """
    n = ground["n"]
    z = np.asarray(ground["z"], dtype=float)
    t = (np.clip(np.column_stack([qx, qy]), -radius, radius) + radius) / (2 * radius) * n
    j, i = t[:, 0], t[:, 1]                       # 열 = x, 행 = y
    j0 = np.clip(np.floor(j).astype(int), 0, n - 1)
    i0 = np.clip(np.floor(i).astype(int), 0, n - 1)
    fj, fi = j - j0, i - i0
    return ((z[i0, j0] * (1 - fj) + z[i0, j0 + 1] * fj) * (1 - fi)
            + (z[i0 + 1, j0] * (1 - fj) + z[i0 + 1, j0 + 1] * fj) * fi)


def with_ground(scene: dict, grid_n: int = 56) -> dict:
    """장면에 지형 격자와 건물별 지반고를 붙인다."""
    samples = height_samples(scene)
    scene["ground"] = ground_grid(samples, scene["radius"], grid_n)

    def centroids(items):
        out = []
        for it in items:
            anchor = it.get("base_point") or []
            if (len(anchor) >= 2 and np.isfinite(anchor[0])
                    and np.isfinite(anchor[1])):
                out.append((float(anchor[0]), float(anchor[1])))
                continue
            ring = it["rings"][0]
            out.append((sum(p[0] for p in ring) / len(ring),
                        sum(p[1] for p in ring) / len(ring)))
        return out

    for group in ("buildings", "parcels"):
        items = scene.get(group) or []
        if not items:
            continue
        if not len(samples):
            for it in items:
                it["base"] = 0.0
            continue
        cs = centroids(items)
        zs = _on_grid(scene["ground"], scene["radius"],
                      np.array([c[0] for c in cs]), np.array([c[1] for c in cs]))
        for it, z in zip(items, zs):
            it["base"] = round(float(z), 2)
    return scene
