"""서울 구·법정동 목록을 만들어 둔다 (화면의 주소 드롭다운용).

    python admin_list.py            # web/seoul_admin.json 생성
    python admin_list.py --refresh  # 다시 받기

브이월드 검색 API의 DISTRICT 타입은 법정동코드와 대표좌표를 함께 준다.
한 번 받아 두면 주소를 고를 때마다 네트워크를 타지 않아도 된다.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from common import ENV_PATH, network_session
from vworld import load_key

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "web", "seoul_admin.json")
SEARCH = "https://api.vworld.kr/req/search"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def fetch(key: str, sido: str = "서울특별시") -> dict:
    items, page, session = [], 1, network_session()
    while True:
        r = session.get(SEARCH, params={
            "service": "search", "request": "search", "version": "2.0",
            "query": sido, "type": "DISTRICT", "category": "L4",
            "format": "json", "size": 1000, "page": page, "key": key,
        }, timeout=60)
        r.raise_for_status()
        body = r.json()["response"]
        if body.get("status") != "OK":
            raise SystemExit(f"검색 실패: {body.get('status')} {body.get('error')}")
        got = body["result"]["items"]
        items += got
        total = int(body["record"]["total"])
        print(f"  · {len(items)}/{total}")
        if len(items) >= total or not got:
            break
        page += 1

    gu: dict[str, dict] = {}
    for it in items:
        code = str(it["id"])
        title = it["title"]                      # "서울특별시 동대문구 제기동"
        parts = title.split()
        if len(parts) < 3 or len(code) < 8:
            continue
        gu_name, dong_name = parts[1], " ".join(parts[2:])
        g = gu.setdefault(code[:5], {"name": gu_name, "dong": []})
        g["dong"].append({
            "code": code, "name": dong_name,
            "lon": round(float(it["point"]["x"]), 6),
            "lat": round(float(it["point"]["y"]), 6),
        })

    for g in gu.values():
        g["dong"].sort(key=lambda d: d["name"])
    return {"sido": sido,
            "gu": dict(sorted(gu.items(), key=lambda kv: kv[1]["name"]))}


def main():
    p = argparse.ArgumentParser(description="서울 구·법정동 목록 생성")
    p.add_argument("--refresh", action="store_true", help="이미 있어도 다시 받는다")
    args = p.parse_args()

    if os.path.exists(OUT) and not args.refresh:
        with open(OUT, encoding="utf-8") as f:
            data = json.load(f)
        print(f"이미 있습니다: {OUT}  (구 {len(data['gu'])}개)")
        return

    key, _ = load_key(ENV_PATH)
    print("서울 법정동 목록을 받는 중…")
    data = fetch(key)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    n = sum(len(g["dong"]) for g in data["gu"].values())
    print(f"\n저장: {OUT}")
    print(f"  구 {len(data['gu'])}개 · 법정동 {n}개")


if __name__ == "__main__":
    main()
