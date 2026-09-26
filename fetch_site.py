"""① 브이월드에서 대상지 주변 공간정보를 내려받아 GeoJSON으로 저장한다.

사용 예:
    python fetch_site.py "서울특별시 동대문구 제기동 988"
    python fetch_site.py "부산광역시 중구 동광동3가 1" --radius 500 --name 부산원도심
    python fetch_site.py --bbox 127.034 37.580 127.043 37.587 --name 제기동
"""

from __future__ import annotations

import argparse
import json
import sys

from common import ENV_PATH, Site, load_config, progress, remember_site, slugify
from road_data import ROAD_AREA_ID, materialize_site
from vworld import VWorld, VWorldError, bbox_from_center, load_key

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="① 대상지 공간정보 수집")
    p.add_argument("address", nargs="?", help="지번주소. 예: \"서울 동대문구 제기동 988\"")
    p.add_argument("--name", help="대상지 이름(폴더명). 생략하면 주소에서 만듦")
    p.add_argument("--radius", type=float, help="중심에서의 반경(m)")
    p.add_argument("--bbox", nargs=4, type=float, metavar=("MINLON", "MINLAT", "MAXLON", "MAXLAT"))
    p.add_argument("--cell", type=float, default=0.004, help="수집 격자 크기(도). 기본 0.004 ≈ 350m")
    p.add_argument("--only", nargs="*", help="특정 데이터ID만 수집")
    p.add_argument("--config")
    return p.parse_args(argv)


def short_name(address: str | None) -> str | None:
    """지번주소에서 폴더로 쓸 짧은 이름. '서울특별시 동대문구 제기동 897-7' → '제기동 897-7'.

    시·도와 구까지 붙이면 폴더 목록에서 구분이 안 되고 이름이 잘린다.
    """
    if not address:
        return None
    parts = address.split()
    return " ".join(parts[-2:]) if len(parts) >= 2 else address


def main(argv=None):
    args = parse_args(argv)
    cfg = load_config(args.config)

    if not args.address and not args.bbox:
        raise SystemExit('대상지 주소가 필요합니다.  예: python fetch_site.py "서울 동대문구 제기동 988"')

    key, domain = load_key(ENV_PATH)
    api = VWorld(key, domain)

    # ---------------------------------------------------------- 범위 결정
    if args.bbox:
        bbox = tuple(args.bbox)
        cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
        # 좌표만 있으면 이름을 못 짓는다. 중심점을 역지오코딩해서 사람이 읽을 이름을 만든다.
        here = args.address or api.reverse_geocode(cx, cy)
        meta = {"source": "지도 영역 지정", "address": here,
                "query": args.address, "center": [cx, cy]}
        label = args.name or short_name(here) or f"영역_{cx:.4f}_{cy:.4f}"
        if here:
            print(f"  · 영역 중심: {cx:.6f}, {cy:.6f}  ({here})")
    else:
        radius = args.radius or cfg.get("default_radius_m", 350)
        hit = api.search_address(args.address)
        bbox = bbox_from_center(hit["lon"], hit["lat"], radius)
        meta = {"source": "주소 지오코딩", "address": hit["address"],
                "query": args.address, "radius_m": radius,
                "center": [hit["lon"], hit["lat"]], "pnu": hit.get("id")}
        label = args.name or hit["address"] or args.address
        print(f"  · 지오코딩: {args.address} → {hit['lon']:.6f}, {hit['lat']:.6f}  ({hit['address']})")

    site = Site(slugify(label)).ensure()
    remember_site(site.name)
    print(f"[대상지] {site.name}")
    print(f"  · 수집 범위 BOX({bbox[0]:.6f}, {bbox[1]:.6f}, {bbox[2]:.6f}, {bbox[3]:.6f})")
    print(f"  · 저장 위치 out/{site.name}/")

    # ---------------------------------------------------------- 레이어 수집
    layers = [l for l in cfg["layers"] if l.get("enabled", True)]
    if args.only:
        layers = [l for l in layers if l["data_id"] in args.only]

    summary = []
    collect_road_area = not args.only or ROAD_AREA_ID in args.only
    n_layers = max(len(layers) + (1 if collect_road_area else 0), 1)
    for li, layer in enumerate(layers):
        data_id = layer["data_id"]
        print(f"\n[{layer['name']}] {data_id}")
        progress(li / n_layers * 100)

        def on_cell(done, total, count, _li=li):
            print(f"\r  · 격자 {done}/{total}  누적 {count}건", end="", flush=True)
            progress((_li + done / max(total, 1)) / n_layers * 100)

        try:
            features = api.get_feature_tiled(data_id, bbox, cell_deg=args.cell, on_progress=on_cell)
        except VWorldError as e:
            print(f"\r  ! 실패: {e}")
            summary.append({"data_id": data_id, "name": layer["name"], "count": 0, "error": str(e)})
            continue

        with open(site.geojson(data_id), "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "crs": "EPSG:4326", "features": features},
                      f, ensure_ascii=False)
        print(f"\r  · {len(features)}건 저장" + " " * 30)
        summary.append({"data_id": data_id, "name": layer["name"], "count": len(features)})

    # 도로면은 지역 Polygon 캐시를 대상지 BBOX로 자른다. 지역 자료가 아직 없으면
    # NGII 도로중심선의 실제 폭 속성으로 fallback하며, 지목=도 필지는 쓰지 않는다.
    # region 판정에 주소가 필요하므로 먼저 manifest를 기록한 뒤 도로면 항목을 보탠다.
    with open(site.manifest, "w", encoding="utf-8") as f:
        json.dump({"site": site.name, "bbox_4326": list(bbox),
                   "resolved_by": meta, "layers": summary}, f, ensure_ascii=False, indent=2)

    if collect_road_area:
        print(f"\n[도로면] {ROAD_AREA_ID}")
        road_step = len(layers)

        def on_road(done, total, count):
            print(f"\r  · 중심선 fallback 격자 {done}/{total}  누적 {count}건", end="", flush=True)
            progress((road_step + done / max(total, 1)) / n_layers * 100)

        road = materialize_site(site, bbox, api=api, on_progress=on_road)
        summary.append(road)
        print(f"\r  · {road['count']}개 도로면 저장 · {road['source'].get('label', '-')}" + " " * 20)
        with open(site.manifest, "w", encoding="utf-8") as f:
            json.dump({"site": site.name, "bbox_4326": list(bbox),
                       "resolved_by": meta, "layers": summary}, f, ensure_ascii=False, indent=2)

    print(f"\n[완료] 다음 단계:  python build_db.py --name {site.name}")
    if not sys.stdout.isatty():
        print("@@SITE " + json.dumps(site.name, ensure_ascii=False), flush=True)
    return site


if __name__ == "__main__":
    try:
        main()
    except VWorldError as e:
        print(f"\n오류: {e}", file=sys.stderr)
        sys.exit(1)
