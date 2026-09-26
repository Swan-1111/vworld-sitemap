"""데이터 점검 — 뭐가 이미 있고, 뭐가 아직 네트워크를 타야 하는지.

    python status.py            # 전체
    python status.py --name 제기동

자료를 세 층으로 나눠 본다.

  ① 한 번만 받으면 되는 것   서울 전역 수치지형도. 대상지가 몇 개든 한 벌.
  ② 대상지마다 한 번         지적도·건물·도로·용도지역·대장·위성사진. 받고 나면 재사용.
  ③ 매번 계산                도면·장면·다이어그램. 바깥을 안 부르고 있는 파일로만 만든다.

②의 대장은 **법정동 단위**라 인접한 대상지끼리 서로 얻어 쓴다.
③은 원본이 바뀌면 자동으로 다시 만든다.
"""

from __future__ import annotations

import argparse
import json
import os

from common import OUT_ROOT, Site, list_sites
from road_data import DATASETS, ROAD_AREA_ID, ROAD_CACHE

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "seoul_terrain")
VECTORS = {
    "LP_PA_CBND_BUBUN": "연속지적도",
    "LT_C_SPBD": "건물",
    "LT_L_SPRD": "도로중심선",
    "LT_C_UQ111": "용도지역",
}


def mb(path: str) -> float:
    if os.path.isfile(path):
        return os.path.getsize(path) / 1024 / 1024
    if os.path.isdir(path):
        return sum(os.path.getsize(os.path.join(r, f))
                   for r, _, fs in os.walk(path) for f in fs) / 1024 / 1024
    return 0.0


def mark(ok: bool) -> str:
    return "있음" if ok else "없음"


def report_site(name: str) -> None:
    site = Site(name)
    if not site.exists():
        print(f"  {name}: 수집 결과 없음")
        return

    print(f"\n  ── {name}")

    # ② 대상지마다 한 번
    got = []
    for data_id, label in VECTORS.items():
        p = site.geojson(data_id)
        n = 0
        if os.path.exists(p):
            try:
                with open(p, encoding="utf-8") as f:
                    n = len(json.load(f).get("features", []))
            except (ValueError, OSError):
                n = -1
        got.append(f"{label} {n:,}" if n else f"{label} 없음")
    print("     브이월드 벡터   " + " · ".join(got))

    road_fc = {}
    try:
        with open(site.geojson(ROAD_AREA_ID), encoding="utf-8") as f:
            road_fc = json.load(f)
    except (OSError, ValueError):
        pass
    road_source = road_fc.get("road_source") or {}
    print(f"     도로면         {len(road_fc.get('features') or []):,}개 면 · "
          f"{road_source.get('label') or '없음'}"
          + (f" · {road_source['version']}" if road_source.get("version") else ""))

    ledgers = [f for f in os.listdir(site.geojson_dir)
               if f.startswith("_ledger_") and f.endswith(".json")]
    part = [f for f in ledgers if f.endswith(".part.json")]
    print(f"     건축물대장     법정동 {len(ledgers) - len(part)}개 캐시"
          + (f" · 받다 만 것 {len(part)}개" if part else ""))

    aerial = [f for f in os.listdir(site.dir) if f.startswith("바탕_")]
    print(f"     위성사진       {len(aerial)}장" if aerial else "     위성사진       없음")

    # ③ 매번 계산 (있으면 그만큼 빨라진다)
    scenes = [f for f in os.listdir(site.dir) if f.startswith("_scene_")]
    print(f"     장면 캐시      {len(scenes)}개"
          + (f" ({', '.join(sorted(s[7:-5] for s in scenes))})" if scenes else " — 처음 열 때 1~2초"))

    outs = [("사이트맵 DXF", site.dxf), ("지형 DXF", site.dxf_terrain),
            ("표고점 CSV", site.csv_spot), ("구역경계", site.boundary)]
    print("     산출물         " + " · ".join(
        f"{n} {mark(os.path.exists(p))}" for n, p in outs))
    print(f"     폴더 용량      {mb(site.dir):.1f}MB")


def main():
    p = argparse.ArgumentParser(description="어떤 자료가 이미 있는지 점검합니다.")
    p.add_argument("--name", help="대상지 하나만")
    args = p.parse_args()

    print("\n① 한 번만 받으면 되는 것 — 대상지가 몇 개든 한 벌")
    line = os.path.exists(os.path.join(CACHE, "등고선 5000", "N3L_F001.shp")) or any(
        f == "N3L_F001.shp" for _, _, fs in os.walk(CACHE) for f in fs)
    print(f"     서울 수치지형도  {mark(line)}  {mb(CACHE):.0f}MB"
          + ("  (서울 열린데이터광장 · 인증키 불필요)" if line
             else "  — 지형을 처음 쓸 때 자동으로 받습니다"))

    currents = []
    for ds in DATASETS:
        root = os.path.join(ROAD_CACHE, ds["id"])
        if not os.path.isdir(root):
            continue
        for region in os.listdir(root):
            current = os.path.join(root, region, "current.json")
            if os.path.exists(current):
                with open(current, encoding="utf-8") as f:
                    data = json.load(f)
                currents.append(f"{data.get('region')} {data.get('version')} ({ds['id']})")
    print("     지역 도로 Polygon " + (" · ".join(currents) if currents else
          "없음 — 공식 ZIP 설치 전에는 NGII 중심선 폭 fallback을 씁니다"))

    print("\n② 대상지마다 한 번 — 받고 나면 다시 안 받음")
    names = [args.name] if args.name else list_sites()
    if not names:
        print("     분석한 대상지가 없습니다.")
    for n in names:
        report_site(n)

    print("\n③ 매번 계산 — 바깥을 부르지 않고 있는 파일로만 만든다")
    print("     도면(DXF·CSV) · 장면(2D/3D) · 다이어그램 · PNG/SVG")
    print("     장면은 원본이 바뀌면 자동으로 다시 만듭니다.")

    print("\n④ 늘 실시간 — 캐시하지 않음")
    print("     배경지도 타일   지도를 움직일 때마다 브이월드에서 (브라우저가 직접)")
    print("     주소 ↔ 좌표     분석을 시작할 때 한 번")
    print()


if __name__ == "__main__":
    main()
