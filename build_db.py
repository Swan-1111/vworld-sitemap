"""수집한 공간정보와 건축물대장을 PNU로 조인해 SQLite DB를 만든다.

    지적도(V-World)  parcel.pnu ─┐
    건물(V-World)  building.pnu ─┼─ PNU 19자리로 조인 ─→ parcel_full
    건축물대장       ledger.pnu ─┘

사용 예:
    python build_db.py                 # 지적+건물+대장 전부
    python build_db.py --no-ledger     # 대장 없이 공간정보만 (키 없을 때)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys

from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform as shapely_transform
from shapely.strtree import STRtree

import ledger as ledger_mod
from common import ENV_PATH, load_config, progress, resolve_crs, resolve_site

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SCHEMA = """
DROP TABLE IF EXISTS parcel;
DROP TABLE IF EXISTS building;
DROP TABLE IF EXISTS ledger;

CREATE TABLE parcel (
    pnu         TEXT PRIMARY KEY,
    jibun       TEXT,
    jimok       TEXT,          -- 지번 끝의 지목 표기: 대(대지) 도(도로) 전 답 임 ...
    addr        TEXT,
    area_m2     REAL,
    jiga        INTEGER,
    zone        TEXT,          -- 용도지역 (공간 겹침으로 판정)
    district    TEXT,          -- 지구단위계획구역 (공간 겹침으로 판정)
    geom_wkt    TEXT
);

CREATE TABLE building (
    bd_mgt_sn   TEXT PRIMARY KEY,
    pnu         TEXT,          -- 건물관리번호 25자리의 앞 19자리
    buld_nm     TEXT,
    gro_flo_co  INTEGER,       -- 도로명주소 기준 지상층수
    area_m2     REAL,          -- 건축면적(도형 기준)
    geom_wkt    TEXT
);
CREATE INDEX idx_building_pnu ON building(pnu);

CREATE TABLE ledger (
    mgm_pk        TEXT PRIMARY KEY,
    pnu           TEXT,
    bld_nm        TEXT,
    dong_nm       TEXT,
    main_purps    TEXT,        -- 주용도
    strct         TEXT,        -- 구조
    roof          TEXT,        -- 지붕
    use_apr_day   TEXT,        -- 사용승인일 YYYYMMDD
    use_apr_year  INTEGER,
    grnd_flr_cnt  INTEGER,
    ugrnd_flr_cnt INTEGER,
    height        REAL,
    plat_area     REAL,        -- 대지면적
    arch_area     REAL,        -- 건축면적
    tot_area      REAL,        -- 연면적
    bc_rat        REAL,        -- 건폐율
    vl_rat        REAL,        -- 용적률
    main_atch_gb  TEXT         -- 주/부속 구분
);
CREATE INDEX idx_ledger_pnu ON ledger(pnu);
"""

VIEWS = """
DROP VIEW IF EXISTS parcel_full;

-- 필지 한 줄에 그 필지의 건물·대장 요약을 붙인 조인 뷰
CREATE VIEW parcel_full AS
SELECT
    p.pnu, p.jibun, p.jimok, p.addr, p.zone, p.district,
    ROUND(p.area_m2, 1)            AS 필지면적_m2,
    ROUND(p.area_m2 / 3.305785, 1) AS 필지면적_평,
    p.jiga,
    (SELECT COUNT(*) FROM building b WHERE b.pnu = p.pnu)      AS 건물동수,
    (SELECT COUNT(*) FROM ledger  l WHERE l.pnu = p.pnu)       AS 대장건수,
    l.bld_nm, l.main_purps, l.strct, l.roof,
    l.use_apr_year, l.grnd_flr_cnt, l.tot_area, l.bc_rat, l.vl_rat
FROM parcel p
LEFT JOIN ledger l
       ON l.pnu = p.pnu
      AND l.mgm_pk = (          -- 한 필지에 여러 동이면 주건축물 중 연면적이 가장 큰 동을 대표로
            SELECT l2.mgm_pk FROM ledger l2 WHERE l2.pnu = p.pnu
            ORDER BY (l2.main_atch_gb = '주건축물') DESC,
                     COALESCE(l2.tot_area, 0) DESC LIMIT 1);
