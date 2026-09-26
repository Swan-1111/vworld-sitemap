"""돌아가는지 한 번에 확인한다.

    python selftest.py                  # 서버가 켜져 있어야 한다
    python selftest.py --site 제기동-954

고치기 전에 한 번, 고친 뒤에 한 번 돌려 값이 같은지 본다.
같은 값이 나오면 겉모습은 바뀌었어도 하는 일은 그대로라는 뜻이다.

브라우저까지 보려면 playwright 가 있어야 한다. 없으면 서버 쪽만 본다.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ.get("VWORLD_TEST_BASE", "http://127.0.0.1:8000")
FAILED: list[str] = []
MISSING = object()          # want=None 을 「값이 없어야 한다」와 구분하려고


def check(name: str, got, want=MISSING, *, atleast=None):
    """한 줄 확인. want 를 주면 같은지, atleast 를 주면 그 이상인지 본다."""
    ok = True
    if want is not MISSING:
        ok = got == want
    elif atleast is not None:
        ok = isinstance(got, (int, float)) and got >= atleast
    else:
        ok = bool(got)
    mark = "  ok " if ok else "  !! "
    tail = ("" if want is MISSING and atleast is None
            else f"  (기대 {want if want is not MISSING else '≥' + str(atleast)})")
    print(f"{mark}{name:38s} {got}{tail}")
    if not ok:
        FAILED.append(name)
    return ok


def get(path: str, timeout: int = 300):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return r.status, r.headers, r.read()


def get_json(path: str, timeout: int = 300):
    return json.loads(get(path, timeout)[2])


def post_json(path: str, body: dict | None = None, timeout: int = 300):
    raw = json.dumps(body or {}).encode("utf-8")
    request = urllib.request.Request(BASE + path, data=raw, method="POST",
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def q(name: str) -> str:
    return urllib.parse.quote(name)


# ────────────────────────────────────────────────── 서버
def server_checks(site: str):
    print("\n[서버]")
    b = get_json("/api/bootstrap")
    check("대상지 목록", len(b.get("sites") or []), atleast=1)
    check("브이월드 키", bool(b.get("vworld_key")))
    precision = get_json("/api/precision-roads")
    check("정밀도로 온디맨드 목록", len(precision.get("layers") or []), 9)
    road_catalog = get_json(f"/api/roads/status?site={q(site)}")
    check("도로 Polygon 카탈로그", len(road_catalog.get("datasets") or []), 2)
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "web", "index.html"), encoding="utf-8") as source:
        index_source = source.read()
    check("팝업 인라인 JavaScript 제거", 'onclick="toggle(' not in index_source, True)
    check("VWorld jQuery 전역과 앱 $ 격리",
          "const Q = s => document.querySelector(s);" in index_source and
          "const $ =" not in index_source and "$(" not in index_source, True)
    check("다이어그램 공유 전역 유지",
          'let KEY = "", MAP' in index_source and
          "function newAerialJobId()" in index_source and
          "function watchAerialProgress(" in index_source and
          "siteAnalysisApp" not in index_source, True)
    with open(os.path.join(here, "web", "diagram.js"), encoding="utf-8") as source:
        diagram_source = source.read()
    with open(os.path.join(here, "web", "render3d.js"), encoding="utf-8") as source:
        renderer_source = source.read()
    check("VWorld 별도 보기 UI 제거",
          'id="vworld3d"' not in index_source and
          "/vworld3d.js" not in index_source and
          "window.VW3D" not in diagram_source and
          "dgSetSource" not in diagram_source, True)
    check("VWorld 실물 매스 레이어 배치",
          'id:"renderMass"' in diagram_source and
          "실물 매핑" in diagram_source and
          "실물 그림자" not in diagram_source and
          "groundMapping:true" not in diagram_source and
          "shadows:true" not in diagram_source and
          "CONTEXT 범위" in diagram_source, True)
    check("3D 매핑 구조 단순화",
          index_source.count('data-render-mode=') == 2 and
          'data-render-mode="diagram"' in index_source and
          'data-render-mode="aerial"' in index_source and
          'id:"aerial"' not in diagram_source and
          "지형 위성사진 매핑" in diagram_source and
          'mass.mapping=mappingOn' in diagram_source and
          'ground.aerialMap=mappingOn' in diagram_source and
          'this._massMapping=layer.mapping!==false' in renderer_source and
          'state.renderMode==="aerial"&&layer.mapping' not in renderer_source, True)
    check("VWorld 실물 매스 그림자 재질",
          "_massMappedMaterial" in renderer_source and
          "diagramVWorldShadowReceiver" in renderer_source and
          "object.castShadow=massShadows" in renderer_source and
          "object.receiveShadow=massShadows" in renderer_source, True)
    check("VWorld 실물 매스 투명도",
          'title="실물 매스 투명도 %"' in diagram_source and
          'data-d3-layer-v="renderMass-op"' not in diagram_source and
          "_applyMassOpacity" in renderer_source and
          "diagramVWorldBaseOpacity" in renderer_source and
          "layer.op??100" in renderer_source, True)
    check("3D 레이어 드래그 우선순위",
          "function bindDGLayerDrag" in diagram_source and
          'data-id="renderMass" draggable="true"' in diagram_source and
          "layerRenderOrder" in renderer_source and
          "assignLayerOrder" in renderer_source, True)
    check("실물 매스 동일 장면 좌표 정합",
          'from "3d-tiles-renderer/three"' in renderer_source and
          "TG9ENA.json" in renderer_source and
          "ecefToLocalMatrix" in renderer_source, True)
    check("실물 매스 Draco 압축 지원",
          'DRACOLoader' in renderer_source and
          'KTX2Loader' in renderer_source and
          "DRACO_LOCAL" in renderer_source and
          "DRACO_CDN" in renderer_source and
          "KTX2_LOCAL" in renderer_source and
          "setKTX2Loader" in renderer_source and
          "_ensureMassDecoder" in renderer_source, True)
    check("실물 매스 CONTEXT 절단",
          "clippingPlanesFor" in renderer_source and
          "context_bounds" in renderer_source, True)
    check("실물 매스 CONTEXT 절단면 채움",
          "CONTEXT 절단면 채우기" in diagram_source and
          "_rebuildMassCaps" in renderer_source and
          "crossSectionCapGeometry" in renderer_source and
          "ShapeUtils.triangulateShape" in renderer_source, True)
    check("DESIGN AREA 개별 건물 제거·배치",
          "removedBuildings" in diagram_source and
          "data-d3-building-remove" in diagram_source and
          "dgOpenModelPlacement" in diagram_source, True)
    check("DESIGN AREA GLB·3DM 가져오기",
          "Rhino3dmLoader" in renderer_source and
          'accept=".glb,.3dm' in diagram_source and
          "buildingModelInfo" in renderer_source, True)
    check("실물 매스 DESIGN AREA 제외",
          "_updateMassDesignMask" in renderer_source and
          "_updateMassFeatureMask" in renderer_source and
          'getAttribute("_batchid")' in renderer_source and
          "vworldHide" in renderer_source and
          "customDepthMaterial" in renderer_source and
          "texture2D( vworldDesignMask" not in renderer_source and
          "건물 단위로 통째 제외" in diagram_source, True)
    check("실물 매스 첫 타일부터 DESIGN AREA 제외",
          renderer_source.index("this._updateMassDesignMask(data,selected,bounds);") <
          renderer_source.index("const tiles=new TilesRenderer(VWORLD_REAL_BUILDINGS);") and
          "tiles.group.visible=false" in renderer_source and
          "diagramVWorldPrepared=true" in renderer_source and
          "maskedUnclassifiedMeshes" in renderer_source, True)
    check("실물 매스 모델 내보내기 제외",
          "diagramExternalTiles" in renderer_source and
          "_updateMassTiles" in renderer_source, True)
    check("실물 매스 CONTEXT 고정 캐시",
          "_massLoadCameras" in renderer_source and
          "_trackMassCompletion" in renderer_source and
          "_massFrozen" in renderer_source and
          "_massLocked" in renderer_source and
          "!this._massLocked" in renderer_source and
          "CONTEXT 전체 로드 완료" in renderer_source, True)
    wasm_status, wasm_headers, wasm_bytes = get("/rhino3dm.wasm")
    check("Rhino WASM 응답", wasm_status, 200)
    check("Rhino WASM 형식", wasm_headers.get_content_type(), "application/wasm")
    check("Rhino WASM 크기", len(wasm_bytes), atleast=1_000_000)
    rhino_js_status, _, rhino_js_bytes = get("/rhino3dm.js")
    check("Rhino 3DM 로더 응답", rhino_js_status, 200)
    check("Rhino 3DM 로더 크기", len(rhino_js_bytes), atleast=100_000)
    draco_status, draco_headers, draco_bytes = get("/draco_decoder.wasm")
    check("Draco WASM 응답", draco_status, 200)
    check("Draco WASM 형식", draco_headers.get_content_type(), "application/wasm")
    check("Draco WASM 크기", len(draco_bytes), atleast=100_000)
    basis_status, basis_headers, basis_bytes = get("/basis_transcoder.wasm")
    check("KTX2 Basis WASM 응답", basis_status, 200)
    check("KTX2 Basis WASM 형식", basis_headers.get_content_type(), "application/wasm")
    check("KTX2 Basis WASM 크기", len(basis_bytes), atleast=400_000)

    info = get_json(f"/api/site/{q(site)}")
    check("수집범위 4값", len(info.get("bbox") or []), 4)
    check("다이어그램 장면 지문", bool(info.get("scene_fingerprint")), True)

    t = time.time()
    pc = get_json(f"/api/site/{q(site)}/parcels")
    check("필지", len(pc["features"]), atleast=100)
    check("필지 응답 5초 안", round(time.time() - t, 1) < 5, True)

    bd = get_json(f"/api/site/{q(site)}/buildings")
    check("건물", len(bd["features"]), atleast=100)

    pv = get_json(f"/api/site/{q(site)}/preview")
    check("미리보기 레이어", sorted(pv.keys()),
          ["district", "planroad", "road", "terrain", "zone"])

    sc = get_json(f"/api/site/{q(site)}/scene?radius=0&grid=56", timeout=1800)
    check("장면 필지", len(sc["parcels"]), atleast=100)
    check("필지에 지목", sum(1 for p in sc["parcels"] if p.get("jimok")), atleast=1)
    check("필지에 용도지역", sum(1 for p in sc["parcels"] if p.get("zone")), atleast=1)
    check("건물에 구조", sum(1 for x in sc["buildings"] if x.get("strct")), atleast=1)
    check("건물 실물3D 중심좌표", all(len(x.get("center_4326") or []) == 2
          for x in sc["buildings"]), True)
    check("도로면 Polygon", len(sc.get("road_areas") or []), atleast=1)
    road_source = sc.get("road_area_source") or {}
    check("도로면이 지적도 아님", road_source.get("dataset_id") != "LP_PA_CBND_BUBUN", True)
    road_analysis = sc.get("road_analysis") or {}
    check("도로망 분석 중심선", len(road_analysis.get("features") or []), atleast=1)
    field_ids = [x.get("id") for x in road_analysis.get("fields") or []]
    check("도로망 원본 속성", all(key in field_ids for key in
          ("rvwd", "rdln", "hierarchy", "rddv", "pvqt", "dvyn", "onsd")), True)
    check("도로망 계산 지표", all(key in field_ids for key in
          ("length_m", "connectivity", "centrality", "capacity")), True)
    category_fields = [x for x in road_analysis.get("fields") or [] if x.get("type") == "category"]
    check("도로망 범주 코드표", bool(category_fields) and
          all(x.get("categories") for x in category_fields), True)
    backfill = post_json(f"/api/site/{q(site)}/road-analysis")
    check("도로망 자동 보충 API", backfill.get("cached") or bool(backfill.get("job_id")), True)
    check("지형 격자", (sc.get("ground") or {}).get("n"), atleast=8)

    # 위성사진은 실제로 쓴 반경을 알려 줘야 한다 (모델과 어긋나지 않게)
    st, hd, _ = get("/api/site/%s/aerial?radius=400&size=512" % q(site), timeout=600)
    check("사진 반경 알림", hd.get("X-Aerial-Radius"), "400.0")
    st, hd, _ = get("/api/site/%s/aerial?radius=9000&size=512" % q(site), timeout=600)
    check("사진 반경 상한", hd.get("X-Aerial-Radius"), "2500.0")

    for kind in ("site", "plan2d", "diagram3d"):
        ps = get_json(f"/api/presets?kind={kind}")
        check(f"프리셋 칸 ({kind})", len(ps["slots"]), 5)

    up = get_json("/api/update/check", timeout=120)
    check("업데이트 확인", "reason" in up or "available" in up)


# ────────────────────────────────────────────────── 브라우저
BROWSER_JS = r"""
async () => {
  const out = {};
  const ops = plan2List();
  out.도판_op = ops.length;
  out.레이어 = P2.layers.map(L => L.id);
  out.SVG레이어 = [...new Set(ops.map(o => o.layer).filter(Boolean))].length;
  out.도로면_출처 = P2.scene?.road_area_source?.dataset_id || "";
  out.도로면_op = ops.filter(o => o.layer === layerOf("roadarea").name).length;
  const roadLayer=layerOf('roadarea'),savedRoadAnalysis={...roadAnalysisState(roadLayer)};
  Object.assign(roadLayer.analysis,{on:true,field:'rvwd',low:'#ffffff',high:'#e2564a',op:100,blend:8});
  const analysisOps=plan2List(),fieldOps=analysisOps.filter(o=>o.t==='roadField');
  out.도로망_분석_op=fieldOps.length===1&&fieldOps[0].segments?.length>0;
  out.도로망_가우시안_연속필드=fieldOps[0]?.gaussian===true&&fieldOps[0].blendMeters===8&&
    !analysisOps.some(o=>o.roadJunction||o.t==='dot'&&o.layer?.includes('분석_'));
  out.도로망_도로면_clip=analysisOps.some(o=>o.t==='clipStart'&&o.layer?.includes('분석_도로폭'))&&
                        analysisOps.some(o=>o.t==='clipEnd'&&o.layer?.includes('분석_도로폭'));
  out.도로망_겹침없는_면마스크=analysisOps.some(o=>o.t==='clipStart'&&o.fillRule==='nonzero');
  out.도로망_도로면_오버스캔=fieldOps[0].segments.some(segment=>
    segment.mappedWidthMeters>segment.sourceWidthMeters&&segment.sigma>0);
  const syntheticRoadField={t:'roadField',low:'#0000ff',high:'#ff0000',gaussian:true,
    cacheKey:'selftest-road-field',segments:[
      {x1:10,y1:50,x2:60,y2:50,value:0,sigma:8},
      {x1:60,y1:50,x2:110,y2:50,value:1,sigma:8}],layer:'도로면 · 분석_시험'};
  const syntheticRoadClip={t:'clipStart',rings:[[[5,38],[115,38],[115,62],[5,62]]],
    fillRule:'nonzero',layer:'도로면 · 분석_시험'};
  const syntheticRoadEnd={t:'clipEnd',layer:'도로면 · 분석_시험'};
  DRAW.clearCaches();
  const roadFieldCanvas=DRAW.renderToCanvas([syntheticRoadClip,syntheticRoadField,syntheticRoadEnd],
    {w:120,h:100,bg:null,crop:null,scale:1});
  DRAW.renderToCanvas([syntheticRoadClip,syntheticRoadField,syntheticRoadEnd],
    {w:120,h:100,bg:null,crop:null,scale:1});
  const roadPixels=roadFieldCanvas.getContext('2d');
  const roadLeft=roadPixels.getImageData(25,50,1,1).data;
  const roadJoin=roadPixels.getImageData(60,50,1,1).data;
  const roadRight=roadPixels.getImageData(95,50,1,1).data;
  const roadOutside=roadPixels.getImageData(60,25,1,1).data;
  out.도로망_교차부_가우시안혼합=roadLeft[2]>roadLeft[0]&&roadRight[0]>roadRight[2]&&
    roadJoin[0]>50&&roadJoin[2]>50;
  out.도로망_도로면밖_투명=roadOutside[3]===0;
  const roadCacheStats=DRAW.cacheStats();
  out.도로망_필드캐시=roadCacheStats.roadFieldMisses===1&&roadCacheStats.roadFieldHits===1;
  const analysisBaseField=fieldOps[0],analysisBaseSegment=analysisBaseField.segments[0];
  const analysisZoom=P2.zoom;P2.zoom=analysisZoom*2;
  const analysisDouble=plan2List(),analysisDoubleField=analysisDouble.find(o=>o.t==='roadField');
  const analysisDoubleSegment=analysisDoubleField?.segments?.[0];
  out.도로망_줌배율연동=!!analysisBaseSegment&&!!analysisDoubleSegment&&
    Math.abs(analysisDoubleSegment.sigma-analysisBaseSegment.sigma*2)<1e-6;
  P2.zoom=analysisZoom;
  const analysisSVG=DRAW.toSVG(analysisOps,800,600,null,null);
  out.도로망_SVG_가우시안매핑=analysisSVG.includes('data-road-field="gaussian"')&&
    analysisSVG.includes('xlink:href="data:image/png;base64,')&&
    analysisSVG.includes('<clipPath id="layerClip')&&!analysisSVG.includes('<circle');
  Object.assign(roadLayer.analysis,{on:true,field:'rddv'});
  plan2RenderLayers();
  const categoryField=plan2List().find(o=>o.t==='roadField');
  out.도로망_범주형_필드=categoryField?.mode==='category'&&categoryField.palette?.length>0&&
    categoryField.segments?.every(segment=>Number.isInteger(segment.category));
  out.도로망_범주형_UI=document.querySelectorAll('[data-road-category]').length>0&&
    !!document.querySelector('[data-road-category-k="color"]');
  const syntheticCategory={t:'roadField',mode:'category',palette:['#0000ff','#ff0000'],
    cacheKey:'selftest-road-category',segments:[
      {x1:10,y1:50,x2:60,y2:50,category:0,sigma:8},
      {x1:60,y1:50,x2:110,y2:50,category:1,sigma:8}],layer:'도로면 · 분석_범주'};
  const categoryCanvas=DRAW.renderToCanvas([syntheticRoadClip,syntheticCategory,syntheticRoadEnd],
    {w:120,h:100,bg:null,crop:null,scale:1});
  const categoryJoin=categoryCanvas.getContext('2d').getImageData(60,50,1,1).data;
  out.도로망_범주형_중간값없음=(categoryJoin[0]>200&&categoryJoin[2]<30)||
                              (categoryJoin[2]>200&&categoryJoin[0]<30);
  Object.assign(roadLayer.analysis,{field:'rvwd'});
  plan2RenderLayers();
  const presetBefore=JSON.stringify(P2.layers);
  ROAD_ANALYSIS_ATTEMPTED.delete(current);
  out.도로망_자동보충=await backfillRoadAnalysis(current,{phase(){}});
  out.도로망_자동보충_프리셋유지=JSON.stringify(P2.layers)===presetBefore;
  roadLayer.analysis=savedRoadAnalysis;
  out.Export_scope_buttons = document.querySelectorAll("#p2m-area button[data-scope]").length === 3;
  const savedView = {zoom:P2.zoom, panX:P2.panX, panY:P2.panY,
                     crop:P2.crop, exportScope:P2.exportScope, selected:P2.selected};
  const cameraBeforeCrop = [P2.zoom, P2.panX, P2.panY];
  out.Export_CONTEXT_crop = plan2CropExportScope("context", false) &&
                           P2.exportScope === "context" && P2.crop?.w > 0 && P2.crop?.h > 0;
  out.Export_CONTEXT_camera_unchanged = cameraBeforeCrop.every((v,i) =>
    Math.abs(v - [P2.zoom, P2.panX, P2.panY][i]) < 1e-9);
  const projectBounds = plan2ScopeBounds("project");
  out.Export_PROJECT_crop = projectBounds
    ? plan2CropExportScope("project", false) && P2.exportScope === "project" && P2.crop?.w > 0
    : document.querySelector('#p2m-area [data-scope="project"]').disabled;
  const sampleParcel = P2.scene?.parcels?.[0];
  P2.selected = sampleParcel ? new Set([sampleParcel.pnu]) : new Set();
  plan2SyncExportScope();
  out.Export_DESIGN_crop = !!sampleParcel && plan2CropExportScope("design", false) &&
                          P2.exportScope === "design" && P2.crop?.w > 0 && P2.crop?.h > 0;
  const savedFmt = P2.fmt, savedExportSVG = DRAW.exportSVG;
  let exportedName = "", exportedCrop = null;
  DRAW.exportSVG = (name, unusedOps, view) => { exportedName = name; exportedCrop = view.crop; };
  P2.fmt = "svg";
  document.querySelector("#p2m-go").click();
  out.Export_scope_filename = exportedName.endsWith("_DESIGN_AREA.svg");
  out.Export_scope_crop_passed = !!exportedCrop && exportedCrop.w > 0 && exportedCrop.h > 0;
  DRAW.exportSVG = savedExportSVG; P2.fmt = savedFmt;
  P2.zoom=savedView.zoom; P2.panX=savedView.panX; P2.panY=savedView.panY;
  P2.crop=savedView.crop; P2.exportScope=savedView.exportScope; P2.selected=savedView.selected;
  plan2SyncExportScope(); plan2Render();

  // 합치기 — 붙은 사각형 넷은 고리 하나가 되어야 한다
  const sq = (x,y,s)=>[[x,y],[x+s,y],[x+s,y+s],[x,y+s]];
  const d = dissolveRings([sq(0,0,10), sq(10,0,10), sq(0,10,10), sq(10,10,10)]);
  out.합치기_고리 = d.length;
  out.합치기_넓이 = Math.round(Math.abs(ringArea(d[0])));

  // 도넛은 고리 둘 (바깥 + 구멍)
  const donut = [];
  for(let i=0;i<3;i++) for(let j=0;j<3;j++) if(!(i===1&&j===1)) donut.push(sq(i*10,j*10,10));
  out.도넛_고리 = dissolveRings(donut).length;

  // 조건 드롭다운은 실제 값으로 채워져야 한다
  out.구조_가짓수 = (P2.choices.bldg.strct || []).length;
  out.지목_가짓수 = (P2.choices.parcel.jimok || []).length;

  const parcelLayer=layerOf('parcel'),savedHatch=JSON.parse(JSON.stringify(parcelHatchState(parcelLayer)));
  const hatchState=parcelHatchState(parcelLayer);hatchState.on=true;
  Object.assign(hatchState,{spacing:9,w:.45,op:55});
  const hatchList=plan2List(),hatchOps=hatchList.filter(o=>o.t==='hatch');
  out.필지해치_주상공녹_분류=['제2종일반주거지역','일반상업지역','준공업지역','자연녹지지역']
    .map(parcelZoneCategory).join(',')==='residential,commercial,industrial,green';
  out.필지해치_UI_4분류=document.querySelectorAll('[data-hatch-cat]').length===4&&
    !!document.querySelector('[data-hatch-k="spacing"]')&&!!document.querySelector('[data-hatch-k="w"]');
  out.필지해치_필지면_clip=hatchOps.length>0&&hatchOps.every(o=>o.rings?.length&&o.fillRule==='evenodd');
  out.필지해치_카테고리_레이어=hatchOps.every(o=>o.layer.startsWith('필지 · 해치_'));
  const hatchZoom=P2.zoom;P2.zoom=.5;
  const hatchHalf=plan2List().find(o=>o.t==='hatch');
  P2.zoom=1;
  const hatchOne=plan2List().find(o=>o.t==='hatch');
  out.필지해치_줌배율연동=!!hatchHalf&&!!hatchOne&&
    Math.abs(hatchOne.spacing-hatchHalf.spacing*2)<1e-6&&
    Math.abs(hatchOne.w-hatchHalf.w*2)<1e-6;
  P2.zoom=hatchZoom;
  const hatchSVG=DRAW.toSVG(hatchOps,800,600,null,null);
  out.필지해치_SVG_패턴=hatchSVG.includes('<pattern id="hatch')&&
    hatchSVG.includes('fill="url(#hatch')&&!hatchSVG.includes('<image');
  const savedLayerOrder=P2.layers.slice(),bldgLayer=layerOf('bldg');
  P2.layers.splice(P2.layers.indexOf(parcelLayer),1);
  P2.layers.splice(Math.max(0,P2.layers.indexOf(bldgLayer)),0,parcelLayer);
  const forcedHatchList=plan2List();
  const forcedBuildingAt=forcedHatchList.findIndex(o=>o.layer===bldgLayer.name||o.layer?.startsWith(`${bldgLayer.name} · `));
  const forcedHatchAt=forcedHatchList.reduce((last,o,index)=>o.t==='hatch'?index:last,-1);
  out.필지해치_건물보다아래=forcedHatchAt>=0&&forcedBuildingAt>=0&&forcedHatchAt<forcedBuildingAt;
  P2.layers.splice(0,P2.layers.length,...savedLayerOrder);
  const syntheticHatch={t:'hatch',rings:[[[20,20],[100,20],[100,80],[20,80]]],
    pattern:'cross',color:'#000000',spacing:8,w:1,opacity:1,fillRule:'evenodd',layer:'필지 · 해치_시험'};
  const hatchCanvas=DRAW.renderToCanvas([syntheticHatch],{w:120,h:100,bg:null,crop:null,scale:1});
  const hatchPixels=hatchCanvas.getContext('2d').getImageData(0,0,120,100).data;
  const alphaAt=(x,y)=>hatchPixels[(y*120+x)*4+3];
  out.필지해치_경계밖_투명=alphaAt(5,5)===0&&alphaAt(115,95)===0&&
    (()=>{for(let y=20;y<80;y++)for(let x=20;x<100;x++)if(alphaAt(x,y)>0)return true;return false;})();
  const manyHatchRings=Array.from({length:321},(_,i)=>{const x=(i%20)*4,y=Math.floor(i/20)*4;
    return [[x,y],[x+3,y],[x+3,y+3],[x,y+3]];});
  const manyHatch={...syntheticHatch,rings:manyHatchRings};
  const manyHatchSVG=DRAW.toSVG([manyHatch],120,100,null,null);
  out.필지해치_SVG_분할=(manyHatchSVG.match(/fill="url\(#hatch0\)"/g)||[]).length>=3;
  const hatchCoverBuilding={t:'poly',pts:[[40,30],[80,30],[80,70],[40,70]],fill:'#e2564a',layer:'건물'};
  const manyHatchCanvas=DRAW.renderToCanvas([manyHatch,hatchCoverBuilding],{w:120,h:100,bg:'#ffffff',crop:null,scale:1});
  const buildingPixel=manyHatchCanvas.getContext('2d').getImageData(60,50,1,1).data;
  out.필지해치_PNG_건물유지=buildingPixel[0]>200&&buildingPixel[1]<120&&buildingPixel[2]<120;
  parcelLayer.hatch=savedHatch;plan2RenderLayers();plan2Render();

  // 모든 건물 그림자는 하나의 낮은 레이어로 합치고, 건물 면은 그 위에 그린다.
  const savedShadow={...P2.design.shadow};
  Object.assign(P2.design.shadow,{on:true,op:45,blur:4,angle:0,dist:12});
  const shadowList=plan2List(),shadowOps=shadowList.filter(o=>o.t==='shadow');
  const buildingName=layerOf('bldg').name;
  const buildingOps=shadowList.filter(o=>o.t==='poly'&&
    (o.layer===buildingName||o.layer?.startsWith(`${buildingName} · `)));
  const shadowIndex=shadowList.indexOf(shadowOps[0]);
  out.건물그림자_단일합성레이어=shadowOps.length===1&&shadowOps[0].rings?.length>0&&
    shadowOps[0].layer===`${buildingName} · 그림자`;
  const sourceShadowRingCount=(P2.scene?.buildings||[])
    .reduce((count,building)=>count+(building.rings?.length||0),0);
  out.건물그림자_매스부터연속투영=shadowOps[0]?.castSweep===true&&
    shadowOps[0].dx===0&&shadowOps[0].dy===0&&
    shadowOps[0].rings.length>sourceShadowRingCount&&!!shadowOps[0].cacheKey;
  out.건물그림자_건물보다아래=shadowIndex>=0&&buildingOps.length>0&&
    buildingOps.every(o=>shadowIndex<shadowList.indexOf(o))&&buildingOps.every(o=>!o.shadow);
  const shadowSVG=DRAW.toSVG(shadowList,800,600,null,null);
  const shadowDoc=new DOMParser().parseFromString(shadowSVG,'image/svg+xml');
  const shadowLabels=[...shadowDoc.documentElement.children]
    .filter(el=>el.localName==='g').map(el=>el.getAttribute('inkscape:label'));
  const svgShadowIndex=shadowLabels.indexOf(`${buildingName} · 그림자`);
  const svgBuildingIndex=shadowLabels.findIndex(label=>label===buildingName||
    (label?.startsWith(`${buildingName} · `)&&label!==`${buildingName} · 그림자`));
  out.건물그림자_SVG_분리레이어=svgShadowIndex>=0&&svgBuildingIndex>svgShadowIndex&&
    shadowSVG.includes('<filter id="buildingShadow');
  const shadowZoom=P2.zoom,shadowBase=shadowOps[0];
  P2.zoom=shadowZoom*2;
  const shadowDouble=plan2List().find(o=>o.t==='shadow');
  out.건물그림자_줌배율연동=!!shadowBase&&!!shadowDouble&&
    Math.abs(shadowDouble.blur-shadowBase.blur*2)<1e-6&&
    Math.abs(shadowDouble.castDx-shadowBase.castDx*2)<1e-6&&
    Math.abs(shadowDouble.castDy-shadowBase.castDy*2)<1e-6;
  P2.zoom=shadowZoom;
  const sweptShadow={t:'shadow',
    rings:sweptShadowRings([[[10,10],[30,10],[30,30],[10,30]]],30,0),
    fill:'#000000',blur:0,dx:0,dy:0,fillRule:'nonzero',castSweep:true,
    cacheKey:'selftest-swept-shadow',layer:'건물 · 그림자'};
  DRAW.clearCaches();
  const sweptCanvas=DRAW.renderToCanvas([sweptShadow],
    {w:70,h:40,bg:'#ffffff',crop:null,scale:1});
  DRAW.renderToCanvas([sweptShadow],{w:70,h:40,bg:'#ffffff',crop:null,scale:1});
  const shadowCacheStats=DRAW.cacheStats();
  out.건물그림자_마스크캐시=shadowCacheStats.shadowMisses===1&&shadowCacheStats.shadowHits===1;
  const bridgePixel=sweptCanvas.getContext('2d').getImageData(35,20,1,1).data;
  out.건물그림자_중간면_연결=bridgePixel[0]<20&&bridgePixel[1]<20&&bridgePixel[2]<20;
  const syntheticShadow={t:'shadow',rings:[[[10,10],[30,10],[30,30],[10,30]]],
    fill:'rgba(0,0,0,.8)',blur:0,dx:30,dy:0,layer:'건물 · 그림자'};
  const coverBuilding={t:'poly',pts:[[40,10],[60,10],[60,30],[40,30]],fill:'#ffffff',layer:'건물'};
  const shadowCanvas=DRAW.renderToCanvas([syntheticShadow,coverBuilding],
    {w:70,h:40,bg:'#888888',crop:null,scale:1});
  const coverPixel=shadowCanvas.getContext('2d').getImageData(50,20,1,1).data;
  out.건물그림자_인접건물에가림=coverPixel[0]===255&&coverPixel[1]===255&&coverPixel[2]===255;
  const spotLayer=layerOf('spot'),savedSpotOn=spotLayer.on,savedZoomForSpot=P2.zoom;
  spotLayer.on=true;P2.zoom=.2;
  const spotSmall=plan2List().find(o=>o.t==='dot'&&!o.roadJunction);
  P2.zoom=.4;
  const spotLarge=plan2List().find(o=>o.t==='dot'&&!o.roadJunction);
  out.표고점_줌배율연동=!spotSmall&&!spotLarge||
    (!!spotSmall&&!!spotLarge&&Math.abs(spotLarge.r-spotSmall.r*2)<1e-6);
  spotLayer.on=savedSpotOn;P2.zoom=savedZoomForSpot;
  P2.design.shadow=savedShadow;plan2Render();

  // 선 굵기는 확대를 따라간다
  const w1 = ops.find(o => o.w > 0);
  const z = P2.zoom; P2.zoom = z * 2;
  const w2 = plan2List().find(o => o.w > 0);
  P2.zoom = z;
  out.굵기_배율따라감 = !!(w1 && w2 && Math.abs(w2.w - w1.w * 2) < 0.01);

  const savedGrid = {...P2.design.grid};
  Object.assign(P2.design.grid, {on:true, mode:'count', cols:7, rows:5, dx:0, dy:0});
  const countedGrid = plan2List().filter(o => o.layer === '그리드');
  out.그리드_CONTEXT_7x5 = countedGrid.length === 14;
  const beforeGridPoint=countedGrid[0]?.pts?.[0];
  Object.assign(P2.design.grid,{dx:25,dy:-15});
  const movedGrid=plan2List().filter(o=>o.layer==='그리드');
  const afterGridPoint=movedGrid[0]?.pts?.[0],gridScale=plan2Projector().scale;
  out.그리드_CONTEXT_이동=countedGrid.length===movedGrid.length&&!!beforeGridPoint&&!!afterGridPoint&&
    Math.abs(afterGridPoint[0]-beforeGridPoint[0]-25*gridScale)<.01&&
    Math.abs(afterGridPoint[1]-beforeGridPoint[1]-15*gridScale)<.01;
  P2.design.grid = savedGrid; plan2Render();

  const savedNoise={...P2.design.noise};
  Object.assign(P2.design.noise,{on:true,amount:12,distribution:'gaussian',
    monochromatic:true,seed:2701});
  const listWithNoise=plan2List(),noiseOps=listWithNoise.filter(o=>o.t==='noise');
  out.노이즈_디자인_UI=!!document.querySelector('#dz-noise')&&
    !!document.querySelector('#dz-noise-amount')&&!!document.querySelector('#dz-noise-distribution')&&
    !!document.querySelector('#dz-noise-monochromatic');
  out.노이즈_Photoshop_설정=noiseOps.length===1&&noiseOps[0].amount===12&&
    noiseOps[0].distribution==='gaussian'&&noiseOps[0].monochromatic===true;
  out.노이즈_최종픽셀_적용=listWithNoise.indexOf(noiseOps[0])>
    Math.max(...listWithNoise.map((o,i)=>o.layer==='축척'?i:-1));
  const noiseSVG=DRAW.toSVG(noiseOps,800,600,null,null);
  out.노이즈_SVG_Photoshop필터=noiseSVG.includes('<feTurbulence type="fractalNoise"')&&
    noiseSVG.includes('<feColorMatrix type="saturate" values="0"')&&
    noiseSVG.includes('inkscape:label="노이즈 · Photoshop Add Noise"')&&
    !noiseSVG.includes('<pattern');
  const background={t:'poly',pts:[[0,0],[200,0],[200,160],[0,160]],fill:'#808080',layer:'바탕'};
  const noiseOp={t:'noise',x:0,y:0,w:200,h:160,amount:12,distribution:'gaussian',
    monochromatic:true,seed:2701,layer:'노이즈 · Photoshop Add Noise'};
  DRAW.clearCaches();
  const fullNoise=DRAW.renderToCanvas([background,noiseOp],{w:200,h:160,bg:null,crop:null,scale:1});
  DRAW.renderToCanvas([background,noiseOp],{w:200,h:160,bg:null,crop:null,scale:1});
  const noiseCacheStats=DRAW.cacheStats();
  out.노이즈_좌표표본_캐시=noiseCacheStats.noiseMisses===1&&noiseCacheStats.noiseHits===1;
  const noiseCrop={x:37,y:29,w:90,h:70};
  const cropNoise=DRAW.renderToCanvas([background,noiseOp],{w:200,h:160,bg:null,crop:noiseCrop,scale:1});
  const fullNoisePixels=fullNoise.getContext('2d').getImageData(0,0,200,160).data;
  const cropNoisePixels=cropNoise.getContext('2d').getImageData(0,0,90,70).data;
  out.노이즈_CONTEXT_crop_aligned=[[0,0],[20,15],[89,69]].every(([x,y])=>{
    const a=((y+noiseCrop.y)*200+x+noiseCrop.x)*4,b=(y*90+x)*4;
    return [0,1,2,3].every(k=>fullNoisePixels[a+k]===cropNoisePixels[b+k]);
  });
  out.노이즈_단색_RGB동일=(()=>{for(let i=0;i<fullNoisePixels.length;i+=4)
    if(fullNoisePixels[i]!==128)return fullNoisePixels[i]===fullNoisePixels[i+1]&&
      fullNoisePixels[i+1]===fullNoisePixels[i+2];return false;})();
  const uniformOp={...noiseOp,amount:10,distribution:'uniform'};
  const uniformCanvas=DRAW.renderToCanvas([background,uniformOp],{w:200,h:160,bg:null,crop:null,scale:1});
  const uniformPixels=uniformCanvas.getContext('2d').getImageData(0,0,200,160).data;
  let maxUniformDelta=0;for(let i=0;i<uniformPixels.length;i+=4)
    maxUniformDelta=Math.max(maxUniformDelta,Math.abs(uniformPixels[i]-128));
  out.노이즈_Uniform_범위=maxUniformDelta>0&&maxUniformDelta<=26;
  const colorOp={...noiseOp,monochromatic:false};
  const colorCanvas=DRAW.renderToCanvas([background,colorOp],{w:200,h:160,bg:null,crop:null,scale:1});
  const colorPixels=colorCanvas.getContext('2d').getImageData(0,0,200,160).data;
  out.노이즈_컬러_채널독립=(()=>{for(let i=0;i<colorPixels.length;i+=4)
    if(colorPixels[i]!==colorPixels[i+1]||colorPixels[i+1]!==colorPixels[i+2])return true;return false;})();
  P2.design.noise=savedNoise; plan2Render();

  // SVG 는 레이어로 묶여 나간다
  const svg = DRAW.toSVG(ops, 800, 600, null, null);
  out.SVG_묶음 = (svg.match(/<g id=/g) || []).length;
  out.SVG_배경없음 = svg.indexOf("<rect") < 0 || svg.indexOf("<rect") > svg.indexOf("<g ");
  out.SVG_actual_XML_parse = !new DOMParser()
    .parseFromString(svg, "image/svg+xml").querySelector("parsererror");
  const svgWithoutImages = svg.replace(/xlink:href="data:[^"]+"/g, "");
  out.SVG_actual_finite_numbers = !/\b(?:NaN|Infinity)\b/.test(svgWithoutImages);
  const actualIds = [...svg.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  out.SVG_actual_unique_ids = actualIds.length === new Set(actualIds).size;
  const actualDoc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const topLayers = [...actualDoc.documentElement.children].filter(el =>
    el.localName === 'g' && el.getAttribute('inkscape:groupmode') === 'layer');
  out.SVG_top_level_layers = topLayers.length >= 2;
  out.SVG_no_master_group = ![...actualDoc.documentElement.children].some(el =>
    el.localName === 'g' && el.getAttribute('inkscape:groupmode') !== 'layer' &&
    el.querySelector('[inkscape\\:groupmode="layer"]'));
  const layerLabels = topLayers.map(el => el.getAttribute('inkscape:label'));
  out.SVG_one_group_per_layer = layerLabels.length === new Set(layerLabels).size;
  const vignetteSVG = DRAW.toSVG([{t:'vignette',shape:'rect',cx:100,cy:100,rx:60,ry:50,
    feather:.45,color:'#000000',op:.55,w:200,h:200,layer:'비네트'}],200,200,null,null);
  out.SVG_rect_vignette_gradients = (vignetteSVG.match(/<linearGradient/g)||[]).length === 4 &&
    !vignetteSVG.includes('fill-rule="evenodd"')&&vignetteSVG.includes('stop-opacity="0"')&&
    !vignetteSVG.includes('stop-color-opacity');
  const ellipseOp={t:'vignette',shape:'ellipse',cx:430,cy:310,rx:120,ry:90,
    feather:.45,color:'#000000',op:.55,w:800,h:600,layer:'비네트'};
  const vignetteCrop={x:180,y:90,w:420,h:340};
  const fullVignette=DRAW.renderToCanvas([ellipseOp],{w:800,h:600,bg:'#ffffff',crop:null,scale:1});
  const cropVignette=DRAW.renderToCanvas([ellipseOp],{w:800,h:600,bg:'#ffffff',crop:vignetteCrop,scale:1});
  const fullPixels=fullVignette.getContext('2d').getImageData(0,0,800,600).data;
  const cropPixels=cropVignette.getContext('2d').getImageData(0,0,420,340).data;
  const samples=[[0,0],[80,60],[250,220],[419,339]];
  out.Vignette_CONTEXT_crop_aligned=samples.every(([x,y])=>{
    const a=((y+vignetteCrop.y)*800+x+vignetteCrop.x)*4,b=(y*420+x)*4;
    return [0,1,2,3].every(k=>Math.abs(fullPixels[a+k]-cropPixels[b+k])<=1);
  });
  const croppedVignetteSVG=DRAW.toSVG([ellipseOp],800,600,'#ffffff',vignetteCrop);
  out.SVG_crop_origin_zero=croppedVignetteSVG.includes('viewBox="0 0 420 340"')&&
    croppedVignetteSVG.includes('transform="translate(-180 -90)"');
  const compat = DRAW.toSVG([
    {t:"poly", layer:"building layer", pts:[[0,0],[20,0],[20,20]],
     fill:"rgba(255,0,0,.5)", stroke:"#112233cc", w:.25,
     shadow:{color:"rgba(0,0,0,.3)", blur:4, dx:2, dy:3}},
    {t:"image", layer:"satellite", href:"data:image/png;base64,iVBORw0KGgo=",
     x:0, y:0, w:20, h:20},
  ], 20, 20, "#fff", null);
  out.SVG_Illustrator_XML = compat.startsWith('<?xml version="1.0" encoding="UTF-8"?>');
  out.SVG_Illustrator_11 = compat.includes('<svg version="1.1"');
  out.SVG_Illustrator_xlink = compat.includes('xlink:href="data:image/png;base64,');
  out.SVG_Illustrator_no_RGBA = !compat.includes("rgba(");
  out.SVG_Illustrator_no_SVG2_shadow = !compat.includes("feDropShadow");
  out.SVG_Illustrator_fractional_stroke = compat.includes('stroke-width="0.25"');
  out.SVG_Illustrator_unique_ids = (() => {
    const ids = [...compat.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    return ids.length === new Set(ids).size;
  })();
  const aiPackage=DRAW.illustratorPackageBlob(compat),aiBytes=new Uint8Array(await aiPackage.arrayBuffer());
  const aiText=new TextDecoder().decode(aiBytes);
  out.AI_package_ZIP=aiBytes[0]===0x50&&aiBytes[1]===0x4b&&aiBytes[2]===0x03&&aiBytes[3]===0x04;
  out.AI_package_files=['artwork.svg','Illustrator_Layers.jsx','README.txt'].every(name=>aiText.includes(name));
  out.AI_package_layer_script=aiText.includes('doc.layers.add()')&&aiText.includes('group.move(layer');
  return out;
}
"""


def browser_checks(site: str):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("\n[브라우저] playwright 가 없어 건너뜁니다.")
        return

    print("\n[브라우저]")
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1500, "height": 950})
        errs: list[str] = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(BASE, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(5000)

        check("시작할 때 대상지 없음", pg.evaluate("current"), None)
        open_secs = pg.eval_on_selector_all(
            ".sec[id]",
            "es => es.filter(e => ['ctxsec','psitebox','selbox','outbox','psbox']"
            ".includes(e.id) && !e.classList.contains('folded')).map(e => e.id)")
        check("01 만 열려 있음", open_secs, ["ctxsec"])
        check("중복 id 없음", pg.evaluate("""() => {
            const seen = {}, bad = [];
            document.querySelectorAll('[id]').forEach(e => {
              if (seen[e.id]) bad.push(e.id); else seen[e.id] = 1; });
            return [...new Set(bad)]; }"""), [])
        check("대지 변경 안내창 준비", pg.locator("#site-change-overlay").count(), 1)
        check("안내창은 처음에 닫힘",
              pg.eval_on_selector("#site-change-overlay", "e => e.getAttribute('aria-hidden')"), "true")

        pg.select_option("#sites", site)
        pg.wait_for_timeout(22000)
        check("대상지 열림", pg.evaluate("current"), site)
        check("수집범위 밖 그늘", pg.evaluate("!!extentVeil && MAP.hasLayer(extentVeil)"), True)

        # 우측 레이어판 필터
        for s in ("bldg", "parcel"):
            pg.click(f'label.rp-exp[for="exp-{s}"]')
        pg.wait_for_timeout(600)
        check("필터 펴짐 (건물)", pg.eval_on_selector("#slot-bldg", "e => e.offsetHeight") > 100, True)
        check("필터 펴짐 (필지)", pg.eval_on_selector("#slot-parcel", "e => e.offsetHeight") > 100, True)

        pg.click('.vtab[data-view="diagram"]')
        pg.wait_for_timeout(14000)
        check("다이어그램은 2D 부터", pg.evaluate("sub"), "2d")
        for k, v in pg.evaluate(BROWSER_JS).items():
            check("  " + k, v)

        # 굵기 칸은 키를 누를 때마다 input 이벤트가 난다. 완성값을 한 번에
        # fill하면 `0.`이 중간에 사라지는 회귀를 잡지 못하므로 실제 키 순서로 친다.
        p2_width = pg.locator('#p2layers [data-id="parcel"] input[data-k="w"]')
        p2_width.click()
        p2_width.press("Control+A")
        p2_width.press_sequentially("0.05")
        check("2D 선 굵기 소수 입력", pg.evaluate("layerOf('parcel').w"), 0.05)
        check("2D 소수 입력 후 선 켜짐",
              pg.locator('#p2layers [data-id="parcel"] input[data-k="strokeOn"]').is_checked(), True)

        pg.click('.stab[data-sub="3d"]')
        pg.wait_for_timeout(1800)
        d3_width = pg.locator('#dglayers [data-id="bldg"] input[data-k="w"]')
        d3_width.click()
        d3_width.press("Control+A")
        d3_width.press_sequentially("0.05")
        check("3D 선 굵기 소수 입력", pg.evaluate("dLayer('bldg').w"), 0.05)
        check("3D 소수 입력 후 선 켜짐",
              pg.locator('#dglayers [data-id="bldg"] input[data-k="strokeOn"]').is_checked(), True)

        pg.evaluate("document.querySelector('#dg-render-modes [data-render-mode=\"diagram\"]').click()")
        check("다이어그램 버튼이 실제 매핑 끔", pg.evaluate("""() =>
          dLayer('renderMass').mapping===false&&dLayer('ground').aerialMap===false"""), True)
        pg.evaluate("document.querySelector('#dg-render-modes [data-render-mode=\"aerial\"]').click()")
        check("위성 버튼이 실제 매핑 켬", pg.evaluate("""() =>
          dLayer('renderMass').mapping===true&&dLayer('ground').aerialMap===true"""), True)

        # VWorld 전용 화면으로 전환하지 않고 기존 WebGL 장면에 3D Tiles가 붙는지,
        # 그리고 모든 실물 재질에 CONTEXT 절단면이 적용되는지 실제 브라우저에서 본다.
        pg.evaluate("""async () => {
          window.__massTestSelected=DG.selected;
          if(!DG.selected?.size){
            const parcel=DG.scene.parcels.find(item=>item.pnu);
            DG.selected=new Set(parcel?[parcel.pnu]:[]);
          }
          DG.renderMode='aerial';
          const ground=dLayer('ground');ground.aerialMap=true;
          const layer=dLayer('renderMass');layer.on=true;layer.mapping=true;
          renderDGLayers();render();
          window.__massInitialMaskReady=null;
          const observeFirstTiles=()=>{
            if(DGR?._massTiles){
              window.__massInitialMaskReady=DGR._massMaskStats?.selectedParcels>0&&
                DGR._massTiles.group?.visible===true;
            }else requestAnimationFrame(observeFirstTiles);
          };
          observeFirstTiles();
          await loadDGAerial();render();
        }""")
        try:
            pg.wait_for_function("""() => DGR?._massTiles &&
              ((DGR._massLocked===true && DGR._massProgress===100) ||
               DGR.massStatus().kind==='error')""", timeout=150000)
        except Exception:
            pass
        mass_design_probe = pg.evaluate("""() => {
          const tiles=DGR?._massTiles;if(!tiles)return {selected:false,distance:null};
          const points=[];
          tiles.forEachLoadedModel(model=>model.traverse(object=>{
            if(!object.isMesh||points.length>=240)return;
            const position=object.geometry?.getAttribute('position');
            const batch=object.geometry?.getAttribute('_batchid')||object.geometry?.getAttribute('batchid');
            if(!position||!batch)return;
            const matrix=object.matrixWorld.elements,step=Math.max(1,Math.floor(position.count/40));
            for(let index=0;index<position.count&&points.length<240;index+=step){
              const x=position.getX(index),y=position.getY(index),z=position.getZ(index);
              points.push([
                matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12],
                matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13],
              ]);
            }
          }));
          const ringContains=(point,ring)=>{
            let inside=false;
            for(let i=0,j=ring.length-1;i<ring.length;j=i++){
              const a=ring[i],b=ring[j];
              if(((a[1]>point[1])!==(b[1]>point[1]))&&
                point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
            }
            return inside;
          };
          const parcelContains=(point,parcel)=>{
            const groups=Array.isArray(parcel.polygons)&&parcel.polygons.length
              ?parcel.polygons:(parcel.rings||[]).map(ring=>[ring]);
            return groups.some(group=>group?.[0]&&ringContains(point,group[0])&&
              !group.slice(1).some(ring=>ringContains(point,ring)));
          };
          const context=DG.scene.context_bounds||[-DG.scene.radius,-DG.scene.radius,DG.scene.radius,DG.scene.radius];
          let best=null,distance=Infinity,bestHits=0;
          const contextPoints=points.filter(point=>point[0]>=context[0]&&point[0]<=context[2]&&
            point[1]>=context[1]&&point[1]<=context[3]);
          for(const parcel of DG.scene.parcels||[]){
            if(!parcel.pnu)continue;
            let hits=0;for(const point of contextPoints)if(parcelContains(point,parcel))hits++;
            if(hits>bestHits){bestHits=hits;best=parcel;distance=0;}
          }
          if(!best)for(const parcel of DG.scene.parcels||[]){
            if(!parcel.pnu||!parcel.base_point)continue;
            for(const point of points){
              const value=Math.hypot(point[0]-parcel.base_point[0],point[1]-parcel.base_point[1]);
              if(value<distance){distance=value;best=parcel;}
            }
          }
          if(!best)return {selected:false,distance:null};
          DG.selected=new Set([best.pnu]);render();
          return {selected:true,distance,pnu:best.pnu};
        }""")
        if mass_design_probe["selected"]:
            try:
                pg.wait_for_function("""() => DGR?._massMaskStats?.hiddenFeatures>0""", timeout=10000)
            except Exception:
                pass
        real_mass = pg.evaluate("""() => {
          const out={status:DGR?.massStatus?.()||{},inScene:false,meshes:0,clipped:false,
            mapped:false,designMask:false,designMaskPixel:false,caps:false,capPlanes:0,
            capSources:0,capCrossingSources:0,capDiagnostics:{},capLayer:{},
            designBatchMeshes:0,designBatchFeatures:0,designHiddenFeatures:0,
            designWholeFeatures:true,designShadowMasked:true,localKtx2:DGR?._massKtx2Path==='/',
            groundMapped:false,locked:DGR?._massLocked===true,
            shadowCasters:0,shadowReceivers:0,shadowDepthMeshes:0,shadowMappedMaterials:0 };
          const tiles=DGR?._massTiles;if(!tiles)return out;
          out.inScene=tiles.group.parent===DGR.scene&&tiles.group.visible;
          const snapshot=DGR._massLoadSnapshot?.(tiles)||{};
          out.debug={snapshot,isLoading:tiles.isLoading,progress:DGR._massProgress,
            elapsed:Math.round(performance.now()-DGR._massStartedAt),
            stableFor:Math.round(performance.now()-DGR._massStableSince),
            stableSignature:DGR._massStableSignature,status:DGR.massStatus()};
          let clipped=true;
          tiles.forEachLoadedModel(model=>model.traverse(object=>{
            if(!object.isMesh)return;out.meshes++;
            const materials=Array.isArray(object.material)?object.material:[object.material];
            clipped=clipped&&materials.every(material=>material?.clippingPlanes?.length===4);
            out.mapped=out.mapped||materials.some(material=>material?.map);
            if(object.castShadow)out.shadowCasters++;
            if(object.receiveShadow)out.shadowReceivers++;
            if(object.customDepthMaterial?.userData?.diagramVWorldDesignMask)out.shadowDepthMeshes++;
            if(materials.some(material=>material?.isMeshStandardMaterial||material?.isMeshPhysicalMaterial||
              material?.isMeshPhongMaterial||material?.isMeshLambertMaterial||material?.isMeshToonMaterial))
              out.shadowMappedMaterials++;
          }));
          out.clipped=out.meshes>0&&clipped;
          DGR.root?.traverse(object=>{
            if(object.isMesh&&object.name==='지형 · 대지'){
              const materials=Array.isArray(object.material)?object.material:[object.material];
              out.groundMapped=materials.some(material=>!!material?.map);
            }
          });
          out.designMask=DGR._massMaskStats?.selectedParcels>0;
          tiles.forEachLoadedModel(model=>{
            const featureStates=new Map();
            model.traverse(object=>{
              if(!object.isMesh)return;
              const batch=object.geometry?.getAttribute('_batchid')||object.geometry?.getAttribute('batchid');
              const hide=object.geometry?.getAttribute('vworldHide');
              if(!batch||!hide)return;out.designBatchMeshes++;
              out.designShadowMasked=out.designShadowMasked&&
                !!object.customDepthMaterial?.userData?.diagramVWorldDesignMask;
              for(let index=0;index<Math.min(batch.count,hide.count);index++){
                const id=Math.round(batch.getX(index)),state=featureStates.get(id)||{shown:false,hidden:false};
                if(hide.getX(index)>.5)state.hidden=true;else state.shown=true;
                featureStates.set(id,state);
              }
            });
            for(const state of featureStates.values()){
              out.designBatchFeatures++;
              if(state.hidden&&!state.shown)out.designHiddenFeatures++;
              if(state.hidden&&state.shown)out.designWholeFeatures=false;
            }
          });
          out.capPlanes=DGR._massCapStats?.planes||0;
          out.capSources=DGR._massCapStats?.sources||0;
          out.capCrossingSources=DGR._massCapStats?.crossingSources||0;
          out.capDiagnostics={...(DGR._massCapStats||{})};
          out.capLayer={on:dLayer('renderMass')?.on,caps:dLayer('renderMass')?.caps,
            progress:DGR._massProgress,key:DGR._massCapKey};
          let capObject=false;DGR._massCapGroup?.traverse(object=>{
            if(object.userData.diagramVWorldCap)capObject=true;
          });
          out.caps=out.capPlanes>0&&DGR._massCapGroup?.parent===DGR.scene&&capObject;
          const selected=new Set([...DG.selected].map(String));
          const parcel=DG.scene.parcels.find(item=>selected.has(String(item.pnu||''))&&item.base_point);
          const image=DGR._massMaskTexture?.image,b=DG.scene.context_bounds;
          if(parcel&&image&&b){
            const x=Math.max(0,Math.min(image.width-1,Math.round((parcel.base_point[0]-b[0])/(b[2]-b[0])*(image.width-1))));
            const y=Math.max(0,Math.min(image.height-1,Math.round((b[3]-parcel.base_point[1])/(b[3]-b[1])*(image.height-1))));
            out.designMaskPixel=image.getContext('2d').getImageData(x,y,1,1).data[0]>128;
          }
          return out;
        }""")
        check("VWorld 실물 매스 같은 장면", real_mass["inScene"], True)
        check("VWorld 첫 타일 전 DESIGN AREA 마스크", pg.evaluate("window.__massInitialMaskReady"), True)
        check("VWorld 로드 진단", real_mass["debug"])
        check("VWorld CONTEXT 전체 로드 잠금", real_mass["locked"], True)
        check("VWorld 실물 매스 타일 로드", real_mass["meshes"] > 0, True)
        check("VWorld 실물 매핑 텍스처", real_mass["mapped"], True)
        check("VWorld 실물 매스 지면 매핑", real_mass["groundMapped"], True)
        check("VWorld 실물 매스 그림자 생성", real_mass["shadowCasters"] > 0, True)
        check("VWorld 실물 매스 그림자 수신", real_mass["shadowReceivers"] > 0, True)
        check("VWorld 실물 매스 그림자 깊이 재질", real_mass["shadowDepthMeshes"] > 0, True)
        check("VWorld 실물 매핑 조명 재질", real_mass["shadowMappedMaterials"] > 0, True)
        mass_shadow_pixels = pg.evaluate("""async () => {
          const layer=dLayer('shadow'),oldOn=layer.on,oldFill=layer.fillOn;
          const capture=()=>{
            const canvas=document.createElement('canvas');canvas.width=256;canvas.height=160;
            const ctx=canvas.getContext('2d',{willReadFrequently:true});
            ctx.drawImage(DGR.canvas,0,0,canvas.width,canvas.height);
            return ctx.getImageData(0,0,canvas.width,canvas.height).data;
          };
          layer.on=false;render();await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
          const without=capture();
          layer.on=true;layer.fillOn=true;render();await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
          const withShadow=capture();
          let changed=0,total=0;
          for(let index=0;index<withShadow.length;index+=4){
            const difference=Math.abs(withShadow[index]-without[index])+Math.abs(withShadow[index+1]-without[index+1])+
              Math.abs(withShadow[index+2]-without[index+2]);
            total+=difference;if(difference>=3)changed++;
          }
          layer.on=oldOn;layer.fillOn=oldFill;render();
          return {changed,mean:total/(withShadow.length*.75)};
        }""")
        check("VWorld 실물 그림자 화면 반영", mass_shadow_pixels["changed"] > 100 and
              mass_shadow_pixels["mean"] > .05, True)
        mass_opacity = pg.evaluate("""async () => {
          const layer=dLayer('renderMass'),old=layer.op??100;layer.op=35;render();
          await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
          const out={materials:0,transparent:0,depthWriting:0,maxOpacity:0};
          DGR?._massTiles?.forEachLoadedModel(model=>model.traverse(object=>{
            if(!object.isMesh)return;
            for(const material of (Array.isArray(object.material)?object.material:[object.material])){
              if(!material)return;out.materials++;if(material.transparent)out.transparent++;
              if(material.depthWrite)out.depthWriting++;
              out.maxOpacity=Math.max(out.maxOpacity,material.opacity??1);
            }
          }));
          layer.op=old;render();
          await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
          return out;
        }""")
        check("VWorld 실물 매스 투명도 화면 반영",
              mass_opacity["materials"] > 0 and
              mass_opacity["transparent"] == mass_opacity["materials"] and
              mass_opacity["depthWriting"] == 0 and
              mass_opacity["maxOpacity"] <= .351, True)
        check("VWorld KTX2 로컬 디코더", real_mass["localKtx2"], True)
        check("VWorld 실물 매스 CONTEXT 절단", real_mass["clipped"], True)
        check("VWorld 실물 매스 CONTEXT 절단면 채움", real_mass["caps"], True)
        check("VWorld 절단면 원본 메시", real_mass["capSources"] > 0, True)
        check("VWorld 절단 경계 교차 메시", real_mass["capCrossingSources"] > 0, True)
        check("VWorld 절단면 경계 생성", real_mass["capPlanes"] > 0, True)
        check("VWorld 절단면 실제 교차선", real_mass["capDiagnostics"].get("segments", 0) > 0, True)
        check("VWorld 절단면 닫힌 루프", real_mass["capDiagnostics"].get("loops", 0) > 0, True)
        check("VWorld 절단면 삼각 채움", real_mass["capDiagnostics"].get("triangles", 0) > 0, True)
        check("VWorld DESIGN AREA 제외 마스크", real_mass["designMask"], True)
        check("VWorld DESIGN AREA 내부 제외", real_mass["designMaskPixel"], True)
        check("VWorld 실물 건물 아래 테스트 필지", mass_design_probe["selected"], True)
        check("VWorld 건물 ID 메시 인식", real_mass["designBatchMeshes"] > 0, True)
        check("VWorld DESIGN AREA 실물 건물 제외", real_mass["designHiddenFeatures"] > 0, True)
        check("VWorld DESIGN AREA 건물 단위 제외", real_mass["designWholeFeatures"], True)
        check("VWorld 제외 건물 그림자 제거", real_mass["designShadowMasked"], True)
        check("VWorld 실물 매스 로드 오류 없음",
              real_mass["status"].get("message") if real_mass["status"].get("kind") else "", "")
        mass_rotation_requests = []
        def capture_mass_rotation_request(request):
            if "TDServer" in request.url:
                mass_rotation_requests.append(request.url)
        pg.on("request", capture_mass_rotation_request)
        mass_freeze = pg.evaluate("""async () => {
          const out={fixedCamera:false,sameTiles:false,modelsStable:false,locked:false};
          const tiles=DGR?._massTiles;if(!tiles)return out;
          const count=()=>{let n=0;tiles.forEachLoadedModel(()=>n++);return n;};
          const cameras=[...(DGR._massLoadCameras||[])];
          const cameraState=cameras.map(camera=>camera.matrixWorld.toArray().join(',')+'|'+
            camera.projectionMatrix.toArray().join(','));
          const bounds=DG.scene.context_bounds||[-DG.scene.radius,-DG.scene.radius,DG.scene.radius,DG.scene.radius];
          const expected=Math.max(1,Math.min(4,Math.ceil((bounds[2]-bounds[0])/600)))*
            Math.max(1,Math.min(4,Math.ceil((bounds[3]-bounds[1])/600)));
          const before=count(),sceneKey=DGR._massSceneKey,
            originalUpdate=tiles.update,old={az:DG.az,el:DG.el,zoom:DG.zoom};
          let updates=0;
          tiles.update=function(...args){updates++;return originalUpdate.apply(this,args);};
          DG.az=(DG.az+117)%360;DG.el=Math.max(10,Math.min(80,DG.el+17));DG.zoom*=1.2;
          render();await new Promise(resolve=>setTimeout(resolve,700));render();
          out.fixedCamera=cameras.length===expected&&tiles.cameras?.length===expected&&
            cameras.every((camera,index)=>tiles.cameras.includes(camera)&&camera!==DGR.camera&&
              cameraState[index]===camera.matrixWorld.toArray().join(',')+'|'+
                camera.projectionMatrix.toArray().join(','));
          out.sameTiles=DGR._massTiles===tiles&&DGR._massSceneKey===sceneKey;
          out.locked=DGR._massLocked===true;
          out.modelsStable=before>0&&(out.locked?count()===before:count()>0);
          tiles.update=originalUpdate;Object.assign(DG,old);render();
          return out;
        }""")
        pg.remove_listener("request", capture_mass_rotation_request)
        check("VWorld CONTEXT 구역별 고정 카메라", mass_freeze["fixedCamera"], True)
        check("VWorld 회전 후 같은 타일셋", mass_freeze["sameTiles"], True)
        check("VWorld 고정 완료 후 네트워크 재수집 없음",
              not mass_freeze["locked"] or not mass_rotation_requests, True)
        check("VWorld 회전 후 모델 수 유지", mass_freeze["modelsStable"], True)
        pg.evaluate("""() => {
          const layer=dLayer('renderMass');layer.on=false;
          DG.selected=window.__massTestSelected||DG.selected;delete window.__massTestSelected;
          renderDGLayers();render();
        }""")

        parcel_row = pg.locator('#dglayers .lyr[data-id="parcel"]')
        building_row = pg.locator('#dglayers .lyr[data-id="bldg"]')
        parcel_row.drag_to(building_row)
        layer_priority = pg.evaluate("""() => {
          const ids=DG.layers.map(layer=>layer.id),parcel=ids.indexOf('parcel'),building=ids.indexOf('bldg');
          let parcelOrder=-1,buildingOrder=-1;
          DGR?.root?.traverse(object=>{
            if(object.userData.diagramLayerId==='parcel')parcelOrder=Math.max(parcelOrder,object.renderOrder);
            if(object.userData.diagramLayerId==='bldg')buildingOrder=Math.max(buildingOrder,object.renderOrder);
          });
          return {moved:parcel>=0&&building>=0&&parcel<building,rendered:parcelOrder>buildingOrder};
        }""")
        check("3D 레이어 드래그 순서 변경", layer_priority["moved"], True)
        check("3D 레이어 실제 렌더 우선순위", layer_priority["rendered"], True)

        d3_new = pg.evaluate("""async () => {
          const out = {};
          out.designLayer = dLayer('designBldg')?.name === 'DESIGN AREA 건물';
          out.contextLayer = dLayer('bldg')?.name === 'CONTEXT 건물';
          out.blackPalette = !!document.querySelector('.color-palette-swatch[data-color="#000000"]');
          out.rhinoExportOption = !!document.querySelector('#dgm-fmt [data-fmt="3dm"]');

          // L자 바닥의 바운딩박스 중앙은 (2, 1.5)이지만 실제 면적 중심은
          // (1.5, 1.0)이다. 가져온 모델과 대상 건물이 모두 면적 중심을 쓰는지 본다.
          const anchorPositions=new Float32Array([
            0,0,0, 4,0,0, 4,0,-1,  0,0,0, 4,0,-1, 0,0,-1,
            0,0,-1, 1,0,-1, 1,0,-3,  0,0,-1, 1,0,-3, 0,0,-3,
          ]);
          let anchorRaw='';for(const byte of new Uint8Array(anchorPositions.buffer))anchorRaw+=String.fromCharCode(byte);
          const anchorGltf={asset:{version:'2.0'},buffers:[{byteLength:anchorPositions.byteLength,
            uri:'data:application/octet-stream;base64,'+btoa(anchorRaw)}],
            bufferViews:[{buffer:0,byteOffset:0,byteLength:anchorPositions.byteLength}],
            accessors:[{bufferView:0,componentType:5126,count:12,type:'VEC3',min:[0,0,-3],max:[4,0,0]}],
            meshes:[{primitives:[{attributes:{POSITION:0}}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0};
          const anchorFile=new File([JSON.stringify(anchorGltf)],'anchor-selftest.glb',{type:'model/gltf-binary'});
          const anchorBuilding={pnu:'anchor',floors:1,base:0,
            rings:[[[10,20],[14,20],[14,21],[11,21],[11,23],[10,23],[10,20]]],
            polygons:[[[[10,20],[14,20],[14,21],[11,21],[11,23],[10,23],[10,20]]]]};
          const anchorTransaction=await DGR.loadBuildingModel('__base_anchor_fixture__',anchorFile,
            {data:DG.scene,state:DG,building:anchorBuilding,index:0});
          const anchorInfo=DGR.buildingModelInfo('__base_anchor_fixture__');
          out.modelBaseAreaAnchor=anchorInfo?.anchorMethod==='bottom-face'&&
            Math.abs(anchorInfo.sourceAnchor[0]-1.5)<1e-5&&Math.abs(anchorInfo.sourceAnchor[1]-1)<1e-5;
          out.modelTargetAreaCentroid=Math.abs(anchorInfo.placement.x-11.5)<1e-5&&
            Math.abs(anchorInfo.placement.y-21)<1e-5&&anchorInfo.footprint.length>=3;
          const normalizedRoot=anchorTransaction._entry.scene;
          normalizedRoot.updateMatrixWorld(true);
          let normalizedArea=0,normalizedX=0,normalizedY=0;
          normalizedRoot.traverse(object=>{
            if(!object.isMesh)return;
            const position=object.geometry?.getAttribute('position'),index=object.geometry?.index;if(!position)return;
            const count=index?index.count:position.count,m=object.matrixWorld.elements;
            const point=id=>{const x=position.getX(id),y=position.getY(id),z=position.getZ(id);return [
              m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14]];};
            for(let offset=0;offset+2<count;offset+=3){
              const ids=[0,1,2].map(step=>index?index.getX(offset+step):offset+step);
              const a=point(ids[0]),b=point(ids[1]),c=point(ids[2]);
              if(Math.max(Math.abs(a[2]),Math.abs(b[2]),Math.abs(c[2]))>1e-5)continue;
              const area=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
              normalizedArea+=area;normalizedX+=(a[0]+b[0]+c[0])/3*area;normalizedY+=(a[1]+b[1]+c[1])/3*area;
            }
          });
          out.modelAnchorTransformApplied=normalizedArea>0&&Math.abs(normalizedX/normalizedArea)<1e-5&&
            Math.abs(normalizedY/normalizedArea)<1e-5&&normalizedRoot.position.length()<1e-8;
          DGR.cancelBuildingModelLoad(anchorTransaction);

          if(!window.rhino3dm){
            await new Promise((resolve,reject)=>{
              const script=document.createElement('script');script.src='/rhino3dm.js';
              script.onload=resolve;script.onerror=reject;document.head.appendChild(script);
            });
          }
          const fixtureRhino=await window.rhino3dm({locateFile:path=>path.endsWith('.wasm')?'/rhino3dm.wasm':path});
          const fixtureDoc=new fixtureRhino.File3dm(),fixtureMesh=new fixtureRhino.Mesh();
          const fixtureVertices=fixtureMesh.vertices(),fixtureFaces=fixtureMesh.faces();
          [[0,0,0],[2,0,0],[0,2,0],[0,0,2]].forEach(point=>fixtureVertices.add(...point));
          fixtureFaces.addTriFace(0,2,1);fixtureFaces.addTriFace(0,1,3);
          fixtureFaces.addTriFace(1,2,3);fixtureFaces.addTriFace(2,0,3);
          fixtureMesh.normals().computeNormals();fixtureMesh.compact();
          const fixtureAttr=new fixtureRhino.ObjectAttributes();fixtureAttr.name='3DM 가져오기 점검';
          fixtureDoc.objects().addMesh(fixtureMesh,fixtureAttr);
          const fixtureFile=new File([fixtureDoc.toByteArray()],'selftest.3dm',{type:'application/vnd.rhino'});
          const fixtureTransaction=await DGR.loadBuildingModel('__rhino_import_fixture__',fixtureFile);
          const fixtureInfo=DGR.buildingModelInfo('__rhino_import_fixture__');
          out.rhinoImport=fixtureInfo?.format==='3DM'&&fixtureInfo.meshCount>0&&fixtureInfo.size.every(Number.isFinite);
          DGR.cancelBuildingModelLoad(fixtureTransaction);
          fixtureAttr.delete?.();fixtureMesh.delete?.();fixtureDoc.destroy();

          DG.layerOpen.shadow = true; renderDGLayers();
          const oldMode = DG.sunMode;
          DG.sunMode = 'datetime'; syncDGSunUI();
          out.sunAutomaticDisabled = [...document.querySelectorAll('[data-d3-manual-sun] input')]
            .every(input => input.disabled);
          DG.sunMode = 'manual'; syncDGSunUI();
          out.sunManualEnabled = [...document.querySelectorAll('[data-d3-manual-sun] input')]
            .every(input => !input.disabled);
          DG.sunMode = oldMode; renderDGLayers();

          const savedZoom=DG.zoom;
          DG.zoom=D3_STYLE_BASE_ZOOM;
          const vectorBase=displayList(projector()).find(op=>op.layer==='등고선'&&op.w>0);
          const scaleBase=displayList(projector()).find(op=>op.layer==='축척'&&op.w>0);
          DG.zoom=D3_STYLE_BASE_ZOOM*2;
          const vectorDouble=displayList(projector()).find(op=>op.layer==='등고선'&&op.w>0);
          const scaleDouble=displayList(projector()).find(op=>op.layer==='축척'&&op.w>0);
          out.vectorLineZoom=!!vectorBase&&!!vectorDouble&&
            Math.abs(vectorDouble.w-vectorBase.w*2)<1e-6;
          out.overlayLineFixed=!!scaleBase&&!!scaleDouble&&Math.abs(scaleDouble.w-scaleBase.w)<1e-6;
          DG.zoom=savedZoom;render();

          const building = DG.scene?.buildings?.find(item => item.pnu);
          const savedSelected = DG.selected;
          if(!building || !DGR){ out.pickers = false; out.modelReplace = false; return out; }
          DG.selected = new Set([building.pnu]); DG.selectedBuilding = ''; DG.selectedBuildingInfo = null;
          renderDGLayers(); render();
          await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
          DG.zoom=D3_STYLE_BASE_ZOOM;render();
          let wideLine=null;DGR.root.traverse(item=>{if(!wideLine&&item.userData.diagramWideLine)wideLine=item;});
          const webglBase=wideLine?.material?.linewidth;
          DG.zoom=D3_STYLE_BASE_ZOOM*2;render();
          const webglDouble=wideLine?.material?.linewidth;
          out.webglLineZoom=Number.isFinite(webglBase)&&Number.isFinite(webglDouble)&&
            Math.abs(webglDouble-webglBase*2)<1e-6;
          DG.zoom=savedZoom;render();
          out.pickers = DGR._pickers.length > 0;
          const picker = DGR._pickers[0];
          const projected = picker.position.clone().project(DGR.camera);
          const rect = DGR.canvas.getBoundingClientRect();
          const hit = DGR.pickBuilding((projected.x + 1) * rect.width / 2,
            (1 - projected.y) * rect.height / 2);
          out.rayPick = !!hit?.key;
          if(hit){
            const binary = new ArrayBuffer(44), floats = new Float32Array(binary, 0, 9);
            floats.set([0,0,0, 1,0,0, 0,1,1]);
            new Uint16Array(binary, 36, 3).set([0,1,2]);
            let raw = ''; for(const byte of new Uint8Array(binary)) raw += String.fromCharCode(byte);
            const model = {asset:{version:'2.0'},buffers:[{byteLength:44,uri:'data:application/octet-stream;base64,'+btoa(raw)}],
              bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:6}],
              accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,1]},
                         {bufferView:1,componentType:5123,count:3,type:'SCALAR'}],
              meshes:[{primitives:[{attributes:{POSITION:0},indices:1}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0};
            const file = new File([JSON.stringify(model)], 'selftest.glb', {type:'model/gltf-binary'});
            const transaction = await DGR.loadBuildingModel(hit.key, file);
            DG.selectedBuilding = hit.key; DG.selectedBuildingInfo = hit; render();
            out.modelReplace = DGR.hasBuildingModel(hit.key) &&
              DGR.root.children.some(item => item.name.includes('DESIGN AREA 사용자 모델'));
            const initial=DGR.buildingModelInfo(hit.key),next={x:initial.placement.x+1.25,
              y:initial.placement.y+.75,rotation:27,scale:initial.placement.scale*1.1};
            DGR.setBuildingModelPlacement(hit.key,next);render();
            const placed=DGR.buildingModelInfo(hit.key),instance=DGR._buildingModelInstances.get(hit.key);
            out.modelPlacement=Math.abs(placed.placement.x-next.x)<1e-6&&
              Math.abs(placed.placement.y-next.y)<1e-6&&Math.abs(placed.placement.rotation-27)<1e-6&&
              !!instance&&Math.abs(instance.position.x-next.x)<1e-6&&Math.abs(instance.position.y-next.y)<1e-6;
            DGR.commitBuildingModelLoad(transaction);
            renderDGLayers();document.querySelector('[data-d3-building-clear]').click();
            out.selectionClear = DG.selectedBuilding === '' && DG.selectedBuildingInfo === null &&
              DGR.hasBuildingModel(hit.key);
            DGR.removeBuildingModel(hit.key);
            DG.selectedBuilding=hit.key;DG.selectedBuildingInfo=hit;renderDGLayers();
            document.querySelector('[data-d3-building-remove]').click();
            out.buildingRemove=DG.removedBuildings.has(hit.key)&&
              document.querySelector('[data-d3-building-remove]').textContent.includes('복원');
            document.querySelector('[data-d3-building-remove]').click();
            out.buildingRestore=!DG.removedBuildings.has(hit.key);
          } else {out.modelReplace = false;out.selectionClear = false;}

          const exportScene={name:'export-selftest',radius:10,context_bounds:[-10,-10,10,10],
            terrain_source:{source:'selftest terrain'},
            ground:{n:4,step:5,min:0,max:3,z:[
              [0,0.2,0.4,0.2,0],[0.3,0.8,1.1,0.7,0.2],[0.7,1.5,3,1.4,0.6],
              [0.2,0.8,1.4,0.9,0.3],[0,0.2,0.5,0.2,0]]},
            buildings:[
              {pnu:'A',floors:2,base:.4,rings:[[[-6,-6],[-6,-2],[-2,-2],[-2,-6],[-6,-6]]]},
              {pnu:'B',floors:1,base:1.1,rings:[[[1,1],[6,1],[6,5],[4,3],[1,5],[1,1]]],
               polygons:[[[[1,1],[6,1],[6,5],[4,3],[1,5],[1,1]],[[2,2],[3,2],[3,3],[2,3],[2,2]]]]},
            ]};
          const exportState={floorH:3.3,vScale:1,groundDepth:2,terrainMode:'natural',layers:[
            {id:'ground',on:true,fillOn:true,fill:'#ded9cc'},
            {id:'bldg',on:true,fillOn:true,fill:'#dfe3ea'},
            {id:'designBldg',on:true,fillOn:true,fill:'#e2564a'},
          ]};
          const renderModule=await import('/render3d.bundle.js?v=export-selftest');
          const savedAz=DG.az,savedEl=DG.el;
          DG.az=0;DG.el=90;
          const planProjector=projector(),planOrigin=planProjector.p(0,0,0),
            planEast=planProjector.p(10,0,0),planNorth=planProjector.p(0,10,0);
          out.webPlanAxes=planEast[0]>planOrigin[0]&&planNorth[1]<planOrigin[1];
          DG.az=savedAz;DG.el=savedEl;
          const closed=renderModule.closedBuildingGeometry(exportScene,exportState,exportScene.buildings[1]);
          const edgeCounts=new Map(),indices=closed?.index?.array||[];
          for(let i=0;i<indices.length;i+=3)for(const [a,b] of [[indices[i],indices[i+1]],[indices[i+1],indices[i+2]],[indices[i+2],indices[i]]]){
            const key=a<b?`${a}:${b}`:`${b}:${a}`;edgeCounts.set(key,(edgeCounts.get(key)||0)+1);
          }
          out.glbClosedBuilding=!!closed&&closed.groups.length===0&&[...edgeCounts.values()].every(count=>count===2);
          out.glbBuildingHole=!!closed&&closed.getAttribute('position').count>=18;
          closed?.dispose();
          const webWall=renderModule.mergedWalls(
            {...exportScene,buildings:[exportScene.buildings[0]]},exportState,new Set(),false);
          const webRoof=renderModule.mergedRoofs(
            {...exportScene,buildings:[exportScene.buildings[0]]},exportState,new Set(),false);
          const triangleDirections=(geometry,axis) => {
            if(!geometry)return [];
            const p=geometry.getAttribute('position'),index=geometry.getIndex(),result=[];
            const at=i=>[p.getX(i),p.getY(i),p.getZ(i)],count=index?index.count:p.count;
            for(let i=0;i<count;i+=3){
              const ia=index?index.getX(i):i,ib=index?index.getX(i+1):i+1,ic=index?index.getX(i+2):i+2;
              const a=at(ia),b=at(ib),c=at(ic),ab=b.map((v,k)=>v-a[k]),ac=c.map((v,k)=>v-a[k]);
              const normal=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
              result.push(axis==='z'?normal[2]:normal[0]*((a[0]+b[0]+c[0])/3+4)+normal[1]*((a[1]+b[1]+c[1])/3+4));
            }
            return result;
          };
          const wallDirections=triangleDirections(webWall,'radial'),roofDirections=triangleDirections(webRoof,'z');
          out.webBuildingFacesOutward=wallDirections.length>0&&wallDirections.every(value=>value>0)&&
            roofDirections.length>0&&roofDirections.every(value=>value>0);
          webWall?.dispose();webRoof?.dispose();
          const rhinoModule=await import('/rhino3d.bundle.js?v=export-selftest');
          const rhinoExport=await rhinoModule.buildRhino3DM(exportScene,exportState,new Set(['A']));
          const rhinoInspect=await rhinoModule.inspectRhino3DM(rhinoExport.bytes);
          out.rhinoSolidBreps=rhinoInspect.breps===3&&rhinoInspect.solidBreps===3;
          out.rhinoOutwardFaces=rhinoInspect.buildingBreps===2&&rhinoInspect.outwardBuildingBreps===2;
          out.rhinoBuildingHole=rhinoExport.stats.buildings.holedCount===1;
          out.rhinoNurbsTerrain=rhinoInspect.nurbsSurfaces===1&&rhinoExport.stats.terrain.countU>=4;
          out.rhinoTerrainDepth=rhinoExport.stats.terrain.solid&&rhinoExport.stats.terrain.depth===2&&
            rhinoInspect.names.some(name=>name.includes('두께 2.0m'));
          out.rhinoNamedObjects=rhinoInspect.names.some(name=>name.includes('DESIGN AREA 건물'))&&
            rhinoInspect.names.some(name=>name.includes('CONTEXT 건물'));
          const actualTerrainState={floorH:DG.floorH,vScale:DG.vScale,groundDepth:DG.groundDepth,
            terrainMode:'natural',layers:[
              {id:'ground',on:true,fillOn:true,fill:dLayer('ground').fill},
              {id:'bldg',on:false,fillOn:false,fill:'#dfe3ea'},
              {id:'designBldg',on:false,fillOn:false,fill:'#e2564a'},
            ]};
          const actualTerrainScene={...DG.scene,buildings:[]},terrainStarted=performance.now();
          const actualTerrainExport=await rhinoModule.buildRhino3DM(actualTerrainScene,actualTerrainState,new Set());
          const actualTerrainInspect=await rhinoModule.inspectRhino3DM(actualTerrainExport.bytes);
          out.rhinoActualTerrain=actualTerrainExport.stats.terrain.solid&&actualTerrainInspect.breps===1&&
            actualTerrainInspect.solidBreps===1&&actualTerrainInspect.nurbsSurfaces===1&&
            performance.now()-terrainStarted<60000;

          const groundLayer=dLayer('ground'),oldAerialOn=groundLayer.aerialMap,oldRenderMode=DG.renderMode;
          groundLayer.aerialMap=true;DG.renderMode='aerial';
          await loadDGAerial();
          let exportedOps=null;const savedExportSVG=DRAW.exportSVG;
          DRAW.exportSVG=(name,ops)=>{exportedOps=ops;};
          await exportSVG();DRAW.exportSVG=savedExportSVG;
          out.svgAerialImage=!!exportedOps?.some(op=>op.t==='image'&&op.layer==='위성 매핑 · 3D 렌더'&&
            (op.href||'').startsWith('data:image/png;base64,'));
          out.svgNoTerrainTriangles=!!exportedOps&&
            !exportedOps.some(op=>op.layer==='지형 · 대지'&&op.t==='poly');
          groundLayer.aerialMap=oldAerialOn;DG.renderMode=oldRenderMode;
          DG.selected = savedSelected; DG.selectedBuilding = ''; DG.selectedBuildingInfo = null;
          renderDGLayers(); render();
          return out;
        }""")
        for k, v in d3_new.items():
            check("3D " + k, v, True)

        check("자바스크립트 오류 없음", errs, [])
        b.close()


def main():
    p = argparse.ArgumentParser(description="사이트맵 자가 점검")
    p.add_argument("--site", default="제기동-954")
    p.add_argument("--server-only", action="store_true")
    p.add_argument("--browser-only", action="store_true")
    args = p.parse_args()

    print(f"대상지: {args.site}")
    if not args.browser_only:
        try:
            server_checks(args.site)
        except Exception as e:
            print(f"  !! 서버 점검 중단: {e}")
            FAILED.append("서버 점검")
    if not args.server_only:
        try:
            browser_checks(args.site)
        except Exception as e:
            print(f"  !! 브라우저 점검 중단: {e}")
            FAILED.append("브라우저 점검")

    print()
    if FAILED:
        print(f"실패 {len(FAILED)}건: " + ", ".join(FAILED))
        sys.exit(1)
    print("모두 통과")


if __name__ == "__main__":
    main()
