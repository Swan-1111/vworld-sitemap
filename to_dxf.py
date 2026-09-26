"""수집한 GeoJSON을 CAD용 DXF로 변환한다. (Rhino / AutoCAD 바로 열림)

사용 예:
    python to_dxf.py                                   # 전체 사이트맵
    python to_dxf.py --preview                         # 확인용 PNG도 같이 생성
    python to_dxf.py --select 1123010200109880000      # 부지 확정 후 해당 필지 강조
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

import ezdxf
from ezdxf.enums import TextEntityAlignment
from shapely.geometry import box, shape
from shapely.ops import transform as shapely_transform, unary_union

from common import load_config, resolve_site, site_frame

LEDGER_FIELDS = (
    "jimok", "건물동수", "대장건수",
    "bld_nm", "main_purps", "strct", "roof", "use_apr_year",
    "grnd_flr_cnt", "tot_area", "bc_rat", "vl_rat",
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def parse_args():
    p = argparse.ArgumentParser(description="③ GeoJSON → DXF 변환")
    p.add_argument("--name", help="대상지 이름(out/ 아래 폴더명)")
    p.add_argument("--config")
    p.add_argument("--out", default=None, help="출력 DXF 경로")
    p.add_argument("--select", nargs="*", help="DESIGN AREA 로 쓸 필지의 PNU 목록 (V-DESIGN-AREA 레이어로 강조)")
    p.add_argument("--only-selected", action="store_true",
                   help="DESIGN AREA 와 그 위의 건물만 담은 DXF를 만든다")
    p.add_argument("--margin", type=float, default=30.0,
                   help="--only-selected 일 때 주변을 함께 담을 여유(m). 기본 30")
    p.add_argument("--layers", nargs="*",
                   help="담을 레이어만 고른다: parcel bldg road zone district planroad")
    p.add_argument("--clip-geojson",
                   help="이 GeoJSON 도형으로 자른다 (내보내기 범위를 따로 지정할 때)")
    p.add_argument("--no-crop", action="store_true",
                   help="아무 경계로도 자르지 않고 객체를 통째로 남긴다")
    p.add_argument("--crop-context", action="store_true",
                   help="PROJECT SITE 경계를 무시하고 CONTEXT 수집범위로 자른다")
    p.add_argument("--origin", choices=["center", "absolute"], help="config의 origin 설정을 덮어씀")
    p.add_argument("--preview", action="store_true", help="확인용 PNG 함께 생성")
    return p.parse_args()


# --------------------------------------------------------------------- 도형

def iter_rings(geom):
    """shapely 도형에서 (points, is_closed) 목록을 뽑는다."""
    kind = geom.geom_type
    if kind == "Polygon":
        yield list(geom.exterior.coords), True
        for ring in geom.interiors:
            yield list(ring.coords), True
    elif kind == "LineString":
        yield list(geom.coords), False
    elif kind == "LinearRing":
        yield list(geom.coords), True
    elif kind.startswith("Multi") or kind == "GeometryCollection":
        for part in geom.geoms:
            yield from iter_rings(part)
    elif kind == "Point":
        yield [(geom.x, geom.y)], False


def draw(msp, geom, layer: str):
    for points, closed in iter_rings(geom):
        if len(points) < 2:
            if points:
                msp.add_point(points[0], dxfattribs={"layer": layer})
            continue
        msp.add_lwpolyline(points, dxfattribs={"layer": layer, "closed": closed})


def load_ledger(db_path: str) -> dict[str, dict]:
    """build_db.py가 만든 DB에서 PNU별 대장 대표 1건을 읽는다. 없으면 빈 dict."""
    if not os.path.exists(db_path):
        return {}
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT pnu, " + ", ".join(f'"{f}"' for f in LEDGER_FIELDS)
            + " FROM parcel_full WHERE pnu IS NOT NULL"
        ).fetchall()
    except sqlite3.Error:
        return {}
    finally:
        con.close()
    return {r["pnu"]: dict(r) for r in rows if r["strct"] or r["use_apr_year"]}


def feature_pnu(props: dict) -> str | None:
    """필지는 pnu, 건물은 건물관리번호 앞 19자리."""
    pnu = props.get("pnu")
    if pnu:
        return str(pnu)
    sn = str(props.get("bd_mgt_sn") or "")
    return sn[:19] if len(sn) >= 19 else None


# 대장 구조명 → 도면에 쓰는 약어
STRUCT_ABBR = {
    "목구조": "목조", "통나무구조": "목조",
    "철근콘크리트구조": "RC", "철골철근콘크리트구조": "SRC",
    "철골구조": "S", "경량철골구조": "경량S",
    "벽돌구조": "조적", "블록구조": "조적", "석구조": "석조",
    "일반목구조": "목조", "기타구조": "기타",
}


def abbr_struct(name: str | None) -> str:
    if not name:
        return ""
    return STRUCT_ABBR.get(name.strip(), name.strip().replace("구조", ""))


def label_text(props: dict, layer_cfg: dict) -> str:
    field = layer_cfg.get("label_field")
    if not field:
        return ""
    value = props.get(field)
    if value in (None, "", "0"):
        return ""
    return f"{value}{layer_cfg.get('label_suffix', '')}"


# ---------------------------------------------------------------------- 본체

def main(name: str | None = None):
    args = parse_args()
    cfg = load_config(args.config)
    site = resolve_site(name or args.name)

    manifest = site.read_manifest()
    if manifest is None:
        print(f"'{site.name}' 수집 데이터가 없습니다. 먼저 fetch_site.py 를 실행하세요.", file=sys.stderr)
        sys.exit(1)
    print(f"[대상지] {site.name}")

    # 좌표 기준은 common 이 정한다 — 장면·사진·지형과 같은 원점이어야 겹쳐진다
    frame = site_frame(site, cfg, args.origin)
    target_crs = frame.crs
    to_target = frame.to_target
    print(f"[좌표계] {target_crs}  ({frame.crs_label})")
    text_h = cfg.get("text_height_m", 0.9)
    selected = set(args.select or [])

    # 수집범위를 목표 좌표계 사각형으로. 용도지역·도로는 범위에 걸치기만 해도
    # 도형 전체(구 단위)가 오므로 이걸로 잘라내야 도면 범위가 터지지 않는다.
    clip_box = box(*frame.box)

    # PROJECT SITE 경계 — 지도에서 그린 것이나 법정동 경계가 있으면 그걸 쓰고,
    # 없으면 CONTEXT 수집범위 사각형.
    # 이 경계로 모든 객체를 잘라내면 잘린 자리가 경계선으로 막혀 닫힌 도형이 된다.
    crop_shape, crop_kind = clip_box, "CONTEXT 수집범위"
    if args.crop_context:
        # 「01 CONTEXT 수집 범위 전체」로 내보낼 때. 그려 둔 PROJECT SITE 경계가 있어도
        # 그건 쓰지 않고, 수집범위 사각형 밖으로 나가는 선을 여기서 잘라 낸다.
        # 용도지역·지구단위계획은 동 전체 도형이 통째로 오므로 안 자르면 지면 밖까지 뻗는다.
        pass
    elif args.clip_geojson and os.path.exists(args.clip_geojson):
        # 내보내기용으로 따로 지정한 범위. PROJECT SITE 경계보다 우선한다.
        with open(args.clip_geojson, encoding="utf-8") as f:
            gj = json.load(f)
        g = shape(gj["features"][0]["geometry"] if gj.get("features") else gj["geometry"])
        g = shapely_transform(to_target, g)
        if g.is_valid and not g.is_empty:
            crop_shape, crop_kind = g, "내보내기 지정 범위"
    elif os.path.exists(site.boundary):
        try:
            with open(site.boundary, encoding="utf-8") as f:
                bd = json.load(f)
            g = shape(bd["features"][0]["geometry"] if bd.get("features") else bd["geometry"])
            g = shapely_transform(to_target, g)
            if g.is_valid and not g.is_empty:
                crop_shape, crop_kind = g, "PROJECT SITE 경계"
        except Exception as e:
            print(f"  ! 구역경계를 읽지 못해 수집범위로 자릅니다: {e}")

    crop_on = cfg.get("crop_to_boundary", True) and not args.no_crop
    print(f"[자르기] {'켬 — ' + crop_kind if crop_on else '끔'}")

    # 1) 모든 레이어를 목표 좌표계로 변환하며 메모리에 적재
    # 내보내기 창에서 고른 것만 담는다
    KEY = {"LP_PA_CBND_BUBUN": "parcel", "LT_C_SPBD": "bldg", "LT_L_SPRD": "road",
           "LT_C_UQ111": "zone", "LT_C_UPISUQ161": "district", "LT_C_UPISUQ151": "planroad"}
    want = set(args.layers) if args.layers else None

    loaded = []  # (layer_cfg, [(shapely_geom, props), ...])
    for layer_cfg in cfg["layers"]:
        if want is not None and KEY.get(layer_cfg["data_id"]) not in want:
            continue
        path = site.geojson(layer_cfg["data_id"])
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            fc = json.load(f)
        # crop_to_boundary 가 켜져 있으면 레이어 구분 없이 경계로 자른다.
        # 면적 같은 속성값은 DB(자르기 전 도형)에서 오므로 영향받지 않는다.
        do_clip = crop_on or layer_cfg.get("clip", False)
        items, clipped = [], 0
        for feat in fc["features"]:
            if not feat.get("geometry"):
                continue
            geom = shapely_transform(to_target, shape(feat["geometry"]))
            if do_clip and not crop_shape.contains(geom):
                geom = geom.intersection(crop_shape)
                if geom.is_empty:
                    continue
                clipped += 1
            items.append((geom, feat.get("properties") or {}))
        loaded.append((layer_cfg, items))
        note = f" (경계로 잘라냄 {clipped}건)" if clipped else ""
        print(f"[{layer_cfg['name']}] {len(items)}건 변환{note}")

    if not any(items for _, items in loaded):
        print("변환할 도형이 없습니다.", file=sys.stderr)
        sys.exit(1)

    # 2) 원점 결정 — 실좌표는 20만/55만 단위라 CAD에서 다루기 불편하므로 기본은 중심 이동
    # 1-b) --only-selected: 고른 부지만 남기고 나머지를 걷어낸다
    if args.only_selected:
        if not selected:
            print("--only-selected 를 쓰려면 --select 로 필지를 지정해야 합니다.", file=sys.stderr)
            sys.exit(1)

        chosen = [g for cfg_, items in loaded if cfg_["data_id"] == "LP_PA_CBND_BUBUN"
                  for g, pr in items if str(pr.get("pnu") or "") in selected]
        if not chosen:
            print("선택한 PNU에 해당하는 필지를 찾지 못했습니다.", file=sys.stderr)
            sys.exit(1)

        xs = [v for g in chosen for v in (g.bounds[0], g.bounds[2])]
        ys = [v for g in chosen for v in (g.bounds[1], g.bounds[3])]
        m = args.margin
        # 자를 때만 쓰는 상자다. clip_box 를 덮어쓰면 아래 원점까지 따라 움직여,
        # 선택부지 DXF 와 전체 DXF 가 CAD 에서 겹치지 않게 된다.
        sel_box = box(min(xs) - m, min(ys) - m, max(xs) + m, max(ys) + m)
        site_area = unary_union(chosen)

        trimmed = []
        for layer_cfg, items in loaded:
            data_id = layer_cfg["data_id"]
            if data_id == "LP_PA_CBND_BUBUN":
                kept = [(g, pr) for g, pr in items if (feature_pnu(pr) or "") in selected]
            elif data_id == "LT_C_SPBD":
                # 건물은 PNU가 아니라 **실제로 부지 위에 있는지**로 고른다.
                # 한 건물이 여러 필지에 걸치거나 옆 필지 번호로 등록된 경우가 흔해서,
                # PNU로만 고르면 부지 위의 건물이 빠지고 엉뚱한 건물이 딸려온다.
                kept = [(g, pr) for g, pr in items
                        if g.intersects(site_area) and g.intersection(site_area).area > 0.5]
            else:
                # 도로·용도지역은 주변 맥락으로 남기되 범위에 맞춰 자른다
                kept = []
                for g, pr in items:
                    piece = g if sel_box.contains(g) else g.intersection(sel_box)
                    if not piece.is_empty:
                        kept.append((piece, pr))
            trimmed.append((layer_cfg, kept))
            print(f"  · {layer_cfg['name']} {len(items)} → {len(kept)}건")
        loaded = trimmed

    # 원점은 대상지마다 하나다. 무엇을 골랐든 같은 값이어야 전체 도면·선택부지·
    # 지형·장면이 CAD 에서 그대로 겹친다. 예전에는 선택부지일 때 고른 필지의
    # 가운데로 옮겨져, 두 DXF 가 어긋나고 좌표기준.txt 도 나중 것으로 덮였다.
    ox, oy = frame.ox, frame.oy

    def shift(x, y, z=None):
        return (x - ox, y - oy)

    # 3) DXF 작성
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 6  # meters
    msp = doc.modelspace()

    def ensure_layer(name, color):
        if name not in doc.layers:
            doc.layers.add(name, color=color)

    ensure_layer("V-DESIGN-AREA", 1)

    # 01 CONTEXT — 실제 요청한 광역 수집범위
    ensure_layer("V-CONTEXT", 250)
    draw(msp, shapely_transform(shift, clip_box), "V-CONTEXT")

    # 02 PROJECT SITE — 자르기 기준이 된 대상지 경계. 잘린 객체들이 이 선에 물려 닫힌다
    if crop_on and crop_shape is not clip_box:
        ensure_layer("V-PROJECT-SITE", 6)
        draw(msp, shapely_transform(shift, crop_shape), "V-PROJECT-SITE")

    ledger = load_ledger(site.db)
    if ledger:
        print(f"[대장] {len(ledger)}필지 속성 결합")
    else:
        print("[대장] 없음 — 공간정보만으로 출력합니다. (python build_db.py 실행 시 결합)")

    parcel_rows = []
    selected_area = 0.0

    for layer_cfg, items in loaded:
        ensure_layer(layer_cfg["dxf_layer"], layer_cfg.get("color", 7))
        label_layer = layer_cfg.get("label_layer")
        if label_layer:
            ensure_layer(label_layer, layer_cfg.get("label_color", 8))

        is_bldg = layer_cfg["data_id"] == "LT_C_SPBD"

        for geom, props in items:
            local = shapely_transform(shift, geom)
            pnu = feature_pnu(props)
            is_selected = bool(pnu) and pnu in selected
            info = ledger.get(pnu) if pnu else None

            # 03 DESIGN AREA 는 대지 경계 전용. 그 위의 건물은 원래 레이어에 남겨야 도면에서 쓸 수 있다.
            target_layer = ("V-DESIGN-AREA" if is_selected and layer_cfg["data_id"] == "LP_PA_CBND_BUBUN"
                            else layer_cfg["dxf_layer"])
            draw(msp, local, target_layer)

            text = label_text(props, layer_cfg)
            if is_bldg and info:
                # 대장이 있으면 층수 대신 "층수F 승인연도 구조"로 더 유용하게
                bits = [f"{info['grnd_flr_cnt']}F" if info["grnd_flr_cnt"] else text,
                        str(info["use_apr_year"]) if info["use_apr_year"] else "",
                        abbr_struct(info["strct"])]
                text = " ".join(b for b in bits if b)
            if text and label_layer:
                point = local.representative_point()
                msp.add_text(
                    text, height=text_h, dxfattribs={"layer": label_layer}
                ).set_placement((point.x, point.y), align=TextEntityAlignment.MIDDLE_CENTER)

            # 필지 목록 — 부지 후보를 면적순으로 고르기 위한 표
            if layer_cfg["data_id"] == "LP_PA_CBND_BUBUN":
                area = geom.area  # 투영좌표계라 m² 단위
                if is_selected:
                    selected_area += area
                center = local.representative_point()
                row = {
                    "pnu": pnu or "",
                    "지번": props.get("jibun", ""),
                    "주소": props.get("addr", ""),
                    "면적_m2": round(area, 1),
                    "면적_평": round(area / 3.305785, 1),
                    "공시지가": props.get("jiga", ""),
                }
                if ledger:
                    row.update({
                        "지목": (info or {}).get("jimok", "") or "",
                        "건물동수": (info or {}).get("건물동수", "") or "",
                        "대장건수": (info or {}).get("대장건수", "") or "",
                        "주용도": (info or {}).get("main_purps", "") or "",
                        "구조": (info or {}).get("strct", "") or "",
                        "지붕": (info or {}).get("roof", "") or "",
                        "사용승인": (info or {}).get("use_apr_year", "") or "",
                        "지상층수": (info or {}).get("grnd_flr_cnt", "") or "",
                        "연면적": (info or {}).get("tot_area", "") or "",
                        "건폐율": (info or {}).get("bc_rat", "") or "",
                        "용적률": (info or {}).get("vl_rat", "") or "",
                    })
                row.update({
                    "선택": "O" if is_selected else "",
                    "도면X": round(center.x, 2),
                    "도면Y": round(center.y, 2),
                })
                parcel_rows.append(row)

    out_path = args.out or (site.dxf_selected if args.only_selected else site.dxf)
    doc.saveas(out_path)
    print(f"\n[DXF] {out_path}")

    # 선택 필지 합계만 알린다 (필지목록 CSV 는 쓰지 않는다 — 쓰이지 않아 걷어냄)
    if selected and parcel_rows:
        print(f"[DESIGN AREA] {len(selected)}필지 · 합계 {selected_area:,.1f}m² "
              f"({selected_area / 3.305785:,.1f}평)")

    # 5) 좌표 기준 기록 — 나중에 실좌표로 되돌리거나 다른 자료와 합칠 때 필요
    ref_path = site.ref
    with open(ref_path, "w", encoding="utf-8") as f:
        f.write(
            f"대상지: {site.name}\n"
            f"검색주소: {manifest.get('resolved_by', {}).get('address', '-')}\n"
            f"좌표계: {target_crs}\n"
            f"원점방식: {args.origin or cfg.get('origin', 'center')}\n"
            f"DXF 원점(0,0)의 실좌표: X={ox}, Y={oy}\n"
            f"  → 실좌표 = 도면좌표 + 위 값\n"
            f"단위: meter\n"
            f"수집 범위(EPSG:4326): {manifest['bbox_4326']}\n"
        )
    print(f"[좌표기준] {ref_path}")

    if args.preview:
        make_preview(loaded, shift, selected, ledger, site.preview)
    return site


def make_preview(loaded, shift, selected, ledger, path):
    """CAD를 열기 전에 형태를 확인하기 위한 간단한 도판."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    style = {
        "LP_PA_CBND_BUBUN": {"ec": "#9aa0a6", "fc": "none", "lw": 0.35, "z": 1},
        "LT_C_SPBD": {"ec": "#2f6f4e", "fc": "#cfe6d8", "lw": 0.4, "z": 3},
        "LT_L_SPRD": {"ec": "#8ab4f8", "fc": "none", "lw": 0.5, "z": 2},
        "LT_C_UQ111": {"ec": "#e06666", "fc": "none", "lw": 0.6, "z": 0},
    }
    fig, ax = plt.subplots(figsize=(11, 11), dpi=200)
    for layer_cfg, items in loaded:
        s = style.get(layer_cfg["data_id"], {"ec": "#666", "fc": "none", "lw": 0.3, "z": 1})
        for geom, props in items:
            local = shapely_transform(shift, geom)
            pnu = feature_pnu(props)
            hit = bool(pnu) and pnu in selected and layer_cfg["data_id"] == "LP_PA_CBND_BUBUN"
            if s["fc"] != "none":
                # 외곽은 채우고 구멍(중정)은 배경색으로 다시 덮는다
                for poly in getattr(local, "geoms", [local]):
                    if poly.geom_type != "Polygon":
                        continue
                    ax.fill(*zip(*poly.exterior.coords), color=s["fc"], zorder=s["z"])
                    for ring in poly.interiors:
                        ax.fill(*zip(*ring.coords), color="white", zorder=s["z"] + 0.1)
            for points, closed in iter_rings(local):
                if len(points) < 2:
                    continue
                x, y = zip(*points)
                ax.plot(
                    x, y,
                    color="#d93025" if hit else s["ec"],
                    lw=1.6 if hit else s["lw"],
                    zorder=9 if hit else s["z"],
                )
    ax.set_aspect("equal")
    ax.axis("off")
    fig.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"[미리보기] {path}")


if __name__ == "__main__":
    main()