"""


def parse_args():
    p = argparse.ArgumentParser(description="② 공간정보 + 건축물대장 조인 DB 구축")
    p.add_argument("--name", help="대상지 이름(out/ 아래 폴더명)")
    p.add_argument("--config")
    p.add_argument("--no-ledger", action="store_true", help="건축물대장 조회를 건너뜀")
    p.add_argument("--refresh-ledger", action="store_true", help="캐시를 무시하고 대장을 다시 받음")
    return p.parse_args()


def fetch_dong_cached(api, site, sigungu: str, bjdong: str, refresh: bool, on_progress):
    """법정동 대장을 캐시해 둔다. 개발계정 트래픽이 하루 1,000건이라 재실행 비용이 크다."""
    path = os.path.join(site.geojson_dir, f"_ledger_{sigungu}{bjdong}.json")
    if os.path.exists(path) and not refresh:
        with open(path, encoding="utf-8") as f:
            items = json.load(f)
        print(f"  · {sigungu}-{bjdong}  {len(items)}건 (캐시)")
        return items

    part = os.path.join(site.geojson_dir, f"_ledger_{sigungu}{bjdong}.part.json")

    initial, start_page = [], 1
    if os.path.exists(part) and not refresh:
        with open(part, encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            initial = saved.get("items") or []
            start_page = int(saved.get("next_page") or 1)
        elif isinstance(saved, list):
            # 예전 부분 캐시는 목록만 저장했다. 공공데이터 API가 실제로 돌려주는
            # 페이지당 100건을 기준으로 다음 페이지를 복원한다.
            initial = saved
            start_page = len(initial) // 100 + 1
        if initial:
            print(f"  · {sigungu}-{bjdong}  {len(initial)}건부터 이어받기 (페이지 {start_page})")

    def keep_partial(items, next_page):
        with open(part, "w", encoding="utf-8") as f:
            json.dump({"items": items, "next_page": next_page}, f, ensure_ascii=False)

    items = api.fetch_dong(sigungu, bjdong, on_progress=on_progress,
                           on_partial=keep_partial, initial_items=initial,
                           start_page=start_page)
    print()
    if os.path.exists(part):
        os.remove(part)                    # 온전히 받았으면 조각은 지운다
    with open(path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    return items


def load_partial(site, sigungu: str, bjdong: str) -> list[dict]:
    """받다 만 대장이 남아 있으면 그거라도 쓴다."""
    path = os.path.join(site.geojson_dir, f"_ledger_{sigungu}{bjdong}.part.json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        saved = json.load(f)
    return saved.get("items", []) if isinstance(saved, dict) else saved


def load_geojson(site, data_id: str) -> list[dict]:
    path = site.geojson(data_id)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)["features"]


def parse_jimok(jibun: str | None) -> str | None:
    """'988-1대' → '대',  '65도' → '도',  '20-66 대' → '대'.

    연속지적도의 jibun은 '지번 + 지목' 형태로 온다. 지목을 떼어놔야 도로·구거 필지가
    면적만 크고 부지 후보 위로 올라오는 걸 막을 수 있다.
    """
    if not jibun:
        return None
    m = re.search(r"([가-힣]+)\s*$", str(jibun))
    return m.group(1) if m else None


def show_distribution(con, top: int = 6):
    """대상지에 뭐가 있는지 훑어보는 요약. 필터 조건을 잡는 출발점으로 쓴다."""
    def bars(title, sql, limit=None, fmt=str):
        rows = con.execute(sql).fetchall()
        rows = [r for r in rows if r[0] not in (None, "")]
        if not rows:
            return
        limit = limit or top
        total = sum(r[1] for r in rows)
        print(f"\n  {title}")
        for label, n in rows[:limit]:
            share = n / total
            # 한글은 터미널에서 두 칸을 먹으므로 그만큼 폭을 빼서 열을 맞춘다
            label = fmt(label)
            wide = sum(1 for ch in label if ord(ch) > 0x2E7F)
            print(f"    {label:<{14 - wide}} {n:>5}  {'█' * round(share * 24)} {share * 100:4.1f}%")
        if len(rows) > limit:
            rest = f"그 외 {len(rows) - limit}종"
            wide = sum(1 for ch in rest if ord(ch) > 0x2E7F)
            print(f"    {rest:<{14 - wide}} {sum(r[1] for r in rows[limit:]):>5}")

    bars("지목", "SELECT jimok, COUNT(*) FROM parcel GROUP BY jimok ORDER BY 2 DESC")
    bars("구조", "SELECT strct, COUNT(*) FROM ledger GROUP BY strct ORDER BY 2 DESC")
    bars("주용도", "SELECT main_purps, COUNT(*) FROM ledger GROUP BY main_purps ORDER BY 2 DESC")
    bars("사용승인 연대",
         "SELECT (use_apr_year/10)*10, COUNT(*) FROM ledger "
         "WHERE use_apr_year BETWEEN 1900 AND 2100 GROUP BY 1 ORDER BY 1",
         limit=20, fmt=lambda v: f"{v}년대")

    row = con.execute(
        "SELECT COUNT(*), ROUND(MIN(area_m2)), ROUND(AVG(area_m2)), ROUND(MAX(area_m2)) "
        "FROM parcel WHERE jimok = '대'"
    ).fetchone()
    if row and row[0]:
        print(f"\n  대지 필지 {row[0]}개 · 면적 최소 {row[1]:.0f} / 평균 {row[2]:.0f} / 최대 {row[3]:.0f} m²")


def to_int(value):
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def to_float(value):
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def main(name: str | None = None, no_ledger: bool = False):
    args = parse_args()
    cfg = load_config(args.config)
    site = resolve_site(name or args.name)
    no_ledger = no_ledger or args.no_ledger

    if not site.exists():
        print(f"'{site.name}' 수집 데이터가 없습니다. 먼저 fetch_site.py 를 실행하세요.", file=sys.stderr)
        sys.exit(1)
    target_crs, crs_label = resolve_crs(cfg, site.read_manifest())
    print(f"[대상지] {site.name}   [좌표계] {target_crs} ({crs_label})")

    to_target = Transformer.from_crs("EPSG:4326", target_crs, always_xy=True).transform

    con = sqlite3.connect(site.db)
    con.executescript(SCHEMA)

    # ---------------------------------------------------------------- 지적도
    parcels = load_geojson(site, "LP_PA_CBND_BUBUN")
    rows, parcel_geoms = [], []
    for feat in parcels:
        props = feat.get("properties") or {}
        pnu = str(props.get("pnu") or "").strip()
        if not pnu or not feat.get("geometry"):
            continue
        geom = shapely_transform(to_target, shape(feat["geometry"]))
        jibun = props.get("jibun")
        rows.append([pnu, jibun, parse_jimok(jibun), props.get("addr"),
                     geom.area, to_int(props.get("jiga")), None, None, geom.wkt])
        parcel_geoms.append(geom)

    # 용도지역·지구단위계획은 필지와 열쇠가 없다. 도형이 겹치는지로 붙인다.
    for idx, (data_id, field) in enumerate([("LT_C_UQ111", "uname"),
                                            ("LT_C_UPISUQ161", "dgm_nm")]):
        zones = []
        for feat in load_geojson(site, data_id):
            if not feat.get("geometry"):
                continue
            g = shapely_transform(to_target, shape(feat["geometry"]))
            if g.is_valid and not g.is_empty:
                zones.append((g, (feat.get("properties") or {}).get(field)))
        if not zones:
            continue
        tree = STRtree([g for g, _ in zones])
        hit = 0
        for i, geom in enumerate(parcel_geoms):
            best, best_area = None, 0.0
            for j in tree.query(geom):
                a = zones[j][0].intersection(geom).area
                if a > best_area:          # 여러 구역에 걸치면 가장 많이 겹치는 쪽
                    best, best_area = zones[j][1], a
            if best and best_area > geom.area * 0.1:
                rows[i][6 + idx] = best
                hit += 1
        label = "용도지역" if idx == 0 else "지구단위계획구역"
        print(f"           {label} {hit}/{len(rows)}필지 판정 ({len(zones)}개 구역)")

    con.executemany("INSERT OR REPLACE INTO parcel VALUES (?,?,?,?,?,?,?,?,?)", rows)
    print(f"[parcel]   {len(rows):>5}건")

    # ----------------------------------------------------------------- 건물
    buildings = load_geojson(site, "LT_C_SPBD")
    rows = []
    for feat in buildings:
        props = feat.get("properties") or {}
        sn = str(props.get("bd_mgt_sn") or "").strip()
        if not sn or not feat.get("geometry"):
            continue
        geom = shapely_transform(to_target, shape(feat["geometry"]))
        rows.append((sn, sn[:19] if len(sn) >= 19 else None, props.get("buld_nm"),
                     to_int(props.get("gro_flo_co")), geom.area, geom.wkt))
    con.executemany("INSERT OR REPLACE INTO building VALUES (?,?,?,?,?,?)", rows)
    print(f"[building] {len(rows):>5}건")

    # ------------------------------------------------------------ 건축물대장
    if not no_ledger:
        dongs = sorted({
            (r[0][:5], r[0][5:10])
            for r in con.execute("SELECT pnu FROM parcel")
            if len(r[0]) == 19
        })
        print(f"[ledger]   법정동 {len(dongs)}개 조회: " +
              ", ".join(f"{a}-{b}" for a, b in dongs))

        try:
            key, endpoint = ledger_mod.load_key(ENV_PATH)
            api = ledger_mod.Ledger(key, endpoint)
        except ledger_mod.LedgerError as e:
            print(f"  !! {e}")
            print("     대장 없이 공간정보만으로 진행합니다.")
            api = None
            dongs = []

        rows, seen, failed = [], set(), []
        n_dong = max(len(dongs), 1)
        for di, (sigungu, bjdong) in enumerate(dongs):
            def on_page(got, total, _s=sigungu, _b=bjdong, _i=di):
                print(f"\r  · {_s}-{_b}  {got}/{total}", end="", flush=True)
                progress((_i + got / max(total, 1)) / n_dong * 100)

            # 한 법정동이 실패해도 나머지와 뒤 단계는 살린다.
            # 대장은 부가 정보이고, 도면·지형은 공간정보만으로도 나온다.
            try:
                items = fetch_dong_cached(api, site, sigungu, bjdong,
                                          args.refresh_ledger, on_page)
            except ledger_mod.LedgerError as e:
                print()
                print(f"  !! {sigungu}-{bjdong} 대장을 받지 못했습니다 — {e}")
                items = load_partial(site, sigungu, bjdong)
                if items:
                    print(f"  · 받아둔 {len(items)}건만 씁니다.")
                failed.append(f"{sigungu}-{bjdong}")
            for item in items:
                pk = str(item.get("mgmBldrgstPk") or "").strip()
                pnu = ledger_mod.make_pnu(item)
                if not pk or pk in seen:
                    continue
                seen.add(pk)

                strct = item.get("strctCdNm") or item.get("etcStrct")
                roof = item.get("roofCdNm") or item.get("etcRoof")
                apr = str(item.get("useAprDay") or "").strip()
                grnd = to_int(item.get("grndFlrCnt"))

                rows.append((
                    pk, pnu, item.get("bldNm"), item.get("dongNm"),
                    item.get("mainPurpsCdNm"), strct, roof,
                    apr or None, to_int(apr[:4]) if len(apr) >= 4 else None,
                    grnd, to_int(item.get("ugrndFlrCnt")), to_float(item.get("heit")),
                    to_float(item.get("platArea")), to_float(item.get("archArea")),
                    to_float(item.get("totArea")), to_float(item.get("bcRat")),
                    to_float(item.get("vlRat")), item.get("mainAtchGbCdNm"),
                ))
        con.executemany(
            "INSERT OR REPLACE INTO ledger VALUES (" + ",".join(["?"] * 18) + ")", rows
        )
        print(f"[ledger]   {len(rows):>5}건")
        if failed:
            print(f"[ledger]   받지 못한 법정동 {len(failed)}개: {', '.join(failed)}")
            print("           도면·지형은 정상입니다. 대장 속성만 그 동네에서 빕니다.")
            print(f"           나중에 다시:  python build_db.py --name {site.name}")

    con.executescript(VIEWS)
    con.commit()

    # ------------------------------------------------------------- 조인 결과
    def one(sql):
        return con.execute(sql).fetchone()[0]

    n_parcel = one("SELECT COUNT(*) FROM parcel")
    n_bldg = one("SELECT COUNT(*) FROM building")
    n_ledger = one("SELECT COUNT(*) FROM ledger")
    print("\n" + "─" * 52)
    print("조인 결과")
    if n_bldg:
        hit = one("SELECT COUNT(*) FROM building WHERE pnu IN (SELECT pnu FROM parcel)")
        print(f"  건물 → 필지   {hit}/{n_bldg}  ({hit / n_bldg * 100:.1f}%)")
    if n_ledger:
        hit = one("SELECT COUNT(*) FROM ledger WHERE pnu IN (SELECT pnu FROM parcel)")
        print(f"  대장 → 필지   {hit}/{n_ledger}  ({hit / n_ledger * 100:.1f}%)"
              "   ※ 대장은 법정동 전체를 받으므로 수집범위 밖이 섞인 게 정상")
        covered = one("SELECT COUNT(*) FROM parcel WHERE pnu IN (SELECT pnu FROM ledger)")
        print(f"  대장 있는 필지 {covered}/{n_parcel}  ({covered / n_parcel * 100:.1f}%)")

    print("─" * 52)
    show_distribution(con)
    print("─" * 52)
    print(f"\n[DB] {site.db}")
    print(f"다음 단계:  python to_dxf.py --name {site.name} --preview")
    con.close()
    return site


if __name__ == "__main__":
    try:
        main()
    except ledger_mod.LedgerError as e:
        print(f"\n오류: {e}", file=sys.stderr)
        sys.exit(1)
