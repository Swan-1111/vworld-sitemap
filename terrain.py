"""④ 지형 — 전국 NGII DEM 또는 서울 등고선·표고점을 DXF로.

    python terrain.py --name 제기동

서울 열린데이터광장의 「서울시 경사도」(국토지리정보원 2023년 기준 수치지형도 1:5000)를
받아 대상지 범위로 자르고, 사이트맵과 같은 좌표계·같은 원점으로 DXF에 넣는다.
로그인 없이 받아지므로 인증키가 필요 없다.

  주곡선 5m · 계곡선 25m · 원자료 EPSG:5174 · 공공누리 1유형(출처표시)

서울 밖은 국토정보플랫폼(map.ngii.go.kr)에서 받은 공개 DEM을 ``terrain_data.py import``로
한 번 설치한다. 이후에는 대상지 BBOX와 겹치는 도엽을 자동으로 골라 쓴다. 설치된 DEM이
없는 서울 대상지만 기존 서울시 등고선·표고점으로 내려간다.

평지에서는 5m 간격 등고선이 거의 지나가지 않는다. 그런 곳에서 실제로 쓸모 있는 것은
**표고점**이므로 둘 다 뽑는다.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import zipfile

import ezdxf
from ezdxf.enums import TextEntityAlignment
from shapely.geometry import box
from shapely.ops import transform as shapely_transform

from common import HERE, load_config, network_session, resolve_site, site_frame

# 서울 열린데이터광장 「서울시 경사도」 (OA-22241)
# 화면의 다운로드 버튼이 이 주소로 POST 한다. seq=2 가 등고선 묶음이다.
SEOUL_URL = "https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?useCache=false"
SEOUL_FORM = {"infId": "OA-22241", "seqNo": "", "seq": "2", "infSeq": "1"}
SOURCE_CRS = "EPSG:5174"          # 원자료 좌표계 (중부원점 보정계)
CACHE = os.path.join(HERE, "cache", "seoul_terrain")
SEOUL_BBOX = (126.76, 37.41, 127.19, 37.71)

CONTOUR_KIND = {"CTD001": "계곡선", "CTD002": "주곡선", "CTD003": "간곡선"}


# ------------------------------------------------------------------ 원자료 받기

def ensure_source(refresh: bool = False) -> tuple[str, str]:
    """등고선·표고점 shp 를 캐시에 준비하고 두 경로를 준다.

    44MB 짜리 서울 전역 파일이라 대상지마다 받지 않고 한 번만 받아 둔다.
    """
    line = _find(CACHE, "N3L_F001.shp")
    point = _find(CACHE, "N3P_F002.shp")
    if line and point and not refresh:
        return line, point

    os.makedirs(CACHE, exist_ok=True)
    print("[지형] 서울 열린데이터광장에서 수치지형도를 받습니다 (약 44MB, 최초 1회)")
    r = network_session().post(SEOUL_URL, data=SEOUL_FORM, timeout=600)
    r.raise_for_status()
    if not r.content.startswith(b"PK"):
        raise RuntimeError("받은 파일이 zip 이 아닙니다. 원본 페이지가 바뀌었을 수 있습니다:\n"
                           "  https://data.seoul.go.kr/dataList/OA-22241/F/1/datasetView.do")
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        z.extractall(CACHE)
    print(f"[지형] 캐시 완료 → {CACHE}")

    line, point = _find(CACHE, "N3L_F001.shp"), _find(CACHE, "N3P_F002.shp")
    if not (line and point):
        raise RuntimeError("압축 안에서 등고선(N3L_F001) 또는 표고점(N3P_F002)을 찾지 못했습니다.")
    return line, point


def _find(root: str, name: str) -> str | None:
    for dirpath, _, names in os.walk(root):
        if name in names:
            return os.path.join(dirpath, name)
    return None


# ---------------------------------------------------------------------- 도면화

def _lines(geom):
    """LineString / MultiLineString 을 좌표열 목록으로."""
    if geom.geom_type == "LineString":
        return [list(geom.coords)]
    if geom.geom_type == "MultiLineString":
        return [list(g.coords) for g in geom.geoms]
    return []


def _clear_outputs(site) -> None:
    """현재 대상지에 맞지 않는 예전 자동 생성 지형 파일을 남기지 않는다."""
    for path in (site.dxf_terrain, site.csv_spot, os.path.join(site.dir, "지형_출처.txt")):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass


def _write_dem(site, frame, view_local, dem, flat: bool):
    """DEM 표본과 그로부터 계산한 등고선을 기존 지형 DXF 형식으로 기록한다."""
    _spots, contours, samples, source = dem
    minx, miny, maxx, maxy = view_local.bounds
    samples = [p for p in samples if minx <= p[0] <= maxx and miny <= p[1] <= maxy]
    if not samples:
        return None

    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 6
    msp = doc.modelspace()
    for layer, color in (("V-CONTOUR", 32), ("V-CONTOUR-MAJOR", 30),
                         ("V-CONTOUR-TXT", 30), ("V-DEM-SAMPLE", 6),
                         ("V-DEM-SAMPLE-TXT", 6), ("V-EXTENT", 250)):
        doc.layers.add(layer, color=color)

    msp.add_lwpolyline(list(view_local.exterior.coords), close=True,
                       dxfattribs={"layer": "V-EXTENT"})
    text_h = float(load_config().get("text_height_m", 0.9))
    heights = [float(p[2]) for p in samples]
    for contour in contours:
        z = float(contour["z"])
        pts = [(float(x), float(y), 0.0 if flat else z) for x, y in contour["pts"]]
        if len(pts) < 2:
            continue
        major = abs((z / 25.0) - round(z / 25.0)) < 1e-7
        layer = "V-CONTOUR-MAJOR" if major else "V-CONTOUR"
        msp.add_polyline3d(pts, dxfattribs={"layer": layer})
        mid = pts[len(pts) // 2]
        msp.add_text(f"{z:g}", height=text_h,
                     dxfattribs={"layer": "V-CONTOUR-TXT"}).set_placement(
            mid, align=TextEntityAlignment.CENTER)

    # DEM 전체 격자를 도면에 점으로 쏟지 않고 최대 약 400개 대표 표본만 남긴다.
    stride = max(1, math.ceil(len(samples) / 400))
    shown = samples[::stride]
    rows = []
    for x, y, z in shown:
        dz = 0.0 if flat else float(z)
        msp.add_point((x, y, dz), dxfattribs={"layer": "V-DEM-SAMPLE"})
        rows.append({"표고_m": round(float(z), 2), "도면X": round(float(x), 3),
                     "도면Y": round(float(y), 3),
                     "실좌표X": round(frame.ox + float(x), 3),
                     "실좌표Y": round(frame.oy + float(y), 3)})

    doc.saveas(site.dxf_terrain)
    with open(site.csv_spot, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    with open(os.path.join(site.dir, "지형_출처.txt"), "w", encoding="utf-8") as f:
        f.write(
            "자료: 국토교통부 국토지리정보원 공개 DEM\n"
            "다운로드: 국토정보플랫폼 https://map.ngii.go.kr\n"
            f"설치 버전: {source.get('version') or '-'}\n"
            f"사용 도엽: {', '.join(source.get('files') or [])}\n"
            f"대상 좌표계: {frame.crs} ({frame.crs_label})\n"
            f"DXF 원점: X={frame.ox}, Y={frame.oy}\n"
            "등고선: DEM에서 5m 기본 간격으로 계산\n"
        )
    print(f"[지형] 국토지리정보원 DEM {source.get('tiles', 0)}개 도엽")
    print(f"[표고 표본] {source.get('samples', len(samples))}건 · [등고선] {len(contours)}건")
    print(f"[고저차] {min(heights):.1f} ~ {max(heights):.1f} m "
          f"(차이 {max(heights) - min(heights):.1f} m)")
    print(f"[도면] {site.dxf_terrain}")
    print("@@P 100", flush=True)
    return site


def main(name: str | None = None):
    p = argparse.ArgumentParser(description="대상지의 등고선·표고점을 DXF로 뽑습니다.")
    p.add_argument("--name", help="대상지 폴더명. 생략하면 마지막 대상지")
    p.add_argument("--refresh", action="store_true", help="캐시된 수치지형도를 다시 받음")
    p.add_argument("--flat", action="store_true",
                   help="Z를 0으로 (2D 도면용). 기본은 표고값을 Z에 넣은 3D")
    args = p.parse_args() if name is None else p.parse_args(["--name", name])

    import geopandas as gpd  # 무거워서 필요할 때만 부른다

    cfg = load_config()
    site = resolve_site(args.name)
    manifest = site.read_manifest()
    if not manifest:
        raise SystemExit(f"'{site.name}' 수집 결과가 없습니다. 먼저 fetch_site.py 를 돌리세요.")

    # 사이트맵과 같은 사각형·같은 원점을 써야 CAD에서 겹쳐진다
    frame = site_frame(site, cfg)
    target_crs = frame.crs
    print(f"[좌표계] {target_crs}  ({frame.crs_label})")

    minx, miny, maxx, maxy = manifest["bbox_4326"]
    clip_box = box(*frame.box)
    ox, oy = frame.ox, frame.oy

    # 전국 DEM을 먼저 쓴다. scene.py도 같은 함수를 호출하므로 DXF와 2D/3D 다이어그램의
    # 표고 원천과 좌표가 일치한다.
    view_local = shapely_transform(lambda x, y, z=None: (x - ox, y - oy), clip_box)
    try:
        from terrain_data import scene_terrain
        dem = scene_terrain(target_crs, ox, oy, view_local, pad_fraction=0.0)
    except (ImportError, OSError, RuntimeError, ValueError) as exc:
        dem = None
        if os.path.exists(os.path.join(HERE, "cache", "terrain", "current.json")):
            print(f"[DEM] 설치된 자료를 읽지 못했습니다: {exc}")
    if dem is not None:
        return _write_dem(site, frame, view_local, dem, args.flat)

    # 서울 밖에서는 44MB 서울 전역 파일을 불필요하게 받지 않는다. NGII 포털은 로그인
    # 다운로드라 자동 호출할 수 없으므로, 웹의 DEM 설치 버튼이나 CLI 경로를 정확히 알린다.
    center_lon, center_lat = (minx + maxx) / 2, (miny + maxy) / 2
    if not (SEOUL_BBOX[0] <= center_lon <= SEOUL_BBOX[2] and
            SEOUL_BBOX[1] <= center_lat <= SEOUL_BBOX[3]):
        _clear_outputs(site)
        print("[지형] 이 대상지를 덮는 전국 DEM 도엽이 아직 설치되지 않았습니다.")
        print("       국토정보플랫폼에서 해당 영역의 공개 DEM을 받은 뒤 설치하세요:")
        print("       python terrain_data.py import \"C:\\Downloads\\공개DEM.zip\"")
        print("       https://map.ngii.go.kr")
        return site

    line_shp, point_shp = ensure_source(args.refresh)

    # 원자료가 EPSG:5174 라 읽을 때의 bbox 도 그 좌표계로 줘야 한다
    aoi_src = (gpd.GeoDataFrame(geometry=[box(minx, miny, maxx, maxy)], crs="EPSG:4326")
               .to_crs(SOURCE_CRS))
    src_bbox = tuple(aoi_src.total_bounds)

    contours = gpd.read_file(line_shp, bbox=src_bbox).to_crs(target_crs)
    spots = gpd.read_file(point_shp, bbox=src_bbox).to_crs(target_crs)
    contours = contours[contours.intersects(clip_box)]
    spots = spots[spots.within(clip_box)]
    print(f"[등고선] {len(contours)}건   [표고점] {len(spots)}건")

    # 서울 밖이면 한 건도 안 잡힌다. 빈 도면을 남기면 "지형 있음"으로 오해되므로 만들지 않는다.
    if contours.empty and spots.empty:
        _clear_outputs(site)
        print("[지형] 범위 안에 자료가 없습니다 — 도면을 만들지 않았습니다.")
        print("       이 자료는 서울시 수치지형도입니다. 서울 밖이라면")
        print("       국토정보플랫폼 map.ngii.go.kr 에서 해당 도엽을 직접 받으세요.")
        return site

    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 6      # meters
    msp = doc.modelspace()
    for layer, color in (("V-CONTOUR", 32), ("V-CONTOUR-MAJOR", 30), ("V-CONTOUR-TXT", 30),
                         ("V-SPOT", 6), ("V-SPOT-TXT", 6), ("V-EXTENT", 250)):
        doc.layers.add(layer, color=color)

    ext = shapely_transform(lambda x, y, z=None: (x - ox, y - oy), clip_box)
    msp.add_lwpolyline(list(ext.exterior.coords), close=True,
                       dxfattribs={"layer": "V-EXTENT"})

    text_h = float(cfg.get("text_height_m", 0.9))
    heights: list[float] = []

    for _, row in contours.iterrows():
        z = float(row.get("CONT") or row.get("HEIGHT") or 0)
        # 계곡선(25m마다)은 별도 레이어로. 도면에서 굵게 뽑을 수 있게 나눠 둔다.
        layer = "V-CONTOUR-MAJOR" if str(row.get("DIVI")) == "CTD001" else "V-CONTOUR"
        for coords in _lines(row.geometry):
            pts = [(x - ox, y - oy, 0.0 if args.flat else z) for x, y, *_ in
                   [(c[0], c[1]) for c in coords]]
            if len(pts) < 2:
                continue
            msp.add_polyline3d(pts, dxfattribs={"layer": layer})
            heights.append(z)
        # 등고수치는 선 가운데에 한 번만
        mid = row.geometry.interpolate(0.5, normalized=True)
        msp.add_text(f"{z:g}", height=text_h,
                     dxfattribs={"layer": "V-CONTOUR-TXT"}).set_placement(
            (mid.x - ox, mid.y - oy, 0.0 if args.flat else z), align=TextEntityAlignment.CENTER)

    rows = []
    for _, row in spots.iterrows():
        z = float(row.get("NUME") or row.get("HEIGHT") or 0)
        g = row.geometry
        x, y = g.x - ox, g.y - oy
        msp.add_point((x, y, 0.0 if args.flat else z), dxfattribs={"layer": "V-SPOT"})
        msp.add_text(f"{z:.2f}", height=text_h,
                     dxfattribs={"layer": "V-SPOT-TXT"}).set_placement(
            (x + text_h, y + text_h, 0.0 if args.flat else z), align=TextEntityAlignment.LEFT)
        rows.append({"표고_m": round(z, 2),
                     "도면X": round(x, 3), "도면Y": round(y, 3),
                     "실좌표X": round(g.x, 3), "실좌표Y": round(g.y, 3)})
        heights.append(z)

    out_dxf = site.dxf_terrain
    doc.saveas(out_dxf)
    print(f"[도면] {out_dxf}")

    if rows:
        out_csv = site.csv_spot
        with open(out_csv, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(sorted(rows, key=lambda r: -r["표고_m"]))
        print(f"[표고점] {out_csv}  ({len(rows)}점)")

    lo, hi = min(heights), max(heights)
    print(f"[고저차] {lo:.1f} ~ {hi:.1f} m  (차이 {hi - lo:.1f} m)")
    if len(contours) <= 2:
        print("        평지라 등고선이 거의 없습니다. 표고점으로 읽으세요.")

    # 사이트맵과 같은 원점을 썼다는 사실을 남긴다
    with open(os.path.join(site.dir, "지형_출처.txt"), "w", encoding="utf-8") as f:
        f.write(
            "자료: 서울 열린데이터광장 「서울시 경사도」 (OA-22241)\n"
            "원출처: 국토지리정보원 2023년 기준 수치지형도 1:5000\n"
            "이용조건: 공공누리 제1유형 (출처표시)\n"
            "https://data.seoul.go.kr/dataList/OA-22241/F/1/datasetView.do\n\n"
            f"원자료 좌표계: {SOURCE_CRS} → 변환: {target_crs}\n"
            f"DXF 원점(0,0)의 실좌표: X={ox}, Y={oy}  (사이트맵과 동일)\n"
            "등고선 간격: 주곡선 5m(V-CONTOUR) · 계곡선 25m(V-CONTOUR-MAJOR)\n"
            f"Z값: {'0 (2D)' if args.flat else '표고값 (3D)'}\n\n"
            "한계: 1:5000 수치지형도라 평지에서는 등고선이 거의 지나가지 않습니다.\n"
            "대지 레벨은 현황측량 성과를 따르세요.\n"
        )
    return site


if __name__ == "__main__":
    main()
