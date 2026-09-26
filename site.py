"""대상지 분석 — 주소 하나로 수집·조인·도면화까지 한 번에.

    python site.py "서울특별시 동대문구 제기동 988"
    python site.py "부산광역시 중구 동광동3가 1" --radius 500 --name 부산원도심
    python site.py --list                      # 지금까지 분석한 대상지 목록
    python site.py --name 제기동 --select 1123010300109880000

주소만 바꾸면 어느 지역이든 같은 절차로 돕니다. 결과는 out/<대상지>/ 에 따로 쌓입니다.
"""

from __future__ import annotations

import argparse
import subprocess
import sys

from common import last_site, list_sites

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def run(step: str, argv: list[str]) -> None:
    print(f"\n{'━' * 60}\n  {step}\n{'━' * 60}", flush=True)
    result = subprocess.run([sys.executable, *argv])
    if result.returncode != 0:
        raise SystemExit(f"'{step}' 단계에서 중단되었습니다.")


def main():
    p = argparse.ArgumentParser(description="대상지 분석 파이프라인")
    p.add_argument("address", nargs="?", help='지번주소. 예: "서울 동대문구 제기동 988"')
    p.add_argument("--name", help="대상지 이름(폴더명). 생략하면 주소에서 만듦")
    p.add_argument("--radius", type=float, help="중심에서의 반경(m). 기본 350")
    p.add_argument("--cell", type=float, help="수집 격자 크기(도)")
    p.add_argument("--select", nargs="*", help="선택 필지 PNU (V-SITE 레이어로 강조)")
    p.add_argument("--no-ledger", action="store_true", help="건축물대장 조회 생략")
    p.add_argument("--skip-fetch", action="store_true", help="이미 받아둔 데이터로 다시 도면만 생성")
    p.add_argument("--terrain", action="store_true",
                   help="지형도 함께 (설치된 전국 NGII DEM 우선 · 서울 등고선 fallback)")
    p.add_argument("--list", action="store_true", help="분석한 대상지 목록 출력")
    args = p.parse_args()

    if args.list:
        sites = list_sites()
        print("분석한 대상지:" if sites else "아직 분석한 대상지가 없습니다.")
        for s in sites:
            print(f"  · {s}")
        return

    name = args.name
    if not args.skip_fetch:
        if not args.address:
            raise SystemExit(
                '대상지 주소가 필요합니다.\n'
                '  예: python site.py "서울특별시 동대문구 제기동 988"'
            )
        argv = ["fetch_site.py", args.address]
        if args.name:
            argv += ["--name", args.name]
        if args.radius:
            argv += ["--radius", str(args.radius)]
        if args.cell:
            argv += ["--cell", str(args.cell)]
        run("① 공간정보 수집 (브이월드)", argv)

        # fetch_site 가 실제로 만든 폴더 이름을 잡는다 (지오코딩 결과로 정해질 수 있음)
        name = name or last_site()

    argv = ["build_db.py"]
    if name:
        argv += ["--name", name]
    if args.no_ledger:
        argv += ["--no-ledger"]
    run("② 건축물대장 조인 (SQLite)", argv)

    argv = ["to_dxf.py", "--preview"]
    if name:
        argv += ["--name", name]
    if args.select:
        argv += ["--select", *args.select]
    run("③ 도면 생성 (DXF·CSV)", argv)

    if args.terrain:
        argv = ["terrain.py"]
        if name:
            argv += ["--name", name]
        run("④ 지형 (등고선·표고점)", argv)

    print(f"\n{'━' * 60}\n  완료 — out/{name or '<대상지>'}/ 확인\n{'━' * 60}")


if __name__ == "__main__":
    main()
