/* 다이어그램 탭 — 축측(axonometric) 3D 뷰.
 *
 * 캔버스 2D에 직접 그린다. 외부 3D 라이브러리를 쓰지 않는 이유:
 *   · 판넬에 넣을 다이어그램은 셰이딩된 3D보다 선이 살아 있는 축측도가 낫다
 *   · 인터넷 없이도 돌아야 한다
 *   · 화가 알고리즘(뒤에서 앞으로)이면 이 정도 면 수에서 충분히 빠르다
 *
 * 좌표는 서버가 준 그대로 미터다. 원점도 DXF와 같으므로 화면과 도면이 어긋나지 않는다.
 */

const D3_STYLE_BASE_ZOOM = 1.6;
const DESIGN_AREA_MODEL_KEY = "__design_area_model__";

const DG = {
  scene: null,
  az: 35, el: 32,          // 방위각 · 올려본 각
  zoom: D3_STYLE_BASE_ZOOM, panX: 0, panY: 0,
  floorH: 3.3,             // 층고 (실제 높이가 아니라 추정 매스)
  vScale: 1,               // 지형 수직 과장
  radius: 250, fullRadius: 0, radiusReq: 0, grid: 56, // radiusReq 0 = 수집 범위 전체
  cachedRadii: [], maxContextRadius: 900, pendingRadius: 0,
  contextBusy: false, contextProgress: 0, contextStatus: "", baseBuildingCount: 0,
  sunAz: 215, sunAlt: 45,  // 해 방향 — 남서쪽에서 비추는 것이 기본
  sunMode: "manual", sunDateTime: "", // 수동 또는 대상지·한국시간 기준 태양 위치
  crop: null, cropMode: false, scale: 2, fmt: "png",
  groundDepth: 2, terrainMode: "natural",
  renderMode: "diagram", renderQuality: "high", outline: true,
  shadowSoftness: 2.5,
  section: {on:false, az:35, position:0, color:"#b96d45"},
  layerOpen: {renderMass:true, designBldg:true, bldg:false, ground:false, shadow:false, sky:false},
  layers: [
    {id:"renderMass", name:"VWorld 실물 매스", on:false, mapping:false, caps:true, op:100},
    {id:"designBldg", name:"DESIGN AREA 건물", on:true, fill:"#e2564a", fillOn:true,
     stroke:"#8b2e2e", strokeOn:true, w:0.8, op:100},
    {id:"designGround", name:"DESIGN AREA 지형면", on:true, fill:"#f1eee6", fillOn:true,
     stroke:"#b35b52", strokeOn:true, w:0.8, op:100},
    {id:"bldg", name:"CONTEXT 건물", on:true, fill:"#dfe3ea", fillOn:true,
     stroke:"#3c4048", strokeOn:true, w:0.7, op:100},
    {id:"parcel", name:"필지", on:true, fill:"#e2564a", fillOn:false,
     stroke:"#747d8c", strokeOn:true, w:0.5, op:75},
    {id:"contour", name:"등고선", on:true, fill:"#000000", fillOn:false,
     stroke:"#a68d5e", strokeOn:true, w:0.9, op:85},
    {id:"ground", name:"지형 · 대지", on:true, fill:"#ded9cc", fillOn:true,
     stroke:"#aaa292", strokeOn:true, w:0.35, op:100, aerialMap:false, mapOpacity:85,
     gray:false, base:false, gamma:1, contrast:0, black:0, white:255},
    {id:"shadow", name:"해 · 그림자", on:true, fill:"#3f434b", fillOn:true,
     stroke:"#3f434b", strokeOn:false, w:0, op:45},
    {id:"sky", name:"하늘", on:false, zenith:"#719bc4", horizon:"#e7edf0",
     clouds:25, sunGlow:70, fixed:true},
    {id:"background", name:"바탕색", on:true, fill:"#f6f5f2", fillOn:true,
     stroke:"#f6f5f2", w:0, op:100, fixed:true},
  ],
  aerial: {source:null, raw:null, pixels:null, key:"", loading:false, radius:0,
           progress:0, phase:"", jobId:""},
  paper: true,
  dragging: false,
  selected: new Set(),
  selectedBuildings: new Set(),
  removedBuildings: new Set(), pickBuildingMode: false, modelBusy: false,
  modelPlacement: null,
  nano: {source:"",result:"",busy:false},
};

const D$ = (s) => document.querySelector(s);
const RAD = Math.PI / 180;
const dLayer = id => DG.layers.find(L => L.id === id);
const newRenderMassLayer = () => ({
  id:"renderMass",name:"VWorld 실물 매스",on:false,mapping:false,caps:true,op:100,
});
const dgPolygonGroups = item => Array.isArray(item?.polygons) && item.polygons.length
  ? item.polygons : (item?.rings || []).map(ring => [ring]);
const dgBuildingKey = (scene,building,index=0) => {
  const ring=building.rings?.[0]||[];let x=0,y=0;
  for(const p of ring){x+=p[0];y+=p[1];}
  const n=ring.length||1;
  return `${scene.name}|${building.pnu||"building"}|${(x/n).toFixed(2)},${(y/n).toFixed(2)}|${index}`;
};
const newDesignBuildingLayer = () => ({
  id:"designBldg",name:"DESIGN AREA 건물",on:true,fill:"#e2564a",fillOn:true,
  stroke:"#8b2e2e",strokeOn:true,w:.8,op:100,
});
const newDesignGroundLayer = () => ({
  id:"designGround",name:"DESIGN AREA 지형면",on:true,fill:"#f1eee6",fillOn:true,
  stroke:"#b35b52",strokeOn:true,w:.8,op:100,
});
const newSkyLayer = () => ({
  id:"sky",name:"하늘",on:false,zenith:"#719bc4",horizon:"#e7edf0",
  clouds:25,sunGlow:70,fixed:true,
});
const dgBackground = () => {
  const L=dLayer("background");
  return !L||!L.on?null:L.fill;
};

function ensureDGEnvironment(){
  if(!DG.section||typeof DG.section!=="object")DG.section={};
  const section=DG.section;
  if(section.on===undefined)section.on=false;
  if(!Number.isFinite(+section.az))section.az=DG.az;
  if(!Number.isFinite(+section.position))section.position=0;
  if(!section.color)section.color="#b96d45";
  const background=dLayer("background");
  let sky=dLayer("sky");
  if(!sky){
    sky=newSkyLayer();
    // 직전 버전에서 배경 안에 저장된 하늘 설정을 독립 레이어로 옮긴다.
    if(background){
      sky.on=background.mode==="sky";
      for(const key of ["zenith","horizon","clouds","sunGlow"])
        if(background[key]!==undefined)sky[key]=background[key];
    }
    const at=Math.max(0,DG.layers.findIndex(layer=>layer.id==="background"));
    DG.layers.splice(at,0,sky);
  }
  sky.name="하늘";sky.fixed=true;
  if(!sky.zenith)sky.zenith="#719bc4";
  if(!sky.horizon)sky.horizon="#e7edf0";
  if(!Number.isFinite(+sky.clouds))sky.clouds=25;
  if(!Number.isFinite(+sky.sunGlow))sky.sunGlow=70;
  if(background){background.name="바탕색";background.fixed=true;background.fillOn=true;background.strokeOn=false;background.w=0;background.op=100;}
}

function dgSectionMeters(){
  return (Number(DG.section?.position)||0)/100*(DG.scene?.radius||DG.radius||250);
}

function dgSyncSectionUI(){
  ensureDGEnvironment();
  const on=D$("#dg-section-on"),controls=D$("#dg-section-controls");
  if(on)on.checked=!!DG.section.on;
  if(controls)controls.hidden=!DG.section.on;
  const position=D$("#dg-section-position"),value=D$("#dg-section-position-v"),
        angle=D$("#dg-section-angle"),angleValue=D$("#dg-section-angle-v"),color=D$("#dg-section-color");
  if(position)position.value=DG.section.position;
  if(value)value.textContent=`${dgSectionMeters().toFixed(0)} m`;
  if(angle)angle.value=((+DG.section.az%360)+360)%360;
  if(angleValue)angleValue.textContent=`${Math.round(((+DG.section.az%360)+360)%360)}°`;
  if(color)color.value=DG.section.color;
}

function dgSectionToCurrentView({focusDesign=false}={}){
  ensureDGEnvironment();DG.section.az=((DG.az%360)+360)%360;
  if(focusDesign){
    const points=dgDesignPolygons().flat(2),R=DG.scene?.radius||DG.radius||250;
    if(points.length&&R){
      const angle=DG.section.az*RAD,nx=-Math.sin(angle),ny=-Math.cos(angle);
      const front=Math.max(...points.map(point=>point[0]*nx+point[1]*ny))+Math.max(2,R*.01);
      DG.section.position=Math.max(-100,Math.min(100,front/R*100));
    }
  }
  dgSyncSectionUI();render();
}
let DGR = null, DGRPromise = null, DGRError = "";

async function ensure3DRenderer() {
  if (DGR || DGRPromise) return DGRPromise;
  DGRPromise = import("/render3d.bundle.js?v=20260908-5").then(mod => {
    DGR = new mod.SiteRenderer(D$("#dgwebgl"));
    DGR.setMassStatusListener?.(({message,kind})=>{
      const status=D$("#vw3d-note");
      if(status){status.textContent=message||"";status.dataset.kind=kind||"";}
    });
    const note=D$("#dg-render-note");
    if(note) note.textContent="실시간 WebGL · 객체 통합 그림자 · 고해상도 PNG";
    if(DG.scene) render();
    return DGR;
  }).catch(e => {
    DGRError=e.message||String(e);DGRPromise=null;
    const note=D$("#dg-render-note");
    if(note) note.textContent="WebGL을 불러오지 못해 벡터 미리보기로 표시합니다: "+DGRError;
    console.error("3D renderer:",e);
    return null;
  });
  return DGRPromise;
}

// 종이 / 어두운 배경 두 벌. 색을 코드 곳곳에 흩어 두지 않는다.
const THEME = {
  paper: {
    bg: "#f6f5f2",
    groundLo: "#e9e6dd", groundHi: "#cfcabd",
    shadow: "rgba(64,66,74,.23)",
    roofLit: "#ffffff", roofDim: "#e7e6e2",
    wallLit: "#e3e2dd", wallDim: "#9b9da4",
    edge: "rgba(58,62,70,.55)", edgeSoft: "rgba(58,62,70,.22)",
    parcel: "rgba(96,100,112,.45)", contour: "rgba(140,120,86,.75)",
    ink: "#3c4048", sel: "#d94a3d",
  },
  dark: {
    bg: "#12141a",
    groundLo: "#1c1f26", groundHi: "#2c313b",
    shadow: "rgba(0,0,0,.32)",
    roofLit: "#9aa3b3", roofDim: "#6a7280",
    wallLit: "#5c6472", wallDim: "#333947",
    edge: "rgba(10,12,16,.75)", edgeSoft: "rgba(10,12,16,.35)",
    parcel: "rgba(150,160,175,.32)", contour: "rgba(196,176,128,.55)",
    ink: "#c3c8d2", sel: "#e2564a",
  },
};
const TH = () => (DG.paper ? THEME.paper : THEME.dark);

/** 색 두 개를 섞는다. mix(mix(...), ...) 처럼 중첩해서 부르므로
 *  자기가 뱉은 rgb() 문자열도 다시 읽을 수 있어야 한다. */
function rgbOf(c) {
  if (c[0] === "#") {
    const v = c.length === 4
      ? c.slice(1).split("").map(x => x + x).join("") : c.slice(1);
    const n = parseInt(v, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return c.replace(/[^\d.,]/g, "").split(",").slice(0, 3).map(Number);
}

const mix = (a, b, t) => {
  const [r1, g1, b1] = rgbOf(a), [r2, g2, b2] = rgbOf(b);
  t = Math.max(0, Math.min(1, t));
  const m = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${m(r1, r2)},${m(g1, g2)},${m(b1, b2)})`;
};

// ───────────────────────────────────────────────────────── 투영

/** 장면의 기준 높이. 화면 중심을 해발 0m가 아니라 이 대상지의 지면에 맞춘다.
 *  이걸 안 하면 북촌(해발 40~75m)처럼 높은 곳은 장면이 화면 위로 밀려 올라간다. */
function baseZ() {
  const g = DG.scene && DG.scene.ground;
  if (!g || !g.n) return 0;
  if (g._avg === undefined || g._avgMode !== DG.terrainMode) {
    // 최저·최고의 중간보다 평균이 눈에 보이는 중심에 가깝다. 지형 형태가 바뀌면 다시 구한다.
    let sum = 0, n = 0;
    for (const row of g.z) for (const v of row) { sum += terrainDisplayZ(DG.scene,v); n++; }
    g._avg = n ? sum / n : 0;
    g._avgMode = DG.terrainMode;
  }
  return g._avg * DG.vScale;
}

function projector() {
  const a = DG.az * RAD, e = DG.el * RAD;
  const ca = Math.cos(a), sa = Math.sin(a), ce = Math.cos(e), se = Math.sin(e);
  const cv = D$("#dgcanvas");
  const r = DG.radius > 0 ? DG.radius : 250;   // 0 이면 나눗셈이 깨진다
  const s = DG.zoom * Math.min(cv.clientWidth, cv.clientHeight) / (r * 2);
  const cx = cv.clientWidth / 2 + DG.panX, cy = cv.clientHeight / 2 + DG.panY;
  const z0 = baseZ();
  return {
    scale: s, z0,
    // u = 화면 가로, v = 화면 안쪽, z = 높이(기준 높이에서의 차)
    p(x, y, z) {
      const u = x * ca - y * sa;
      const v = x * sa + y * ca;
      return [cx + u * s, cy - (v * se + (z - z0) * ce) * s];
    },
    // 카메라까지의 거리. 카메라는 앞(-v)·위(+z)에 있으므로
    // v가 클수록 멀고, z가 클수록(높을수록) 가깝다. **클수록 먼 쪽**이다.
    depth(x, y, z) {
      const v = x * sa + y * ca;
      return v * ce - (z - z0) * se;
    },
  };
}

/** 해의 방향 벡터(장면 → 해). 방위각은 북(+y)에서 시계방향. */
function sunVec() {
  const a = DG.sunAz * RAD, t = DG.sunAlt * RAD;
  return [Math.sin(a) * Math.cos(t), Math.cos(a) * Math.cos(t), Math.sin(t)];
}

/** 한국 표준시(UTC+9)의 현재 시각을 datetime-local 값으로 만든다. */
function dgKSTNow() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16);
}

/**
 * NOAA의 fractional-year 근사식으로 대상지의 태양 방위·고도를 구한다.
 * 방위는 북=0°, 동=90°인 렌더러 좌표계와 같다. 입력 시각은 한국 표준시다.
 */
function dgSolarPosition(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || "");
  const center = DG.scene?.center;
  if (!match || !Array.isArray(center) || center.length < 2) return null;
  const lat = +center[0], lon = +center[1];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const year=+match[1],month=+match[2],day=+match[3],hour=+match[4],minute=+match[5];
  const dayOfYear=Math.floor((Date.UTC(year,month-1,day)-Date.UTC(year,0,1))/86400000)+1;
  const daysInYear=(year%4===0&&year%100!==0)||year%400===0?366:365;
  const localHour=hour+minute/60;
  const gamma=2*Math.PI/daysInYear*(dayOfYear-1+(localHour-12)/24);
  const eqtime=229.18*(.000075+.001868*Math.cos(gamma)-.032077*Math.sin(gamma)
    -.014615*Math.cos(2*gamma)-.040849*Math.sin(2*gamma));
  const decl=.006918-.399912*Math.cos(gamma)+.070257*Math.sin(gamma)
    -.006758*Math.cos(2*gamma)+.000907*Math.sin(2*gamma)
    -.002697*Math.cos(3*gamma)+.00148*Math.sin(3*gamma);
  let solarMinutes=(hour*60+minute+eqtime+4*lon-60*9)%1440;
  if(solarMinutes<0)solarMinutes+=1440;
  let hourAngle=solarMinutes/4-180;
  if(hourAngle < -180)hourAngle += 360;
  const latRad=lat*RAD,ha=hourAngle*RAD;
  const cosZenith=Math.max(-1,Math.min(1,
    Math.sin(latRad)*Math.sin(decl)+Math.cos(latRad)*Math.cos(decl)*Math.cos(ha)));
  const altitude=90-Math.acos(cosZenith)/RAD;
  const azimuth=(Math.atan2(Math.sin(ha),
    Math.cos(ha)*Math.sin(latRad)-Math.tan(decl)*Math.cos(latRad))/RAD+180+360)%360;
  return {azimuth,altitude,lat,lon};
}

function dgSunSummary() {
  if(DG.sunMode!=="datetime")return "슬라이더를 움직여 직접 조정할 수 있습니다.";
  const p=dgSolarPosition(DG.sunDateTime);
  if(!p)return DG.scene?"날짜와 시간을 입력해 주세요.":"대상지를 불러오면 태양 위치를 계산합니다.";
  const state=p.altitude<=0?" · 해가 진 시간이라 그림자 없음":
    p.altitude<5?" · 해가 낮아 긴 그림자는 생략":"";
  return `대상지 ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} · 방위 ${p.azimuth.toFixed(1)}° · 고도 ${p.altitude.toFixed(1)}°${state}`;
}

function syncDGSunUI() {
  const mode=D$("#dglayers [data-sun-mode]");if(mode)mode.checked=DG.sunMode==="datetime";
  const date=D$("#dglayers [data-sun-datetime]");if(date)date.value=DG.sunDateTime;
  const automatic=DG.sunMode==="datetime";
  D$("#dglayers [data-d3-manual-sun]")?.classList.toggle("disabled",automatic);
  for(const key of ["sunAz","sunAlt"]){
    const slider=D$(`#dglayers [data-shadow-k="${key}"]`),label=D$(`#dglayers [data-shadow-v="${key}"]`);
    if(slider){slider.value=DG[key];slider.disabled=automatic;}
    if(label)label.textContent=`${(+DG[key]).toFixed(1)}°`;
  }
  const result=D$("#dglayers [data-sun-result]");
  if(result){result.textContent=dgSunSummary();result.classList.toggle("night",DG.sunMode==="datetime"&&DG.sunAlt<=0);}
}

function applyDGSunDateTime(shouldRepaint=true) {
  if(!DG.sunDateTime){syncDGSunUI();return false;}
  const p=dgSolarPosition(DG.sunDateTime);
  if(!p){syncDGSunUI();return false;}
  DG.sunAz=Math.round(p.azimuth*10)/10;
  DG.sunAlt=Math.round(p.altitude*10)/10;
  syncDGSunUI();
  if(shouldRepaint){
    render();
    if(D$("#dgmodal")?.style.display==="flex")dgExportPreview();
  }
  return true;
}

function contextBounds() {
  return (DG.scene && DG.scene.context_bounds) ||
    [-DG.radius, -DG.radius, DG.radius, DG.radius];
}

/** 지형 격자의 임의 위치를 bilinear 보간한다. CONTEXT 절단면에도 같은 높이를 쓴다. */
function groundAt(x, y) {
  const g = DG.scene && DG.scene.ground;
  if (!g || !g.n) return 0;
  const R = DG.scene.radius, fx = Math.max(0, Math.min(g.n, (x + R) / g.step));
  const fy = Math.max(0, Math.min(g.n, (y + R) / g.step));
  const i = Math.min(g.n - 1, Math.floor(fx)), j = Math.min(g.n - 1, Math.floor(fy));
  const tx = fx - i, ty = fy - j;
  return g.z[j][i] * (1 - tx) * (1 - ty) + g.z[j][i + 1] * tx * (1 - ty) +
         g.z[j + 1][i] * (1 - tx) * ty + g.z[j + 1][i + 1] * tx * ty;
}

/** 장면의 등고선에서 대표 간격을 찾아 계단 지형의 층을 만든다. */
function terrainSpec(scene=DG.scene) {
  const g=scene?.ground;if(!g)return {base:0,step:5,levels:[]};
  if(g._terrainSpec)return g._terrainSpec;
  const source=[...new Set((scene.contours||[]).map(c=>+c.z).filter(Number.isFinite))].sort((a,b)=>a-b);
  const diffs=[];for(let i=1;i<source.length;i++)if(source[i]-source[i-1]>.01)diffs.push(source[i]-source[i-1]);
  const step=diffs.length?Math.min(...diffs):5,anchor=source[0]??0,levels=[];
  let z=anchor+Math.ceil((g.min-anchor)/step-1e-7)*step;
  while(z<=g.min+.01)z+=step;
  for(;z<=g.max+.01;z+=step)levels.push(Math.round(z*100)/100);
  return g._terrainSpec={base:g.min,step,levels};
}

function terrainDisplayZ(scene,z) {
  if(DG.terrainMode!=="stepped")return z;
  const spec=terrainSpec(scene);let out=spec.base;
  for(const level of spec.levels){if(z+1e-7<level)break;out=level;}
  return out;
}

function terrainHeightAt(x,y) {
  return terrainDisplayZ(DG.scene,groundAt(x,y));
}

/** 삼각형을 자연 지형의 특정 표고 이상인 볼록 다각형으로 자른다. */
function clipTerrainAbove(triangle,level) {
  const out=[];
  for(let i=0;i<triangle.length;i++){
    const a=triangle[i],b=triangle[(i+1)%triangle.length],aIn=a[2]>=level-1e-7,bIn=b[2]>=level-1e-7;
    if(aIn)out.push(a);
    if(aIn!==bIn){
      const t=(level-a[2])/(b[2]-a[2]);
      out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,level]);
    }
  }
  return out;
}

function lightAt(nx, ny, nz) {
  const S = sunVec(), L = Math.hypot(nx, ny, nz) || 1;
  const diffuse = Math.max(0, (nx * S[0] + ny * S[1] + nz * S[2]) / L);
  // 완전한 검정이 되지 않는 주변광 + 모든 면에 적용되는 확산광.
  return 0.30 + diffuse * 0.70;
}

function litColor(color, light) {
  return light < .58 ? mix(color, "#11151c", (.58 - light) * .72)
                     : mix(color, "#ffffff", (light - .58) * .28);
}

/** 위성사진을 장면 좌표에서 샘플링한다. 이미지 위쪽은 북(+y)이다. */
function aerialAt(x, y) {
  const A = DG.aerial, px = A.pixels;
  if (!groundAerialOn() || !px) return null;
  // 사진이 덮는 반경은 장면 반경과 다를 수 있다 (서버가 줄여서 줬을 때).
  // 장면 반경으로 읽으면 사진이 늘어나 모델과 어긋난다.
  const R = A.radius || DG.scene.radius;
  if (Math.abs(x) > R || Math.abs(y) > R) return null;      // 사진 밖은 안 칠한다
  const ix = Math.max(0, Math.min(px.w - 1, Math.round((x + R) / (2 * R) * (px.w - 1))));
  const iy = Math.max(0, Math.min(px.h - 1, Math.round((R - y) / (2 * R) * (px.h - 1))));
  const at = (iy * px.w + ix) * 4, d = px.data;
  return `rgb(${d[at]},${d[at + 1]},${d[at + 2]})`;
}

function mappedColor(base, x, y, light, mapOn=true) {
  const photo = mapOn ? aerialAt(x, y) : null, ground = dLayer("ground");
  const c = photo ? mix(base, photo, (ground.mapOpacity ?? 85) / 100) : base;
  return litColor(c, light);
}

function groundAerialOn(){
  const ground=dLayer("ground");
  return !!ground?.on&&ground.aerialMap!==false;
}

// ───────────────────────────────────────────────────────── 그리기

function poly(ctx, pts, fill, stroke, w) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = w || 1; ctx.stroke(); }
}

/** 링이 반시계인지. 바깥쪽 법선을 제대로 잡으려면 방향을 알아야 한다. */
function ccw(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const next = ring[(i + 1) % ring.length];
    s += ring[i][0] * next[1] - next[0] * ring[i][1];
  }
  return s > 0;
}

/** GIS 원본의 CW/CCW 차이를 없애 웹 미리보기와 3D 내보내기의 면 방향을 맞춘다. */
function displayBuildingRing(source,counterClockwise=true) {
  const ring=(source||[]).filter(p=>Array.isArray(p)&&Number.isFinite(+p[0])&&Number.isFinite(+p[1]))
    .map(p=>[+p[0],+p[1]]);
  if(ring.length>1&&Math.hypot(ring[0][0]-ring.at(-1)[0],ring[0][1]-ring.at(-1)[1])<1e-7)ring.pop();
  if(ring.length<3)return [];
  if(ccw(ring)!==counterClockwise)ring.reverse();
  ring.push([...ring[0]]);
  return ring;
}

/** 지형 격자 → 삼각형.
 *
 *  격자 한 칸을 사각형 하나로 그리면 안 된다. 네 꼭짓점 높이가 다르면
 *  그 사각형은 **평면이 아니라서** 어떻게 칠해도 실제 지형과 다르다.
 *  삼각형은 세 점이므로 언제나 평면이다. 한 칸을 둘로 쪼갠다.
 *
 *  쪼개는 방향은 두 대각선 중 **높이차가 작은 쪽**을 고른다.
 *  안장 모양 칸에서 엉뚱한 능선이 생기는 것을 줄인다.
 */
function groundFaces(P, out) {
  const g = DG.scene.ground, Lr = dLayer("ground");
  if (!g || !g.n || !Lr.on) return;
  const R = DG.scene.radius, n = g.n, st = g.step, bounds = contextBounds();
  const span = Math.max(0.001, g.max - g.min);
  const vs = DG.vScale;
  const designLayer=dLayer("designGround"),designPolygons=dgDesignPolygons();
  const styleAt=(x,y)=>{
    const inside=designPolygons.some(polygon=>dgPointInPolygon([x,y],polygon));
    return {inside,layer:inside&&designLayer?.on?designLayer:Lr,
      id:inside&&designLayer?.on?"DESIGN AREA 지형면":"지형 · 대지"};
  };

  const face = (points,hole=null) => {
    if(points.length<3)return;
    const mz=points.reduce((s,p)=>s+p[2],0)/points.length;
    const mx=points.reduce((s,p)=>s+p[0],0)/points.length,my=points.reduce((s,p)=>s+p[1],0)/points.length;
    const style=styleAt(mx,my),layer=style.layer;
    const base=mix(layer.fill,"#ffffff",(mz-g.min)/span*.10);
    const projected=points.map(p=>P.p(p[0],p[1],p[2]*vs));
    const projectedHole=hole&&hole.length>=3?hole.map(p=>P.p(p[0],p[1],p[2]*vs)):null;
    out.push({d:P.depth(mx,my,mz*vs),pts:projected,rings:projectedHole?[projected,projectedHole]:null,
      fill:(layer.fillOn||(!style.inside&&groundAerialOn()))
        ?mappedColor(base,mx,my,lightAt(0,0,1),!style.inside):null,
      stroke:layer.strokeOn!==false?layer.stroke:null,strokeOn:layer.strokeOn!==false,
      w:layer.w,opacity:layer.op/100,layer:style.id});
  };
  const tri = (a, b, c) => {
    if(DG.terrainMode==="stepped"){
      const triangle=[a,b,c],spec=terrainSpec(),cuts=[spec.base,...spec.levels];
      for(let k=0;k<cuts.length;k++){
        const lower=clipTerrainAbove(triangle,cuts[k]);if(lower.length<3)continue;
        const upper=k+1<cuts.length?clipTerrainAbove(triangle,cuts[k+1]):[];
        const top=cuts[k],low=lower.map(p=>[p[0],p[1],top]);
        const hole=upper.map(p=>[p[0],p[1],top]);
        face(low,hole);
      }
      for(let k=1;k<cuts.length;k++){
        const level=cuts[k],above=clipTerrainAbove(triangle,level);
        const crossings=[];
        for(const p of above)if(Math.abs(p[2]-level)<1e-5&&
          !crossings.some(q=>Math.hypot(q[0]-p[0],q[1]-p[1])<1e-5))crossings.push(p);
        if(crossings.length<2)continue;
        let p0=crossings[0],p1=crossings[1],far=0;
        for(let u=0;u<crossings.length;u++)for(let v=u+1;v<crossings.length;v++){
          const d=Math.hypot(crossings[u][0]-crossings[v][0],crossings[u][1]-crossings[v][1]);
          if(d>far){far=d;p0=crossings[u];p1=crossings[v];}
        }
        const low=cuts[k-1],mx=(p0[0]+p1[0])/2,my=(p0[1]+p1[1])/2;
        const style=styleAt(mx,my),layer=style.layer;
        out.push({d:P.depth(mx,my,(low+level)*vs/2),
          pts:[P.p(p0[0],p0[1],low*vs),P.p(p1[0],p1[1],low*vs),
               P.p(p1[0],p1[1],level*vs),P.p(p0[0],p0[1],level*vs)],
          fill:(layer.fillOn||(!style.inside&&groundAerialOn()))
            ?mappedColor(layer.fill,mx,my,.48,!style.inside):null,
          stroke:layer.strokeOn!==false?layer.stroke:null,strokeOn:layer.strokeOn!==false,
          w:layer.w,opacity:layer.op/100,layer:style.id});
      }
      return;
    }
    // 실제 삼각형 법선 — 면마다 제 기울기로 음영이 잡힌다
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = (b[2] - a[2]) * vs;
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = (c[2] - a[2]) * vs;
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }      // 법선은 위를 보게
    const lit = lightAt(nx, ny, nz);
    const mz = (a[2] + b[2] + c[2]) / 3;
    const h = (mz - g.min) / span;
    const mx = (a[0] + b[0] + c[0]) / 3, my = (a[1] + b[1] + c[1]) / 3;
    const style=styleAt(mx,my),layer=style.layer;
    const base = mix(layer.fill, "#ffffff", h * .10);
    out.push({
      d: P.depth(mx, my, mz * vs),
      pts: [P.p(a[0], a[1], a[2] * vs), P.p(b[0], b[1], b[2] * vs),
            P.p(c[0], c[1], c[2] * vs)],
      fill: (layer.fillOn || (!style.inside&&groundAerialOn()))
        ? mappedColor(base, mx, my, lit, !style.inside) : null,
      stroke: layer.strokeOn !== false ? layer.stroke : null,
      strokeOn: layer.strokeOn !== false, w: layer.w, opacity: layer.op / 100,
      layer:style.id,
    });
  };

  for (let j = 0; j < n; j++) {
    const y0 = -R + j * st, y1 = y0 + st;
    for (let i = 0; i < n; i++) {
      // CONTEXT가 정사각형보다 좁으면 가장자리 셀 자체를 정확한 경계에서 자른다.
      const x0 = Math.max(-R + i * st, bounds[0]), x1 = Math.min(-R + (i + 1) * st, bounds[2]);
      const yy0 = Math.max(y0, bounds[1]), yy1 = Math.min(y1, bounds[3]);
      if (x1 <= x0 || yy1 <= yy0) continue;
      const p00 = [x0, yy0, groundAt(x0, yy0)], p10 = [x1, yy0, groundAt(x1, yy0)];
      const p11 = [x1, yy1, groundAt(x1, yy1)], p01 = [x0, yy1, groundAt(x0, yy1)];
      if (Math.abs(p00[2] - p11[2]) <= Math.abs(p10[2] - p01[2])) {
        tri(p00, p10, p11); tri(p00, p11, p01);
      } else {
        tri(p00, p10, p01); tri(p10, p11, p01);
      }
    }
  }
}

/** 지형 외곽에 아래로 내린 수직면을 붙여 대지 콘타의 실제 두께를 만든다. */
function terrainSlabFaces(P, out) {
  const g = DG.scene.ground, Lr = dLayer("ground");
  if (!g || !g.n || !Lr.on || DG.groundDepth <= 0) return;
  const [x0, y0, x1, y1] = contextBounds(), vs = DG.vScale;
  const bottom = g.min * vs - DG.groundDepth;
  const edges = [
    [[x0,y0],[x1,y0],[0,-1]], [[x1,y0],[x1,y1],[1,0]],
    [[x1,y1],[x0,y1],[0,1]], [[x0,y1],[x0,y0],[-1,0]],
  ];
  for (const [a, b, normal] of edges) {
    const count = Math.max(1, Math.ceil(Math.hypot(b[0]-a[0], b[1]-a[1]) / g.step));
    for (let i = 0; i < count; i++) {
      const t0 = i / count, t1 = (i + 1) / count;
      const ax = a[0] + (b[0]-a[0]) * t0, ay = a[1] + (b[1]-a[1]) * t0;
      const bx = a[0] + (b[0]-a[0]) * t1, by = a[1] + (b[1]-a[1]) * t1;
      const za = terrainHeightAt(ax,ay) * vs, zb = terrainHeightAt(bx,by) * vs;
      const mx = (ax+bx)/2, my = (ay+by)/2;
      out.push({
        d:P.depth(mx,my,(za+zb+bottom*2)/4),
        pts:[P.p(ax,ay,bottom),P.p(bx,by,bottom),P.p(bx,by,zb),P.p(ax,ay,za)],
        fill:(Lr.fillOn || groundAerialOn())
          ? mappedColor(Lr.fill,mx,my,lightAt(normal[0],normal[1],0)) : null,
        stroke:Lr.strokeOn !== false ? Lr.stroke : null,
        strokeOn:Lr.strokeOn !== false,w:Math.max(.35,Lr.w),opacity:Lr.op/100,
      });
    }
  }
}

/** 건물이 지면에 드리우는 그림자. 매스가 땅에 붙어 보이게 하는 가장 값싼 방법. */
function shadowOps(P, ops) {
  const sh = dLayer("shadow");
  if (!sh.on) return;
  const S = sunVec();
  if (S[2] < 0.08) return;                     // 해가 너무 낮으면 그림자가 화면을 덮는다
  const kx = S[0] / S[2], ky = S[1] / S[2], fill = sh.fill;
  for (const [buildingIndex,b] of DG.scene.buildings.entries()) {
    if(DG.removedBuildings.has(dgBuildingKey(DG.scene,b,buildingIndex)))continue;
    const bl=dLayer(DG.selected.has(b.pnu)?"designBldg":"bldg");
    if(!bl?.on)continue;
    const base = terrainDisplayZ(DG.scene,b.base||0) * DG.vScale;
    const h = (b.floors > 0 ? b.floors : 1) * DG.floorH;
    const objectShadow = [];
    for (const ring of b.rings) {
      if(!sh.fillOn) continue;
      const shifted = ring.map(p => [p[0] - h * kx, p[1] - h * ky]);
      objectShadow.push(shifted.map(p => P.p(p[0],p[1],base+.06)));
      for (let i = 0; i < ring.length - 1; i++)
        objectShadow.push([
          P.p(ring[i][0],ring[i][1],base+.06),P.p(ring[i+1][0],ring[i+1][1],base+.06),
          P.p(shifted[i+1][0],shifted[i+1][1],base+.06),P.p(shifted[i][0],shifted[i][1],base+.06)]);
    }
    // 한 건물의 지붕·연결 벽을 한 compound path로 한 번만 채운다.
    // 같은 객체 안의 조각이 포개져도 알파가 중복 누적되지 않는다.
    if(objectShadow.length) ops.push({t:"poly",fill,opacity:sh.op/100,layer:"그림자",
      rings:objectShadow,fillRule:"nonzero"});
  }
}

/** 건물 매스 — 한 채(링 하나)를 벽+지붕 묶음으로 만든다.
 *
 *  면을 전부 한 배열에 섞어 정렬하면 안 된다. ㄱ자·ㄷ자처럼 오목한 평면에서는
 *  안쪽 모서리의 벽이 **자기 지붕 위로 투영**되는데, 면마다 깊이값 하나로 정렬하면
 *  그 벽이 지붕보다 나중에 그려져 건물에 구덩이가 파인 것처럼 보인다.
 *  한 채 안에서는 순서가 정해져 있다 — 위에서 내려다보는 한 **벽을 먼저, 지붕을 나중에**.
 */
function buildingMasses(P, out) {
  const t = TH();
  const a = DG.az * RAD;
  const vx = Math.sin(a), vy = Math.cos(a);   // 화면 안쪽(+v)의 세계좌표 방향

  for (const [buildingIndex,b] of DG.scene.buildings.entries()) {
    const design=DG.selected.has(b.pnu),Lr=dLayer(design?"designBldg":"bldg");
    if(!Lr?.on)continue;
    if(DG.removedBuildings.has(dgBuildingKey(DG.scene,b,buildingIndex)))continue;
    const base = terrainDisplayZ(DG.scene,b.base||0) * DG.vScale;
    const h = (b.floors > 0 ? b.floors : 1) * DG.floorH;
    const top = base + h;
    const objectSelected=DG.selectedBuildings.has(dgBuildingKey(DG.scene,b,buildingIndex));

    for (const polygon of dgPolygonGroups(b)) {
      const rings=polygon.map((source,index)=>displayBuildingRing(source,index===0))
        .filter(ring=>ring.length>=4);
      if(!rings.length)continue;
      const walls = [];
      for(const ring of rings){
        const dir = ccw(ring) ? 1 : -1;
        for (let i = 0; i < ring.length - 1; i++) {
          const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
          const ex = x2 - x1, ey = y2 - y1;
          const L = Math.hypot(ex, ey) || 1;
          const nx = (ey / L) * dir, ny = (-ex / L) * dir;
          if (nx * vx + ny * vy >= 0) continue;
          const lit = lightAt(nx, ny, 0);
          const mx = (x1+x2)/2, my = (y1+y2)/2;
          walls.push({
            d: P.depth(mx, my, (base + top) / 2),
            pts: [P.p(x1, y1, base), P.p(x2, y2, base), P.p(x2, y2, top), P.p(x1, y1, top)],
            fill: objectSelected ? litColor(t.sel, lit) :
              (Lr.fillOn ? litColor(Lr.fill,lit) : null),
          });
        }
      }
      walls.sort((p, q) => q.d - p.d);        // 한 채 안에서도 먼 벽부터

      const ring=rings[0];
      let cx = 0, cy = 0;
      for (const p of ring) { cx += p[0]; cy += p[1]; }
      cx /= ring.length; cy /= ring.length;

      out.push({
        d: P.depth(cx, cy, base),             // 채끼리는 발밑 기준으로 줄 세운다
        walls,
        roofRings: rings.map(source=>source.map(p => P.p(p[0], p[1], top))),
        roofFill: objectSelected ? t.sel : (Lr.fillOn
          ? litColor(Lr.fill,lightAt(0,0,1)) : null),
        opacity: Lr.op / 100,
        stroke:objectSelected?t.sel:(Lr.strokeOn !== false ? Lr.stroke : null), w:objectSelected?Math.max(1.5,Lr.w):Lr.w,
        layer:design?"DESIGN AREA 건물":"CONTEXT 건물",
      });
    }
  }
}

function flatLineOps(P, ops) {
  const sc = DG.scene, t = TH(), parcel = dLayer("parcel"), contour = dLayer("contour");
  if (parcel.on) {
    for (const p of sc.parcels) {
      const z = terrainDisplayZ(DG.scene,p.base||0) * DG.vScale + 0.05;
      const on = DG.selected.size && DG.selected.has(p.pnu);
      for (const polygon of dgPolygonGroups(p))
        ops.push({ t: "poly", rings:polygon.map(ring=>ring.map(q=>P.p(q[0],q[1],z))),
                   fillRule:"evenodd",
                   fill: on ? "rgba(217,74,61,.28)" : (parcel.fillOn ? parcel.fill : null),
                   stroke: on ? t.sel : (parcel.strokeOn !== false ? parcel.stroke : null),
                   w: on ? Math.max(1.8,parcel.w) : parcel.w,
                   opacity: parcel.op / 100, layer:"필지" });
    }
  }
  if (contour.on && contour.strokeOn !== false && sc.contours.length) {
    for (const c of sc.contours) {
      ops.push({ t: "path", pts: c.pts.map(q => P.p(q[0], q[1],
                   (DG.terrainMode==="stepped"?c.z:groundAt(q[0],q[1]))*DG.vScale+.1)),
                 stroke: contour.stroke, w: contour.w, opacity:contour.op/100,
                 layer:"등고선" });
    }
  }
}

// ─────────────────────────────────────────── 뷰큐브
//
// 방위표 대신. 면·모서리·꼭짓점을 누르면 그 방향에서 본 시점으로 간다.
// 아이소·배치·입면 버튼이 하는 일을 전부 여기서 한다.

const CUBE_R = 34, CUBE_PAD = 68, CUBE_TURN_STEP = 90;

/** 스냅 지점 17개 — 옆면 8방위(dz=0) + 위쪽 9방위(dz=1). 밑에서는 보지 않는다. */
const CUBE_AIMS = (() => {
  const a = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = 0; dz <= 1; dz++)
        if (dx || dy || dz) a.push([dx, dy, dz]);
  return a;
})();

const CUBE_FACES = [
  { n: [0, -1, 0], label: "남", c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { n: [0, 1, 0], label: "북", c: [[1, 1, -1], [-1, 1, -1], [-1, 1, 1], [1, 1, 1]] },
  { n: [1, 0, 0], label: "동", c: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { n: [-1, 0, 0], label: "서", c: [[-1, 1, -1], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1]] },
  { n: [0, 0, 1], label: "평면", c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], label: "", c: [[-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1]] },
];

/** 그 방향에서 볼 때의 방위각·앙각. 카메라는 장면에서 d 방향에 선다.
 *
 *  꼭대기 면(평면)만 예외다. 옆으로 치우친 방향이 없어서 방위각을 정할 근거가
 *  없는데, 보던 각도를 그대로 두면 **북쪽이 위가 아닌 평면**이 나온다.
 *  도면으로 쓸 평면은 북쪽이 위여야 하므로 정북(0°)·수직(90°)으로 맞춘다.
 */
function aimOf(d) {
  const [dx, dy, dz] = d;
  if (!dx && !dy) return [0, 90];                    // 정북 · 바로 위에서
  const L = Math.hypot(dx, dy, dz);
  const el = Math.max(2, Math.min(90, Math.asin(dz / L) / RAD));
  const az = ((Math.atan2(-dx, -dy) / RAD) + 360) % 360;
  return [az, el];
}

let dgCubeAnimFrame=0, dgCubeAnimTarget=null;

function stopDGCubeAnimation() {
  if(dgCubeAnimFrame)cancelAnimationFrame(dgCubeAnimFrame);
  dgCubeAnimFrame=0;dgCubeAnimTarget=null;
}

function syncDGViewAngleUI() {
  const input=D$("#dg-el"),label=D$("#dg-elv");
  if(input)input.value=Math.round(DG.el);
  if(label)label.textContent=Math.round(DG.el)+"°";
}

/** 뷰큐브 스냅은 최단 회전으로 가속했다가 부드럽게 멈춘다. */
function animateDGCubeView(targetAz,targetEl) {
  stopDGCubeAnimation();
  dgCubeAnimTarget={az:targetAz,el:targetEl};
  const startAz=DG.az,startEl=DG.el;
  const deltaAz=((targetAz-startAz+540)%360)-180;
  const deltaEl=targetEl-startEl;
  if(Math.hypot(deltaAz,deltaEl)<.1){
    DG.az=targetAz;DG.el=targetEl;dgCubeAnimTarget=null;
    syncDGViewAngleUI();render();return;
  }
  const started=performance.now(),duration=1100;
  const step=now=>{
    const t=Math.min(1,(now-started)/duration);
    // 코사인 보간은 속도가 중간 한순간에 몰리지 않아 무거운 장면에서도 회전이 계속 보인다.
    const eased=.5-Math.cos(Math.PI*t)/2;
    DG.az=startAz+deltaAz*eased;
    DG.el=startEl+deltaEl*eased;
    syncDGViewAngleUI();render();
    if(t<1)dgCubeAnimFrame=requestAnimationFrame(step);
    else{
      dgCubeAnimFrame=0;DG.az=targetAz;DG.el=targetEl;
      dgCubeAnimTarget=null;
      syncDGViewAngleUI();render();
    }
  };
  dgCubeAnimFrame=requestAnimationFrame(step);
}

function cubeGeom() {
  const cv = D$("#dgcanvas");
  const a = DG.az * RAD, e = DG.el * RAD;
  const ca = Math.cos(a), sa = Math.sin(a), ce = Math.cos(e), se = Math.sin(e);
  const cx = cv.clientWidth - CUBE_PAD, cy = CUBE_PAD;
  return {
    cx, cy,
    cam: [-sa * ce, -ca * ce, se],          // 장면 → 카메라 방향
    p(q) {
      const u = q[0] * ca - q[1] * sa;
      const v = q[0] * sa + q[1] * ca;
      return [cx + u * CUBE_R, cy - (v * se + q[2] * ce) * CUBE_R];
    },
  };
}

/** 평면일 때만 보이는 시계방향 90° 회전 버튼. */
function cubeTurnButton() {
  if(DG.el<88)return null;
  const G=cubeGeom();
  return {x:G.cx+CUBE_R+12,y:G.cy-CUBE_R-12,r:12};
}

function cubeTurnHit(mx,my) {
  const b=cubeTurnButton();
  return !!b&&Math.hypot(mx-b.x,my-b.y)<=b.r+4;
}

function turnDGPlanClockwise() {
  const pending=dgCubeAnimTarget&&Math.abs(dgCubeAnimTarget.el-90)<.1
    ? dgCubeAnimTarget.az:DG.az;
  const targetAz=(pending-CUBE_TURN_STEP+360)%360;
  animateDGCubeView(targetAz,90);
}

function cubeOps(ops) {
  const t = TH(), G = cubeGeom();
  const faces = CUBE_FACES
    .map(f => ({ ...f, dot: f.n[0] * G.cam[0] + f.n[1] * G.cam[1] + f.n[2] * G.cam[2] }))
    .filter(f => f.dot > 0.001)
    .sort((p, q) => p.dot - q.dot);

  for (const f of faces) {
    ops.push({ t: "poly", pts: f.c.map(G.p),
               fill: mix(t.wallDim, t.roofLit, 0.35 + 0.55 * f.dot), stroke: t.edge, w: 1 });
    if (!f.label) continue;
    const c = G.p(f.n.map(v => v * 0.98));
    ops.push({ t: "text", x: c[0], y: c[1], s: f.label, size: 11, fill: t.ink });
  }
  // 바로 위에서 보면 옆면이 전부 사라져 방위를 알려 줄 글자가 없다. 북쪽만 찍어 준다.
  if (faces.length === 1 && faces[0].n[2] === 1) {
    const nk = G.p([0, 0.72, 1]);
    ops.push({ t: "text", x: nk[0], y: nk[1], s: "북", size: 10, fill: t.ink });
  }
  const turn=cubeTurnButton();
  if(turn){
    ops.push({t:"dot",x:turn.x,y:turn.y,r:turn.r,
      fill:DG.cubeTurnHover?t.sel:mix(t.wallDim,t.roofLit,.55),stroke:t.edge,w:1});
    ops.push({t:"text",x:turn.x,y:turn.y-.5,s:"↻",size:17,
      weight:500,fill:DG.cubeTurnHover?"#ffffff":t.ink});
  }
  if (DG.cubeHover) {                       // 마우스가 올라간 스냅 지점
    const s = G.p(DG.cubeHover);
    ops.push({ t: "dot", x: s[0], y: s[1], r: 6, fill: t.sel });
  }
}

/** 화면 좌표가 뷰큐브의 어느 스냅 지점에 가까운지. 없으면 null. */
function cubeHit(mx, my) {
  const G = cubeGeom();
  if (Math.hypot(mx - G.cx, my - G.cy) > CUBE_R * 2.1) return null;
  let best = null, bd = 22;
  for (const d of CUBE_AIMS) {
    const dot = d[0] * G.cam[0] + d[1] * G.cam[1] + d[2] * G.cam[2];
    if (dot <= 0.02) continue;                       // 뒤쪽 지점은 고르지 않는다
    const s = G.p(d);
    const dist = Math.hypot(mx - s[0], my - s[1]);
    if (dist < bd) { bd = dist; best = d; }
  }
  return best;
}

function scaleOps(P, ops) {
  const cv = D$("#dgcanvas"), t = TH();
  const px = 100 * P.scale, x0 = 22, y0 = cv.clientHeight - 26;
  ops.push({ t: "path", pts: [[x0, y0], [x0 + px, y0]], stroke: t.ink, w: 1.4, layer:"축척" });
  ops.push({ t: "path", pts: [[x0, y0 - 4], [x0, y0 + 4]], stroke: t.ink, w: 1.4, layer:"축척" });
  ops.push({ t: "path", pts: [[x0 + px, y0 - 4], [x0 + px, y0 + 4]], stroke: t.ink, w: 1.4, layer:"축척" });
  ops.push({ t: "text", x: x0 + px + 8, y: y0, s: "100 m", size: 11, weight: 400,
             fill: t.ink, anchor: "left", layer:"축척" });
}

/** 그릴 것을 순서대로 목록에 담는다. 캔버스로도, SVG로도 같은 목록을 쓴다. */
function displayList(P, opts = {}) {
  const t = TH(), ops = [];
  const ground = [], masses = [];
  groundFaces(P, ground);
  terrainSlabFaces(P, ground);
  buildingMasses(P, masses);
  // depth는 카메라까지의 거리이므로 **내림차순**이 먼 것부터다.
  ground.sort((a, b) => b.d - a.d);
  masses.sort((a, b) => b.d - a.d);

  // 면끼리 맞닿은 자리에 배경색 실선이 비치는 것을 막으려고 같은 색으로 한 겹 두른다.
  // 삼각형이라 접선이 사각형 때보다 두 배 많아 눈에 띈다.
  for (const f of ground)
    ops.push({ t: "poly", pts: f.pts, rings:f.rings, fill: f.fill,
               // 선을 끄면 채움색의 아주 얇은 이음선만 남겨 캔버스 흰 실금을 막는다.
               stroke: f.strokeOn ? f.stroke : f.fill, w: f.strokeOn ? f.w : .35,
               opacity:f.opacity, layer:"지형 · 대지" });
  flatLineOps(P, ops);                      // 필지·등고선은 지면 위
  shadowOps(P, ops);                        // 그림자는 그 위, 매스 아래

  // 한 채씩 — 벽을 먼저 다 그리고 지붕을 덮는다
  for (const m of masses) {
    for (const wl of m.walls)
      ops.push({ t: "poly", pts: wl.pts, fill: wl.fill, stroke: m.stroke,
                 w:Math.max(.25,m.w*.55),opacity:m.opacity,layer:m.layer });
    ops.push({ t: "poly", rings:m.roofRings, fillRule:"evenodd", fill: m.roofFill,
               stroke: m.stroke, w:m.w,opacity:m.opacity,layer:m.layer });
  }

  // 레이어 선은 장면에 붙은 도면 요소이므로 뷰 줌과 함께 변해야 한다.
  // 축척 막대·뷰큐브·크롭 틀은 이 뒤에 추가해 화면 조작용 크기를 그대로 유지한다.
  const styleScale=Math.max(.01,DG.zoom/D3_STYLE_BASE_ZOOM);
  for(const op of ops)if(Number.isFinite(+op.w)&&+op.w>0)op.w*=styleScale;

  scaleOps(P, ops);
  if (!opts.forExport) {                    // 뷰큐브·크롭틀은 조작 장치라 저장본에 넣지 않는다
    cubeOps(ops);
    const cv = D$("#dgcanvas");
    ops.push(...DRAW.cropOverlay(DG.crop, cv.clientWidth, cv.clientHeight, TH().sel));
  }
  return ops;
}

/** 내보내기에 넘길 화면 정보 */
function dgView(scale) {
  const cv = D$("#dgcanvas");
  return { w: cv.clientWidth, h: cv.clientHeight, bg: dgBackground(),
           crop: DG.crop, scale: scale || 1 };
}

function dgSetCrop(c) {
  DG.crop = c;
  D$("#dgm-crop").classList.toggle("on", DG.cropMode);
  D$("#dgm-cropoff").disabled = !c;
  D$("#dgcropinfo").textContent = c
    ? `내보낼 범위 ${Math.round(c.w)} × ${Math.round(c.h)} px` +
      ` → PNG ${Math.round(c.w * DG.scale)} × ${Math.round(c.h * DG.scale)}` +
      (DG.cropMode ? " · Enter로 확정" : "")
    : "범위를 지정하지 않으면 화면 전체가 나갑니다.";
  render();
}

function dgFinishCrop() {
  if (!DG.cropMode) return;
  DG.cropMode = false; dgSetCrop(DG.crop);
  D$("#dgmodal").style.display = "flex";
  dgExportPreview();
}

function renderDGInfo() {
  const el=D$("#dginfo"),sc=DG.scene;
  if(!el)return;
  if(!sc){el.textContent="대상지를 먼저 고르세요.";return;}
  const withFloors=(sc.buildings||[]).filter(b=>b.floors>0).length;
  const terrainSource=sc.terrain_source?.label||"";
  const dropped=(sc.warnings||[]).reduce((sum,item)=>
    sum+(+item.invalid_geometry||0)+(+item.clip_errors||0),0);
  el.innerHTML =
    `<div class="t">${DRAW.esc(sc.name)}</div>` +
    `필지 <b>${(sc.parcels||[]).length}</b> · ` +
    `건물 <b>${(sc.buildings||[]).length}</b> ` +
    `<span>(층수 확인 ${withFloors})</span><br>` +
    (sc.has_terrain
      ? `지형 <b>${sc.ground.min}~${sc.ground.max}m</b>`+
        (terrainSource?` <span>· ${DRAW.esc(terrainSource)}</span>`:"")
      : `<span style="color:#e0b088">지형 없음</span>`) +
    (dropped?`<br><span class="data-warning">해석 제외 도형 ${dropped.toLocaleString()}건</span>`:"") +
    (DG.aerial.loading ? `<div class="aerial-progress">
      <div class="aerial-progress-head"><span>${DRAW.esc(DG.aerial.phase || "위성사진 준비 중")}</span>
      <b>${Math.round(DG.aerial.progress || 0)}%</b></div>
      <progress max="100" value="${DG.aerial.progress || 0}"></progress></div>` : "");
}

function render() {
  const cv = D$("#dgcanvas");
  if (!cv || !DG.scene) return;
  // 처음 한 번 실패했더라도 다음 진입·조작 때 다시 시도한다. 실행 중이던 옛 서버를
  // 새 서버로 바꾼 직후에는 첫 요청만 404가 날 수 있는데, 그 상태에 갇히면 안 된다.
  if (!DGR && !DGRPromise) ensure3DRenderer();
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = "round"; ctx.lineCap = "round";

  if (DGR) {
    D$("#dgwebgl").style.display="block";
    DGR.render(DG.scene,DG,DG.aerial.raw,DG.selected);
    // WebGL 위에는 조작용 뷰큐브·스케일·크롭 틀만 투명 캔버스로 올린다.
    const P=projector(),overlay=[];scaleOps(P,overlay);cubeOps(overlay);
    overlay.push(...DRAW.cropOverlay(DG.crop,w,h,TH().sel));
    DRAW.paintCanvas(ctx,overlay);
  } else {
    D$("#dgwebgl").style.display="none";
    const bg=dgBackground();if(bg){ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);}
    DRAW.paintCanvas(ctx,displayList(projector()));
  }

  renderDGInfo();
}

const dgStem = () => (DG.scene ? DG.scene.name : "다이어그램") +
  "_다이어그램" + (DG.crop ? "_부분" : "");

async function dgAerialSVGImage() {
  if(!needsDGRasterMapping())return null;
  if(DG.aerial.loading){alert("위성사진을 모두 받은 뒤 SVG를 내보내 주세요.");return false;}
  if(needsDGAerial()&&!DG.aerial.raw)await loadDGAerial();
  if(needsDGAerial()&&!DG.aerial.raw)return null;
  const renderer=DGR||await ensure3DRenderer();
  if(!renderer){alert("위성사진이 매핑된 SVG에는 WebGL 렌더러가 필요합니다.");return false;}
  const cv=D$("#dgwebgl"),state={...DG,selectedBuildings:new Set(),outline:false,
    layers:DG.layers.map(layer=>({...layer}))};
  // 사진이 실제로 붙는 면과 그림자만 투명 배경에 렌더한다. 필지·등고선·축척은
  // 아래 exportSVG에서 원래 벡터를 그대로 얹어 Illustrator 편집성을 남긴다.
  for(const layer of state.layers){
    if(layer.id==="background")layer.on=false;
    if(layer.id==="parcel"||layer.id==="contour")layer.on=false;
    if(layer.id==="ground"||layer.id==="bldg"||layer.id==="designBldg")layer.strokeOn=false;
  }
  try{
    renderer.render(DG.scene,state,DG.aerial.raw,DG.selected);
    return {t:"image",href:cv.toDataURL("image/png"),x:0,y:0,
      w:cv.clientWidth,h:cv.clientHeight,layer:"위성 매핑 · 3D 렌더"};
  }finally{
    renderer.render(DG.scene,DG,DG.aerial.raw,DG.selected);
  }
}

async function dgSVGOperations() {
  if (!DG.scene) return;
  let mapped=null;
  if(needsDGRasterMapping()){
    mapped=await dgAerialSVGImage();
    if(mapped===false)return;
  }
  let ops=displayList(projector(), { forExport: true });
  if(mapped){
      const rasterLayers=new Set(["지형 · 대지","DESIGN AREA 지형면","CONTEXT 건물","DESIGN AREA 건물","그림자"]);
      // 삼각형 색면은 실제 사진 렌더로 대체하고, 나머지 도면 선은 벡터로 유지한다.
      ops=[mapped,...ops.filter(op=>!rasterLayers.has(op.layer))];
  }
  return ops;
}

async function exportSVG() {
  const ops=await dgSVGOperations();if(!ops)return;
  DRAW.exportSVG(`${dgStem()}.svg`,ops,dgView());
}

async function exportDGAIPackage(){
  const ops=await dgSVGOperations();if(!ops)return;
  DRAW.exportIllustratorPackage(`${dgStem()}_AI레이어.zip`,ops,dgView());
}

async function exportPNG() {
  if (!DG.scene) return;
  if(needsDGAerial()&&!DG.aerial.raw)await loadDGAerial();
  if(needsDGAerial()&&!DG.aerial.raw)return;
  if(DGR) return DGR.exportPNG(DG.scene,DG,DG.aerial.raw,DG.selected,DG.crop,DG.scale,`${dgStem()}.png`);
  DRAW.exportPNG(`${dgStem()}.png`,
    displayList(projector(), { forExport: true }), dgView(DG.scale));
}

async function exportGLB() {
  if(!DG.scene)return;
  if(needsDGAerial()&&!DG.aerial.raw)await loadDGAerial();
  if(needsDGAerial()&&!DG.aerial.raw)return;
  const r=DGR||await ensure3DRenderer();
  if(!r)return alert("GLB를 만들 WebGL 렌더러를 불러오지 못했습니다.");
  await r.exportGLB(DG.scene,DG,DG.aerial.raw,DG.selected,`${dgStem()}.glb`);
}

async function export3DM(){
  if(!DG.scene)return;
  const note=D$("#dg-render-note");
  if(note)note.textContent="Rhino 3DM 생성 중 · 건물별 폴리서피스와 지형 NURBS를 만드는 중입니다…";
  try{
    const module=await import("/rhino3d.bundle.js?v=20260831-2");
    const stats=await module.exportRhino3DM(DG.scene,DG,DG.selected,`${dgStem()}.3dm`);
    if(note)note.textContent=`3DM 완료 · 닫힌 건물 ${stats.buildings.solidCount.toLocaleString()}개 · `+
      (stats.terrain?.solid?`대지 두께 ${stats.terrain.depth.toFixed(1)}m 닫힌 폴리서피스`:
       stats.terrain?"대지 기준 NURBS":"대지 꺼짐");
  }catch(error){
    console.error("Rhino 3DM export:",error);
    if(note)note.textContent="3DM 생성 실패 · "+(error.message||String(error));
    alert("Rhino 3DM을 만들지 못했습니다: "+(error.message||String(error)));
  }
}

async function dgOpenExport() {
  if (!DG.scene) return alert("대상지를 먼저 고르세요.");
  document.querySelectorAll("#dgm-fmt button").forEach(
    b => b.classList.toggle("on", b.dataset.fmt === DG.fmt));
  D$("#dgm-scale").value = DG.scale;
  D$("#dgm-scale").disabled = DG.fmt !== "png";
  D$("#dgm-scope").textContent = DG.crop ? "지정한 범위만" : "화면에 보이는 대로";
  D$("#dgmodal").style.display = "flex";
  setTimeout(dgExportPreview, 30);
  // 내보내기 창은 실제 WebGL 결과를 미리 보여 주는 자리다. 아직 준비 전이면
  // 여기서 한 번 더 불러오고, 준비가 끝난 즉시 미리보기를 갈아 끼운다.
  await ensure3DRenderer();
  if(needsDGAerial()&&!DG.aerial.raw)await loadDGAerial();
  dgExportPreview();
}

function dgExportPreview() {
  const cv = D$("#dgm-canvas"); if (!cv || !DG.scene) return;
  const ctx = cv.getContext("2d"); ctx.clearRect(0,0,cv.width,cv.height);
  const view = dgView(), crop = view.crop || {x:0,y:0,w:view.w,h:view.h};
  let full,sx=0,sy=0,sw,sh;
  if(DGR){
    DGR.render(DG.scene,DG,DG.aerial.raw,DG.selected);full=D$("#dgwebgl");
    const rx=full.width/view.w,ry=full.height/view.h;
    sx=crop.x*rx;sy=crop.y*ry;sw=crop.w*rx;sh=crop.h*ry;
  }else{
    full=DRAW.renderToCanvas(displayList(projector(),{forExport:true}),{...view,scale:1});
    sw=full.width;sh=full.height;
  }
  const s = Math.min(cv.width/sw,cv.height/sh);
  const w=sw*s,h=sh*s,ox=(cv.width-w)/2,oy=(cv.height-h)/2;
  ctx.fillStyle="#eef0f4";ctx.fillRect(0,0,cv.width,cv.height);
  ctx.drawImage(full,sx,sy,sw,sh,ox,oy,w,h);ctx.strokeStyle="#c7ccd6";ctx.strokeRect(ox+.5,oy+.5,w-1,h-1);
  const px = (DG.fmt === "svg"||DG.fmt==="aizip") ? `${Math.round(crop.w)} × ${Math.round(crop.h)} pt`
           : DG.fmt === "glb" ? "GLB · 건물별 닫힌 메시 + 지형 삼각망"
           : DG.fmt === "3dm" ? "3DM · 건물·대지 닫힌 폴리서피스 + 지형 NURBS"
           : `${Math.round(crop.w*DG.scale)} × ${Math.round(crop.h*DG.scale)} px`;
  D$("#dgm-hint").innerHTML = `<b>${px}</b><br>`+
    (DG.fmt==="glb"?"건물마다 바닥·벽·지붕이 조인된 메시로 내보냅니다.":
     DG.fmt==="3dm"?"건물 면 방향을 바로잡고 대지 콘타 두께까지 닫힌 폴리서피스로 내보냅니다.":
     "현재 레이어·시점·통합 그림자가 그대로 나갑니다.");
}

function dgNanoDefaultPrompt(){
  return `입력 이미지는 건축 사이트의 3D 뷰입니다.

카메라 위치, 시점, 화각, 프레이밍과 이미지 비율을 절대 바꾸지 마세요. 건물의 위치·형태·높이·비율, 대지 경계, 지형 높이, 도로 형상과 모든 공간 관계를 입력 이미지와 정확히 동일하게 유지하세요. 객체를 임의로 이동하거나 새 건물·도로·조경·사람·차량·문자·간판을 추가 또는 삭제하지 마세요. 이미지 안에 주소, 대상지명, 설명문, 로고나 워터마크를 만들지 마세요.

현재 장면의 기하와 구도를 그대로 보존한 채 재질, 조명, 표면 질감과 대기감만 현실적으로 발전시켜 주세요. 자연스러운 건축 재료와 PBR 수준의 표면 질감, 균형 잡힌 노출, 물리적으로 일관된 햇빛, 부드럽고 자연스러운 그림자, 실제 환경에서 볼 수 있는 색감과 미세한 디테일을 사용하세요.

도면, 미니어처, 일러스트 또는 과장된 CG 렌더처럼 보이지 않게 하고, 실제 현장에서 고해상도 카메라로 촬영한 전문 건축 사진처럼 사실적으로 변환해 주세요.`;
}

async function dgNanoCapture(){
  if(!DG.scene)throw new Error("대상지를 먼저 고르세요.");
  if(needsDGAerial()&&!DG.aerial.raw)await loadDGAerial();
  const renderer=DGR||await ensure3DRenderer();
  const view=dgView(),crop=view.crop||{x:0,y:0,w:view.w,h:view.h};
  let full,sx=0,sy=0,sw,sh;
  if(renderer){
    renderer.render(DG.scene,DG,DG.aerial.raw,DG.selected);full=D$("#dgwebgl");
    const rx=full.width/view.w,ry=full.height/view.h;
    sx=crop.x*rx;sy=crop.y*ry;sw=crop.w*rx;sh=crop.h*ry;
  }else{
    full=DRAW.renderToCanvas(displayList(projector(),{forExport:true}),{...view,scale:1});
    sw=full.width;sh=full.height;
  }
  const scale=Math.min(2,2048/Math.max(1,crop.w,crop.h));
  const output=document.createElement("canvas");
  output.width=Math.max(1,Math.round(crop.w*scale));
  output.height=Math.max(1,Math.round(crop.h*scale));
  output.getContext("2d").drawImage(full,sx,sy,sw,sh,0,0,output.width,output.height);
  return output.toDataURL("image/png");
}

async function dgOpenNanoRender(){
  if(!DG.scene)return alert("대상지를 먼저 고르세요.");
  D$("#dgmodal").style.display="none";D$("#dgnanomodal").style.display="flex";
  const status=D$("#dgn-status"),preview=D$("#dgn-preview");
  const siteName=DG.scene.site_label||DG.scene.name||"대상지";
  const siteAddress=(DG.scene.address||"").trim();
  D$("#dgn-site-name").textContent=siteName;
  D$("#dgn-site-address").textContent=siteAddress||"주소 정보 없음";
  D$("#dgn-site-address").hidden=!siteAddress;
  status.dataset.kind="";status.textContent="현재 뷰를 준비하는 중…";
  D$("#dgn-render").disabled=true;D$("#dgn-download").disabled=true;
  D$("#dgn-prompt").value=dgNanoDefaultPrompt();
  try{
    DG.nano.source=await dgNanoCapture();DG.nano.result="";preview.src=DG.nano.source;
    status.textContent="현재 뷰 준비 완료 · 프롬프트를 확인한 뒤 렌더링하세요.";
    D$("#dgn-render").disabled=false;
  }catch(error){
    status.dataset.kind="error";status.textContent="현재 뷰 준비 실패 · "+(error.message||error);
  }
}

async function dgRunNanoRender(){
  if(DG.nano.busy||!DG.nano.source)return;
  const prompt=D$("#dgn-prompt").value.trim(),status=D$("#dgn-status"),button=D$("#dgn-render");
  if(!prompt)return alert("렌더링 프롬프트를 입력해 주세요.");
  DG.nano.busy=true;button.disabled=true;D$("#dgn-download").disabled=true;
  status.dataset.kind="";status.textContent="Nano Banana 2 렌더링 중… 잠시 기다려 주세요.";
  try{
    const response=await fetch("/api/render/nano-banana",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({prompt,image:DG.nano.source}),
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok){
      const detail=response.status===404&&payload.detail==="Not Found"
        ?"서버가 업데이트 전 버전입니다. VWorld 서버를 재시작한 뒤 다시 시도해 주세요."
        :(payload.detail||`HTTP ${response.status}`);
      throw new Error(detail);
    }
    if(!payload.image)throw new Error("결과 이미지가 없습니다.");
    DG.nano.result=payload.image;D$("#dgn-preview").src=payload.image;
    status.dataset.kind="done";status.textContent=`렌더링 완료 · ${payload.model||"Nano Banana"}`;
    D$("#dgn-download").disabled=false;
  }catch(error){
    status.dataset.kind="error";status.textContent="렌더링 실패 · "+(error.message||error);
  }finally{DG.nano.busy=false;button.disabled=false;}
}

// ── 3D 위성사진 레벨: 2D와 같은 검정점·중간톤·흰점
let d3ToneFrame=0,d3ToneVersion=0;

function ensureDGAerialTone(L){
  if(!Number.isFinite(+L.gamma))L.gamma=1;
  if(!Number.isFinite(+L.contrast))L.contrast=0;
  if(!Number.isFinite(+L.black))L.black=0;
  if(!Number.isFinite(+L.white)||+L.white<=0)L.white=255;
  L.black=Math.max(0,Math.min(254,Math.round(+L.black)));
  L.white=Math.max(L.black+1,Math.min(255,Math.round(+L.white)));
  L.gamma=Math.max(.2,Math.min(3,+L.gamma));
  L.contrast=Math.max(-100,Math.min(100,+L.contrast));
}

function dgLevelState(L){
  ensureDGAerialTone(L);
  const middle=L.black+Math.pow(.5,L.gamma)*(L.white-L.black);
  return {black:L.black,white:L.white,gamma:L.gamma,middle};
}

function syncDGLevelBar(box,L){
  if(!box||!L)return;
  const s=dgLevelState(L);
  for(const k of ["black","gamma","white"]){
    const h=box.querySelector(`[data-d3-level-h="${k}"]`),v=k==="gamma"?s.middle:s[k];
    if(h)h.style.left=`${v/255*100}%`;
  }
  const put=(k,text)=>{const el=box.querySelector(`[data-d3-level-v="${k}"]`);if(el)el.textContent=text;};
  put("black",`검정 ${s.black}`);put("gamma",`중간 γ${s.gamma.toFixed(2)}`);put("white",`흰 ${s.white}`);
}

function queueDGTone(){
  if(d3ToneFrame)return;
  d3ToneFrame=requestAnimationFrame(()=>{d3ToneFrame=0;applyDGTone();});
}

function setDGLevelAt(box,kind,clientX){
  const L=dLayer("ground"),track=box&&box.querySelector(".p2level-track");
  if(!L||!track)return;
  const r=track.getBoundingClientRect();
  const value=Math.round(Math.max(0,Math.min(1,(clientX-r.left)/Math.max(1,r.width)))*255);
  const s=dgLevelState(L);
  if(kind==="black")L.black=Math.min(value,s.white-1);
  else if(kind==="white")L.white=Math.max(value,s.black+1);
  else{
    const rel=Math.max(.125,Math.min(.87,(value-s.black)/(s.white-s.black)));
    L.gamma=Math.max(.2,Math.min(3,Math.log(rel)/Math.log(.5)));
  }
  syncDGLevelBar(box,L);queueDGTone();
}

function bindDGLevelBar(box){
  syncDGLevelBar(box,dLayer("ground"));
  box.onpointerdown=e=>{
    const track=e.target.closest(".p2level-track");if(!track)return;
    e.preventDefault();e.stopPropagation();
    const s=dgLevelState(dLayer("ground")),r=track.getBoundingClientRect();
    const value=Math.max(0,Math.min(255,(e.clientX-r.left)/Math.max(1,r.width)*255));
    const direct=e.target.closest("[data-d3-level-h]");
    const pos={black:s.black,gamma:s.middle,white:s.white};
    const kind=direct?direct.dataset.d3LevelH:Object.keys(pos).sort((a,b)=>
      Math.abs(pos[a]-value)-Math.abs(pos[b]-value))[0];
    setDGLevelAt(box,kind,e.clientX);
    const move=event=>setDGLevelAt(box,kind,event.clientX);
    const stop=()=>{
      document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",stop);
      document.removeEventListener("pointercancel",stop);
      if(d3ToneFrame){cancelAnimationFrame(d3ToneFrame);d3ToneFrame=0;}applyDGTone();
    };
    document.addEventListener("pointermove",move);document.addEventListener("pointerup",stop);
    document.addEventListener("pointercancel",stop);
  };
}

function bindDGLevelBars(){
  D$("#dglayers")?.querySelectorAll("[data-d3-levels]").forEach(bindDGLevelBar);
}

/** 받아 둔 원본은 건드리지 않고 WebGL 텍스처와 벡터 표본에 같은 레벨을 적용한다. */
function applyDGTone(){
  const L=dLayer("ground"),A=DG.aerial;
  if(!A.source){A.raw=null;A.pixels=null;render();return;}
  ensureDGAerialTone(L);
  const sw=A.source.naturalWidth||A.source.width,sh=A.source.naturalHeight||A.source.height;
  const cv=A.toneCanvas||(A.toneCanvas=document.createElement("canvas"));
  if(cv.width!==sw||cv.height!==sh){cv.width=sw;cv.height=sh;}
  const ctx=cv.getContext("2d",{willReadFrequently:true});ctx.drawImage(A.source,0,0,sw,sh);
  if(L.gray){
    const im=ctx.getImageData(0,0,sw,sh),d=im.data;
    const k=(L.contrast+100)/100,lut=new Uint8ClampedArray(256);
    for(let i=0;i<256;i++){
      let v=Math.max(0,Math.min(1,(i-L.black)/(L.white-L.black)));
      v=Math.pow(v,1/L.gamma);v=(v-.5)*k+.5;
      lut[i]=Math.round(Math.max(0,Math.min(1,v))*255);
    }
    for(let i=0;i<d.length;i+=4){d[i]=lut[d[i]];d[i+1]=lut[d[i+1]];d[i+2]=lut[d[i+2]];}
    ctx.putImageData(im,0,0);A.raw=cv;
  }else A.raw=A.source;

  const sample=A.sampleCanvas||(A.sampleCanvas=document.createElement("canvas")),size=512;
  sample.width=size;sample.height=size;
  const sampleCtx=sample.getContext("2d",{willReadFrequently:true});sampleCtx.drawImage(A.raw,0,0,size,size);
  const sampled=sampleCtx.getImageData(0,0,size,size);
  A.pixels={w:size,h:size,data:sampled.data};
  A.raw._toneVersion=++d3ToneVersion;render();
}

/** 사진을 작은 표본 버퍼로 만들어 지형·건물 면마다 빠르게 색을 꺼낸다. */
function needsDGAerial(){
  return groundAerialOn();
}

/** SVG처럼 WebGL 결과를 래스터로 포함해야 하는 매핑이 하나라도 켜졌는지. */
function needsDGRasterMapping(){
  const mass=dLayer("renderMass");
  return needsDGAerial()||!!(mass?.on&&mass.mapping!==false);
}

const loadDGAerial = createAerialLoader({
  state: DG.aerial, scene: () => DG.scene, layer: () => dLayer("ground"),
  enabled: needsDGAerial, hasImage: () => !!DG.aerial.source,
  clear: () => { DG.aerial.source = DG.aerial.raw = DG.aerial.pixels = null; },
  changed: () => { renderDGInfo(); if (sub === "3d") render(); },
  accept: image => { DG.aerial.source = image; },
  apply: applyDGTone,
  failed: error => {
    alert("3D 위성사진 오류: " + error.message);
    dLayer("ground").aerialMap = false; renderDGLayers();
  },
});

// ───────────────────────────────────────────────────────── 자료

async function loadScene(name, radius, grid) {
  const requestId = (DG.sceneLoadId || 0) + 1;
  DG.sceneLoadId = requestId;
  if (!name) { DG.scene = null; return true; }
  // 대상지가 바뀔 때 이전 대상지의 확장 반경·캐시 상태를 넘겨받지 않는다.
  if(DG.scene&&DG.scene.name!==name){
    if(DGR)DGR.clearBuildingModels();
    radius=0;DG.scene=null;DG.radiusReq=0;DG.fullRadius=0;DG.cachedRadii=[];
    DG.pendingRadius=0;DG.contextBusy=false;DG.contextProgress=0;DG.contextStatus="";
    DG.baseBuildingCount=0;
    DG.selectedBuildings.clear();DG.pickBuildingMode=false;
    DG.removedBuildings.clear();DG.modelPlacement=null;
  }
  DG.radiusReq = (radius === undefined || radius === null) ? DG.radiusReq : radius;  // 0 = 전체
  DG.grid = grid || DG.grid;
  D$("#dginfo").textContent = "불러오는 중…";
  try {
    const r = await fetch(DRAW.siteURL(name)
      + `/scene?radius=${DG.radiusReq || 0}&grid=${DG.grid}`);
    const d = await r.json();
    // 대상지/격자를 연달아 바꿨을 때 늦게 끝난 예전 응답이 최신 장면을 덮지 않는다.
    if(requestId !== DG.sceneLoadId) return false;
    if (!r.ok) {
      if(r.status===409){DG.pendingRadius=DG.radiusReq;renderDGLayers();}
      D$("#dginfo").textContent = d.detail || "불러오지 못했습니다"; return false;
    }
    DG.scene = d;
    DG.fullRadius=+(d.full_radius||0) || (DG.radiusReq===0?d.radius:DG.fullRadius);
    DG.cachedRadii=(d.context_cached_radii||[]).map(Number).filter(Number.isFinite);
    DG.maxContextRadius=+(d.max_context_radius||900);
    DG.pendingRadius=0;
    if(DG.radiusReq===0)DG.baseBuildingCount=(d.buildings||[]).length;
    DG.radius = d.radius;      // 서버가 실제로 쓴 반경(m). 투영 배율의 분모다.
    if(DG.sunMode==="datetime")applyDGSunDateTime(false);
    renderDGLayers();syncControls();
    if (typeof plan2Load === "function" && sub === "2d") plan2Load(d);
    DG.aerial.key = "";
    // 숨겨진 3D 캔버스까지 다시 그리면 2D 진입 때 크기·상태가 엇갈릴 수 있다.
    // 현재 선택한 하위 탭만 loadScene 위에서 갱신한다.
    if (sub === "3d") {
      if (needsDGAerial()) loadDGAerial(); else render();
    }
    return true;
  } catch (e) {
    if(requestId === DG.sceneLoadId) D$("#dginfo").textContent = "오류: " + e.message;
    return false;
  }
}

// ───────────────────────────────────────────────────────── 3D 레이어 · 프리셋

// 뷰는 별도 저장한다. 3D 프리셋을 되돌려도 사용자가 잡아 둔 카메라는 움직이지 않는다.
const D3_PRESET_KEEP = ["floorH","vScale","groundDepth","terrainMode","grid","sunAz","sunAlt","sunMode","sunDateTime",
                        "shadowSoftness","renderMode","renderQuality","outline","scale","fmt"];
const D3_VIEW_KEYS = ["az","el","zoom","panX","panY"];

const dgEsc = s => DRAW.esc(s);   // draw.js 것을 쓴다
const dgContextCovered=r=>r<=DG.fullRadius||DG.cachedRadii.some(c=>c>=r);

/** 선 체크와 굵기 숫자를 양방향으로 묶는다. 체크를 다시 켜면 직전 굵기를 복원한다. */
function dgLineWidthFromInput(input){
  // Chrome의 number 입력은 `0.`처럼 아직 완성되지 않은 소수를 잠시 badInput으로
  // 보고한다. 이때 0을 되써서 사용자의 소수점을 지우지 않는다.
  if(!input||input.value===""||input.validity?.badInput)return null;
  const value=Number(input.value);
  return Number.isFinite(value)?Math.max(0,Math.min(8,value)):null;
}

function syncDGLineControls(row, layer, key, oldW){
  if(key==="w"){
    if(layer.w>0){layer.strokeOn=true;layer.lastW=layer.w;}
    else{
      if(oldW>0)layer.lastW=oldW;
      layer.w=0;layer.strokeOn=false;
    }
  }else if(key==="strokeOn"){
    if(layer.strokeOn){
      layer.w=layer.w>0?layer.w:(layer.lastW>0?layer.lastW:.5);
      layer.lastW=layer.w;
    }else{
      if(oldW>0)layer.lastW=oldW;
      layer.w=0;
    }
  }else return;
  const check=row.querySelector('[data-k="strokeOn"]'),width=row.querySelector('[data-k="w"]');
  if(check)check.checked=layer.strokeOn;
  if(width&&!(key==="w"&&width===document.activeElement))width.value=layer.w;
}

function dgContextEstimate(radius){
  const sampleRadius=DG.radiusReq===0?DG.fullRadius:(DG.radius||DG.fullRadius);
  const sampleCount=DG.baseBuildingCount||((DG.scene?.buildings||[]).length);
  if(!sampleRadius||!sampleCount)return 0;
  return Math.max(sampleCount,Math.round(sampleCount*Math.pow(radius/sampleRadius,2)));
}

async function expandDGContext(radius){
  if(!current||DG.contextBusy)return;
  const site=current;
  DG.contextBusy=true;DG.contextProgress=0;DG.contextStatus="추가 수집을 준비하는 중";
  renderDGLayers();
  try{
    const response=await fetch(DRAW.siteURL(site, "/scene-context"),{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({radius,grid:DG.grid})
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.detail||"추가 수집을 시작하지 못했습니다.");
    if(result.cached){
      DG.contextBusy=false;DG.contextStatus="수집된 캐시를 불러오는 중";
      return loadScene(site,radius,DG.grid);
    }
    const poll=async()=>{
      try{
        const r=await fetch(`/api/job/${encodeURIComponent(result.job_id)}`);
        const job=await r.json();
        if(!r.ok)throw new Error(job.detail||"진행 상태를 확인하지 못했습니다.");
        DG.contextProgress=+(job.progress||0);DG.contextStatus=job.phase||"수집 중";
        if(current!==site){DG.contextBusy=false;return;}
        if(job.status==="done"){
          DG.contextBusy=false;DG.contextProgress=100;DG.contextStatus="수집 완료 · 장면 불러오는 중";
          renderDGLayers();
          await loadScene(site,radius,DG.grid);return;
        }
        if(job.status==="error")throw new Error((job.log||[]).slice(-1)[0]||"추가 수집에 실패했습니다.");
        renderDGLayers();setTimeout(poll,600);
      }catch(error){
        DG.contextBusy=false;DG.contextStatus="오류 · "+error.message;renderDGLayers();
      }
    };
    poll();
  }catch(error){
    DG.contextBusy=false;DG.contextStatus="오류 · "+error.message;renderDGLayers();
  }
}

function renderDGLayers() {
  const box=D$("#dglayers");if(!box)return;
  ensureDGEnvironment();
  if(DG.selectedBuildings.size){
    const valid=new Set();
    for(const [index,building] of (DG.scene?.buildings||[]).entries()){
      if(DG.selected.has(building.pnu))valid.add(dgBuildingKey(DG.scene,building,index));
    }
    for(const key of DG.selectedBuildings)if(!valid.has(key))DG.selectedBuildings.delete(key);
  }
  const expandable=new Set(["renderMass","designBldg","bldg","ground","shadow","sky"]);
  const generic=L=>`<div class="lyr ${L.fixed?"lyr-fixed":""}" data-id="${L.id}" ${L.fixed?"":'draggable="true"'}>
      <span class="lyr-grip">${L.fixed?"·":"⋮⋮"}</span>
      <label class="lyr-on"><input type="checkbox" data-k="on" ${L.on?"checked":""}></label>
      ${expandable.has(L.id)?`<span class="lyr-namewrap"><span class="lyr-name">${L.name}</span>
        <label class="lyr-exp" for="d3exp-${L.id}" title="${L.name} 설정 펴기·접기">▾</label></span>`:
        `<span class="lyr-name" title="${L.name}">${L.name}</span>`}
      <label class="lyr-fill"><input type="checkbox" data-k="fillOn" ${L.fillOn?"checked":""}>
        <input type="color" data-k="fill" value="${L.fill}"></label>
      <label class="lyr-stroke" title="선 켜기 · 색">
        <input type="checkbox" data-k="strokeOn" ${L.strokeOn !== false?"checked":""}>
        <input type="color" data-k="stroke" value="${L.stroke}">
      </label>
      <span></span>
      <input type="number" data-k="w" value="${L.w}" min="0" max="8" step="0.01"
             inputmode="decimal" title="선 굵기">
      <input type="number" data-k="op" value="${L.op}" min="0" max="100" step="5" title="투명도 %">
    </div>`;
  box.innerHTML=DG.layers.map(L=>{
    if(L.id==="renderMass"){
      const massState=DGR?.massStatus?.()||{};
      const note=massState.message||
        (L.on?"지정 범위의 VWorld 실물 매스를 준비하는 중입니다.":"필요할 때 지정 범위의 VWorld 실물 매스를 불러옵니다.");
      const kind=massState.kind||"";
      const row=`<div class="lyr d3-render-mass" data-id="renderMass" draggable="true">
        <span class="lyr-grip" title="끌어서 3D 표시 우선순위 변경">⋮⋮</span>
        <label class="lyr-on"><input type="checkbox" data-k="on" ${L.on?"checked":""}></label>
        <span class="lyr-namewrap"><span class="lyr-name">${L.name}</span>
          <label class="lyr-exp" for="d3exp-renderMass" title="실물 매스 설정 펴기·접기">▾</label></span>
        <span class="lyr-range-note">CONTEXT 범위</span>
        <input type="number" data-k="op" value="${L.op??100}" min="0" max="100" step="5"
          title="실물 매스 투명도 %">
      </div>`;
      return `<div class="lyr-group">
        <input type="checkbox" class="lyr-expcb d3-expcb" data-layer-open="renderMass"
          id="d3exp-renderMass" ${DG.layerOpen.renderMass!==false?"checked":""}>${row}
        <div class="lyr-subs"><div class="d3-layer-sub d3-render-mass-sub">
          <label class="d3-map-toggle"><input type="checkbox" data-d3-layer-k="mapping"
            data-layer-id="renderMass" ${L.mapping!==false?"checked":""} ${L.on?"":"disabled"}>
            실물 매핑 <span class="dim">현재 뷰 · 내보내기</span></label>
          <label class="d3-map-toggle"><input type="checkbox" data-d3-layer-k="caps"
            data-layer-id="renderMass" ${L.caps!==false?"checked":""} ${L.on?"":"disabled"}>
            CONTEXT 절단면 채우기 <span class="dim">잘린 건물 내부 마감</span></label>
          <div class="hint">CONTEXT를 여러 고정 구역으로 나눠 누락 타일 확인까지 끝낸 뒤 잠급니다. DESIGN AREA와 겹치는 실물 매스는 건물 단위로 통째 제외하며, PNG에는 보이지만 GLB·3DM에는 넣지 않습니다.</div>
          <div id="vw3d-note" data-kind="${dgEsc(kind)}">${dgEsc(note)}</div>
        </div></div></div>`;
    }
    if(L.id==="sky"){
      return `<div class="lyr-group">
        <input type="checkbox" class="lyr-expcb d3-expcb" data-layer-open="sky"
          id="d3exp-sky" ${DG.layerOpen.sky?"checked":""}>
        <div class="lyr lyr-fixed" data-id="sky">
          <span class="lyr-grip">·</span>
          <label class="lyr-on"><input type="checkbox" data-k="on" ${L.on?"checked":""}></label>
          <span class="lyr-namewrap"><span class="lyr-name" title="${L.name}">${L.name}</span>
            <label class="lyr-exp" for="d3exp-sky" title="하늘 설정 펴기·접기">▾</label></span>
          <span></span>
          <span></span><span></span><span></span><span></span>
        </div>
        <div class="lyr-subs"><div class="d3-layer-sub">
          <label>천정 색 <input type="color" data-d3-layer-k="zenith" data-layer-id="sky" value="${L.zenith}"></label>
          <label>수평선 색 <input type="color" data-d3-layer-k="horizon" data-layer-id="sky" value="${L.horizon}"></label>
          <label>구름량 <input type="range" data-d3-layer-k="clouds" data-layer-id="sky" min="0" max="100" step="1" value="${L.clouds}">
            <b>${L.clouds}%</b></label>
          <label>태양광 <input type="range" data-d3-layer-k="sunGlow" data-layer-id="sky" min="0" max="100" step="1" value="${L.sunGlow}">
            <b>${L.sunGlow}%</b></label>
          <div class="hint">해 레이어의 방위·고도와 구름량을 반영해 낮, 노을, 야간의 하늘과 장면 조명을 함께 조정합니다.</div>
        </div></div>
      </div>`;
    }
    if(L.id==="background"){
      L.fillOn=true;L.strokeOn=false;L.w=0;L.op=100;
      return `<div class="lyr lyr-fixed" data-id="background">
        <span class="lyr-grip">·</span>
        <label class="lyr-on"><input type="checkbox" data-k="on" ${L.on?"checked":""}></label>
        <span class="lyr-name" title="${L.name}">${L.name}</span>
        <label class="lyr-fill lyr-color-only" title="바탕색">
          <input type="color" data-k="fill" value="${L.fill}"></label>
        <span></span><span></span><span></span><span></span>
      </div>`;
    }
    if(!expandable.has(L.id))return generic(L);
    let subs="";
    if(L.id==="designBldg"){
      const selectedBuildingCount=DG.selectedBuildings.size;
      const removedSelectedCount=[...DG.selectedBuildings].filter(key=>DG.removedBuildings.has(key)).length;
      const hasModel=!!(DGR&&DGR.hasBuildingModel(DESIGN_AREA_MODEL_KEY));
      const modelInfo=hasModel?DGR.buildingModelInfo(DESIGN_AREA_MODEL_KEY):null;
      const selectedParcelCount=DG.selected.size;
      subs=`
        <div class="d3-building-model">
          <div class="d3-building-model-actions">
            <button type="button" data-d3-building-pick class="${DG.pickBuildingMode?"on":""}" ${!selectedParcelCount||DG.modelBusy?"disabled":""}>
              건물 객체 선택</button>
            <button type="button" data-d3-building-remove ${!selectedBuildingCount||DG.modelBusy?"disabled":""}>
              기존 건물 제거</button>
            <button type="button" data-d3-model-open ${!selectedParcelCount||DG.modelBusy?"disabled":""}>GLB · 3DM 넣기</button>
            <button type="button" data-d3-model-edit ${!hasModel||DG.modelBusy?"disabled":""}>파일 모델 편집</button>
          </div>
          <input type="file" data-d3-model-file accept=".glb,.3dm,model/gltf-binary,application/vnd.rhino,application/octet-stream" hidden>
          <div class="d3-building-model-state">${DG.pickBuildingMode
            ?`건물을 클릭하세요. <b>Ctrl+클릭</b>으로 중복 선택 · 땅 클릭으로 해제`
            :selectedBuildingCount
              ?`선택 <b>${selectedBuildingCount}개</b>${removedSelectedCount?` · 제거됨 ${removedSelectedCount}개`:""}`
              :selectedParcelCount?"기존 건물을 선택하거나 모델을 바로 넣을 수 있습니다.":"사이트 분석에서 DESIGN AREA를 먼저 지정하세요."}
            ${modelInfo?`<span>${dgEsc(modelInfo.name||"사용자 모델")}</span>`:""}</div>
          <div class="hint">가져온 모델은 기존 건물과 연결하지 않고 DESIGN AREA 중앙에 원본 크기로 배치합니다.</div>
        </div>`;
    }
    if(L.id==="bldg")subs=`
        <label>층고 <input type="range" data-d3-k="floorH" min="2.4" max="6" step="0.1" value="${DG.floorH}">
          <b data-d3-v="floorH">${DG.floorH.toFixed(1)} m</b></label>
        <div class="hint">건물 높이 = 확인된 층수 × 층고</div>`;
    if(L.id==="ground"){
      ensureDGAerialTone(L);
      if(!Number.isFinite(+L.mapOpacity))L.mapOpacity=85;
      const full=Math.round(DG.fullRadius||DG.scene?.full_radius||0);
      const selected=DG.pendingRadius||DG.radiusReq;
      const radiusOptions=[50,100,150,250,400,600,900]
        .filter(v=>!full||v<full||v<=DG.maxContextRadius);
      const pending=DG.pendingRadius>full&&!dgContextCovered(DG.pendingRadius);
      const estimate=pending?dgContextEstimate(DG.pendingRadius):0;
      const terrain=terrainSpec();
      subs=`
        <label class="d3-map-toggle"><input type="checkbox" data-d3-layer-k="aerialMap"
          data-layer-id="ground" ${L.aerialMap!==false?"checked":""}>
          지형 위성사진 매핑 <span class="dim">현재 뷰 · 내보내기</span></label>
        <div class="d3-aerial-options ${L.aerialMap===false?"disabled":""}">
          <label class="lyr-mini"><input type="checkbox" data-d3-layer-k="gray"
            data-layer-id="ground" ${L.gray?"checked":""} ${L.aerialMap===false?"disabled":""}>흑백</label>
          <label class="lyr-mini"><input type="checkbox" data-d3-layer-k="base"
            data-layer-id="ground" ${L.base?"checked":""} ${L.aerialMap===false?"disabled":""}>일반지도</label>
          <label>매핑 강도 <input type="number" data-d3-layer-k="mapOpacity" data-layer-id="ground"
            value="${L.mapOpacity}" min="0" max="100" step="5" ${L.aerialMap===false?"disabled":""}> %</label>
        </div>
        ${L.gray&&L.aerialMap!==false?`<div class="p2levels" data-d3-levels="ground">
          <div class="p2level-track" title="가까운 손잡이를 끌어 검정점·중간톤·흰점을 조절합니다">
            <div class="p2level-ramp"></div>
            <button type="button" class="p2level-handle" data-d3-level-h="black"></button>
            <button type="button" class="p2level-handle" data-d3-level-h="gamma"></button>
            <button type="button" class="p2level-handle" data-d3-level-h="white"></button>
          </div>
          <div class="p2level-values">
            <span data-d3-level-v="black">검정 ${L.black}</span>
            <span data-d3-level-v="gamma">중간 γ${L.gamma.toFixed(2)}</span>
            <span data-d3-level-v="white">흰 ${L.white}</span>
          </div>
          <div class="p2level-foot">
            <label>대비 <input type="range" data-d3-tone-k="contrast" value="${L.contrast}"
              min="-100" max="100" step="1"></label>
            <button type="button" data-d3-tone-reset="1" class="rule-del" title="레벨 기본값으로">↺</button>
          </div>
        </div>`:""}
        <label>지형 형태 <select data-d3-k="terrainMode">
          <option value="natural" ${DG.terrainMode==="natural"?"selected":""}>자연스러운 지형</option>
          <option value="stepped" ${DG.terrainMode==="stepped"?"selected":""}>계단형 · ${terrain.step}m 등고 간격</option>
        </select></label>
        <label>수직 과장 <input type="range" data-d3-k="vScale" min="1" max="6" step="0.5" value="${DG.vScale}">
          <b data-d3-v="vScale">×${DG.vScale}</b></label>
        <label>대지 콘타 두께 <input type="range" data-d3-k="groundDepth" min="0" max="12" step="0.5" value="${DG.groundDepth}">
          <b data-d3-v="groundDepth">${DG.groundDepth.toFixed(1)} m</b></label>
        <label>3D 컨텍스트 <select data-d3-k="radiusReq" ${!full?"disabled":""}>
          <option value="0" ${selected===0?"selected":""}>${full?`기존 수집 전체 · ${full} m`:"대상지 선택 후 표시"}</option>
          ${radiusOptions.map(v=>{
            const outside=v>full,covered=dgContextCovered(v);
            const suffix=outside?(covered?" · 수집 완료":" · 추가 수집"):" · 즉시";
            return `<option value="${v}" ${selected===v?"selected":""}>중심에서 사방 ${v} m${suffix}</option>`;
          }).join("")}
        </select></label>
        ${pending?`<div class="d3-context-expand">
          <div><b>${full} → ${DG.pendingRadius} m</b><span>예상 건물 약 ${estimate.toLocaleString()}동</span></div>
          <div class="hint">PROJECT SITE는 바뀌지 않고 3D용 필지·건물만 별도로 수집합니다.</div>
          <button type="button" data-d3-expand="${DG.pendingRadius}" ${DG.contextBusy?"disabled":""}>
            ${DG.contextBusy?"추가 수집 중…":"3D 컨텍스트 추가 수집"}</button>
          ${(DG.contextBusy||DG.contextStatus)?`<progress max="100" value="${DG.contextProgress}"></progress>
            <small>${dgEsc(DG.contextStatus)}</small>`:""}
        </div>`:""}
        <label>지형 삼각형 <select data-d3-k="grid">
          <option value="28" ${DG.grid===28?"selected":""}>성김 (18m)</option>
          <option value="56" ${DG.grid===56?"selected":""}>보통 (9m)</option>
          <option value="84" ${DG.grid===84?"selected":""}>잘게 (6m)</option>
          <option value="112" ${DG.grid===112?"selected":""}>아주 잘게 (4m)</option>
        </select></label>`;
    }
    if(L.id==="shadow"){
      if(!DG.sunDateTime)DG.sunDateTime=dgKSTNow();
      subs=`
        <div class="d3-sun-clock">
          <label class="d3-sun-mode"><input type="checkbox" data-sun-mode ${DG.sunMode==="datetime"?"checked":""}>
            날짜·시간으로 태양 위치 계산 <span>한국시간</span></label>
          <div class="d3-sun-clock-row">
            <input type="datetime-local" data-sun-datetime value="${DG.sunDateTime}" aria-label="태양 위치를 계산할 날짜와 시간">
            <button type="button" data-sun-now>현재</button>
          </div>
          <div class="hint ${DG.sunMode==="datetime"&&DG.sunAlt<=0?"night":""}" data-sun-result>${dgSunSummary()}</div>
        </div>
        <div data-d3-manual-sun class="d3-manual-sun ${DG.sunMode==="datetime"?"disabled":""}">
        <label>해 방위 <input type="range" data-shadow-k="sunAz" min="0" max="359" step="1" value="${DG.sunAz}" ${DG.sunMode==="datetime"?"disabled":""}>
          <b data-shadow-v="sunAz">${(+DG.sunAz).toFixed(1)}°</b></label>
        <label>해 고도 <input type="range" data-shadow-k="sunAlt" min="-18" max="90" step="1" value="${DG.sunAlt}" ${DG.sunMode==="datetime"?"disabled":""}>
          <b data-shadow-v="sunAlt">${(+DG.sunAlt).toFixed(1)}°</b></label></div>
        <label>그림자 강도 <input type="range" data-shadow-k="op" min="0" max="100" step="1" value="${L.op}">
          <b data-shadow-v="op">${L.op}%</b></label>
        <label>가장자리 흐림 <input type="range" data-shadow-k="shadowSoftness" min="0" max="10" step="0.5" value="${DG.shadowSoftness}">
          <b data-shadow-v="shadowSoftness">${DG.shadowSoftness}</b></label>
        <div class="hint">0은 선명, 10은 가장 부드럽게 · WebGL 화면과 PNG에 적용</div>`;
    }
    return `<div class="lyr-group">
      <input type="checkbox" class="lyr-expcb d3-expcb" data-layer-open="${L.id}" id="d3exp-${L.id}" ${DG.layerOpen[L.id]?"checked":""}>
      ${generic(L)}
      <div class="lyr-subs"><div class="d3-layer-sub">
        ${subs}
      </div></div></div>`;
  }).join("");
  bindDGLevelBars();
}

function dgDesignPolygons(){
  const polygons=[];
  for(const parcel of DG.scene?.parcels||[]){
    if(!DG.selected.has(parcel.pnu))continue;
    for(const polygon of dgPolygonGroups(parcel))if(polygon?.[0]?.length>=3)polygons.push(polygon);
  }
  return polygons;
}

function dgDesignCenter(){
  const points=dgDesignPolygons().flat(2);
  if(!points.length)return [0,0];
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const point of points){x0=Math.min(x0,point[0]);y0=Math.min(y0,point[1]);x1=Math.max(x1,point[0]);y1=Math.max(y1,point[1]);}
  return dgClampToDesignArea((x0+x1)/2,(y0+y1)/2);
}

function dgPointInRing(point,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if((a[1]>point[1])!==(b[1]>point[1])&&
       point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}

function dgPointInPolygon(point,polygon){
  return !!polygon?.[0]&&dgPointInRing(point,polygon[0])&&
    !polygon.slice(1).some(hole=>dgPointInRing(point,hole));
}

function dgClampToDesignArea(x,y){
  const point=[x,y],polygons=dgDesignPolygons();
  if(!polygons.length||polygons.some(polygon=>dgPointInPolygon(point,polygon)))return point;
  let best=point,bestDistance=Infinity;
  for(const polygon of polygons)for(const ring of polygon)for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length],dx=b[0]-a[0],dy=b[1]-a[1];
    const length2=dx*dx+dy*dy||1,t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/length2));
    const candidate=[a[0]+dx*t,a[1]+dy*t],distance=(candidate[0]-x)**2+(candidate[1]-y)**2;
    if(distance<bestDistance){bestDistance=distance;best=candidate;}
  }
  return best;
}

function dgPlacementView(){
  const points=dgDesignPolygons().flat(2);
  if(!points.length){const R=DG.scene?.radius||100;return {x0:-R,y0:-R,x1:R,y1:R};}
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const point of points){x0=Math.min(x0,point[0]);y0=Math.min(y0,point[1]);x1=Math.max(x1,point[0]);y1=Math.max(y1,point[1]);}
  const pad=Math.max(3,Math.max(x1-x0,y1-y0)*.12);return {x0:x0-pad,y0:y0-pad,x1:x1+pad,y1:y1+pad};
}

function dgDrawModelPlacement(){
  const active=DG.modelPlacement,canvas=D$("#dgp-canvas");if(!active||!canvas||!DGR)return;
  const ctx=canvas.getContext("2d"),view=dgPlacementView(),w=canvas.width,h=canvas.height;
  const scale=Math.min(w/Math.max(.001,view.x1-view.x0),h/Math.max(.001,view.y1-view.y0));
  const ox=(w-(view.x1-view.x0)*scale)/2-view.x0*scale;
  const oy=(h-(view.y1-view.y0)*scale)/2+view.y1*scale;
  const screen=point=>[ox+point[0]*scale,oy-point[1]*scale];
  active.view={...view,scale,ox,oy};ctx.clearRect(0,0,w,h);ctx.fillStyle="#eef0f3";ctx.fillRect(0,0,w,h);
  const pathFor=polygon=>{
    const path=new Path2D();
    for(const ring of polygon){
      ring.forEach((point,index)=>{const [x,y]=screen(point);if(index)path.lineTo(x,y);else path.moveTo(x,y);});path.closePath();
    }
    return path;
  };
  ctx.save();ctx.fillStyle="#d8dde5";ctx.strokeStyle="#6f7887";ctx.lineWidth=1.2;
  for(const polygon of dgDesignPolygons()){const path=pathFor(polygon);ctx.fill(path,"evenodd");ctx.stroke(path);}
  ctx.restore();
  ctx.save();ctx.fillStyle="rgba(86,95,109,.3)";ctx.strokeStyle="rgba(66,73,84,.6)";ctx.lineWidth=1;
  for(const building of DG.scene?.buildings||[]){
    if(!DG.selected.has(building.pnu))continue;
    for(const polygon of dgPolygonGroups(building)){const path=pathFor(polygon);ctx.fill(path,"evenodd");ctx.stroke(path);}
  }
  ctx.restore();
  const info=DGR.buildingModelInfo(active.transaction.key);if(!info)return;
  const placement=info.placement,size=info.size,halfX=size[0]*placement.scale/2,halfY=size[1]*placement.scale/2;
  const angle=placement.rotation*RAD,cos=Math.cos(angle),sin=Math.sin(angle);
  const sourceFootprint=info.footprint?.length>=3?info.footprint:
    [[-halfX/placement.scale,-halfY/placement.scale],[halfX/placement.scale,-halfY/placement.scale],
      [halfX/placement.scale,halfY/placement.scale],[-halfX/placement.scale,halfY/placement.scale]];
  const corners=sourceFootprint.map(([sourceX,sourceY])=>{
    const x=sourceX*placement.scale,y=sourceY*placement.scale;
    return [placement.x+x*cos-y*sin,placement.y+x*sin+y*cos];
  });
  const modelPath=new Path2D();corners.forEach((point,index)=>{const [x,y]=screen(point);if(index)modelPath.lineTo(x,y);else modelPath.moveTo(x,y);});modelPath.closePath();
  ctx.fillStyle="rgba(226,86,74,.42)";ctx.strokeStyle="#b53830";ctx.lineWidth=2;ctx.fill(modelPath);ctx.stroke(modelPath);
  const [cx,cy]=screen([placement.x,placement.y]);
  ctx.beginPath();ctx.arc(cx,cy,6,0,Math.PI*2);ctx.fillStyle="#fff";ctx.fill();ctx.strokeStyle="#b53830";ctx.lineWidth=2;ctx.stroke();
  ctx.beginPath();ctx.moveTo(cx-10,cy);ctx.lineTo(cx+10,cy);ctx.moveTo(cx,cy-10);ctx.lineTo(cx,cy+10);ctx.stroke();
}

function dgSyncModelPlacement(){
  const active=DG.modelPlacement;if(!active||!DGR)return;
  const info=DGR.buildingModelInfo(active.transaction.key);if(!info)return;
  for(const [key,value] of Object.entries(info.placement)){
    const input=D$(`#dgplacemodal [data-dgp-k="${key}"]`);if(input)input.value=Number(value).toFixed(key==="rotation"?1:key==="scale"?4:2);
  }
  const anchorLabel=info.anchorMethod==="bottom-face"?"실제 바닥면 면적 중심":"최하단 외곽 중심";
  D$("#dgp-size").textContent=`원본 ${info.size.map(value=>Number(value).toFixed(2)).join(" × ")} m · 메시 ${info.meshCount.toLocaleString()}개 · 기준점: ${anchorLabel}`;
  dgDrawModelPlacement();
}

function dgSetModelPlacement(patch){
  const active=DG.modelPlacement;if(!active||!DGR)return;
  if(Number.isFinite(+patch.x)&&Number.isFinite(+patch.y)){
    [patch.x,patch.y]=dgClampToDesignArea(+patch.x,+patch.y);
  }
  DGR.setBuildingModelPlacement(active.transaction.key,patch);dgSyncModelPlacement();render();
}

function dgOpenModelPlacement(transaction,picked){
  DG.modelPlacement={transaction,picked,dragging:false};
  D$("#dgp-name").textContent=`${transaction.format} · ${transaction.name}`;
  D$("#dgp-title").textContent=transaction.editing?"파일 모델 편집":"가져온 모델 배치";
  D$("#dgp-reset").textContent=transaction.editing?"편집 전 위치로 초기화":"처음 위치로 초기화";
  D$("#dgp-remove").hidden=!transaction.editing;
  D$("#dgp-apply").textContent=transaction.editing?"편집 적용":"이 위치에 넣기";
  D$("#dgplacemodal").style.display="flex";dgSyncModelPlacement();
}

function dgCloseModelPlacement(apply){
  const active=DG.modelPlacement;if(!active)return;
  if(active.transaction.editing){
    if(!apply)DGR?.setBuildingModelPlacement(active.transaction.key,active.transaction.initialPlacement);
  }else if(apply)DGR?.commitBuildingModelLoad(active.transaction);
  else DGR?.cancelBuildingModelLoad(active.transaction);
  DG.modelPlacement=null;D$("#dgplacemodal").style.display="none";renderDGLayers();render();
}

function dgEditBuildingModel(){
  if(!DGR)return;
  const info=DGR.buildingModelInfo(DESIGN_AREA_MODEL_KEY);if(!info)return;
  dgOpenModelPlacement({
    key:DESIGN_AREA_MODEL_KEY,editing:true,
    name:info.name||"사용자 모델",format:info.format||"MODEL",
    initialPlacement:{...info.placement},
  },null);
}

function dgRemoveEditedBuildingModel(){
  const active=DG.modelPlacement;if(!active?.transaction?.editing||!DGR)return;
  const name=active.transaction.name||"파일 모델";
  if(!confirm(`'${name}' 모델을 삭제할까요?`))return;
  DG.modelPlacement=null;D$("#dgplacemodal").style.display="none";
  DGR.removeBuildingModel(active.transaction.key);renderDGLayers();render();
}

function d3psCapture(){
  const s={layers:DG.layers.map(L=>({...L}))};
  for(const k of D3_PRESET_KEEP)s[k]=DG[k];
  return s;
}
function d3psLabel(s){
  const mode={diagram:"다이어그램",aerial:"위성 매핑"};
  return `${mode[s.renderMode]||"다이어그램"} · 레이어 ${(s.layers||[]).filter(L=>L.on).length}개`;
}
async function d3psApply(s){
  const legacyAerial=(s.layers||[]).find(L=>L.id==="aerial");
  for(const k of D3_PRESET_KEEP)if(s[k]!==undefined)DG[k]=s[k];
  DG.renderMode=s.renderMode==="aerial"?"aerial":"diagram";
  // 날짜·시간 기능이 생기기 전 프리셋의 방위·고도는 수동값으로 복원한다.
  if(s.sunMode===undefined)DG.sunMode="manual";
  if(s.terrainMode===undefined)DG.terrainMode="natural";
  if(s.layers)DG.layers=s.layers.filter(L=>L.id!=="label"&&L.id!=="aerial")
    .map(L=>({...L,strokeOn:L.id==="background"?false:L.strokeOn!==false}));
  if(!dLayer("renderMass"))DG.layers.unshift(newRenderMassLayer());
  if(!dLayer("designBldg")){
    const at=Math.max(0,DG.layers.findIndex(L=>L.id==="bldg"));
    DG.layers.splice(at,0,newDesignBuildingLayer());
  }
  if(!dLayer("designGround")){
    const at=Math.max(0,DG.layers.findIndex(L=>L.id==="designBldg")+1);
    DG.layers.splice(at,0,newDesignGroundLayer());
  }
  const contextBuildings=dLayer("bldg");
  if(contextBuildings&&contextBuildings.name==="건물")contextBuildings.name="CONTEXT 건물";
  const renderMass=dLayer("renderMass");
  if(renderMass){
    delete renderMass.fixed;
    if(renderMass.caps===undefined)renderMass.caps=true;
    if(!Number.isFinite(+renderMass.op))renderMass.op=100;
    delete renderMass.groundMapping;delete renderMass.shadows;
  }
  const ground=dLayer("ground");
  if(ground){
    if(legacyAerial){
      ground.aerialMap=legacyAerial.on!==false;
      ground.mapOpacity=legacyAerial.op??85;
      for(const key of ["gray","base","gamma","contrast","black","white"])
        if(legacyAerial[key]!==undefined)ground[key]=legacyAerial[key];
    }
    if(ground.aerialMap===undefined)ground.aerialMap=true;
    if(!Number.isFinite(+ground.mapOpacity))ground.mapOpacity=85;
    ensureDGAerialTone(ground);
  }
  for(const id of ["bldg","designBldg"]){const layer=dLayer(id);if(layer)delete layer.aerialMap;}
  if(DG.layerOpen.renderMass===undefined)DG.layerOpen.renderMass=true;
  if(DG.layerOpen.designBldg===undefined)DG.layerOpen.designBldg=true;
  const background=dLayer("background");
  if(background)Object.assign(background,{fillOn:true,strokeOn:false,w:0,op:100});
  ensureDGEnvironment();
  syncControls();renderDGLayers();
  if(DG.scene&&current)await loadScene(current,DG.radiusReq,DG.grid);
  if(needsDGAerial())loadDGAerial();else render();
}

/** 목록 위쪽일수록 같은 위치에서 더 나중에 그려지는 3D 표시 우선순위가 높다. */
function bindDGLayerDrag(){
  const box=D$("#dglayers");
  let from=null;
  const rowOf=target=>target.closest(".lyr[data-id]");
  const clear=()=>box.querySelectorAll(".lyr").forEach(row=>row.classList.remove("dragging","over"));
  box.addEventListener("dragstart",event=>{
    const row=rowOf(event.target),layer=row&&dLayer(row.dataset.id);
    if(!row||layer?.fixed){event.preventDefault();return;}
    from=row.dataset.id;row.classList.add("dragging");
    event.dataTransfer.effectAllowed="move";
    event.dataTransfer.setData("text/plain",from);
  });
  box.addEventListener("dragend",()=>{from=null;clear();});
  box.addEventListener("dragover",event=>{
    const row=rowOf(event.target),target=row&&dLayer(row.dataset.id);
    if(!from||!row||target?.fixed)return;
    event.preventDefault();
    clear();
    if(row.dataset.id!==from)row.classList.add("over");
  });
  box.addEventListener("drop",event=>{
    const row=rowOf(event.target),target=row&&dLayer(row.dataset.id);
    if(!row||!from||target?.fixed||row.dataset.id===from)return;
    event.preventDefault();
    const at=DG.layers.findIndex(layer=>layer.id===from);
    const to=DG.layers.findIndex(layer=>layer.id===row.dataset.id);
    if(at<0||to<0)return;
    const [moved]=DG.layers.splice(at,1);
    DG.layers.splice(to,0,moved);
    from=null;renderDGLayers();render();
  });
}

// 담기·주고받기의 몸통은 presets.js 가 맡는다.
const D3PS = makePresets({
  kind: "diagram3d", chipsId: "d3presets", prefix: "d3ps", fileKind: "vworld-diagram3d-presets",
  fileName: n => `3D프리셋_${n}개.json`,
  capture: d3psCapture, apply: d3psApply, label: d3psLabel,
  say: t => { const el = D$("#dginfo"); if (el) el.textContent = t; },
});


// ───────────────────────────────────────────────────────── 저장된 뷰

let D3VIEWS=[];
const d3ViewAPI=n=>`/api/presets${n?"/"+n:""}?kind=diagram3d_view`;

/** 현재 방향을 유지한 채 장면 전체가 여백 안에 들어오도록 확대·이동한다. */
function dgFitView(){
  if(!DG.scene)return;
  const cv=D$("#dgcanvas"),w=cv.clientWidth,h=cv.clientHeight;
  if(w<2||h<2)return;
  const bounds=contextBounds(),g=DG.scene.ground||{};
  let z0=(Number.isFinite(g.min)?g.min:0)*DG.vScale-DG.groundDepth;
  let z1=(Number.isFinite(g.max)?g.max:0)*DG.vScale;
  for(const b of DG.scene.buildings||[]){
    const top=terrainDisplayZ(DG.scene,b.base||0)*DG.vScale+Math.max(1,b.floors||1)*DG.floorH;
    if(top>z1)z1=top;
  }
  const world=[];
  for(const x of [bounds[0],bounds[2]])for(const y of [bounds[1],bounds[3]])
    for(const z of [z0,z1])world.push([x,y,z]);
  DG.zoom=1;DG.panX=0;DG.panY=0;
  const extents=P=>{
    const pts=world.map(q=>P.p(q[0],q[1],q[2]));
    return [Math.min(...pts.map(p=>p[0])),Math.min(...pts.map(p=>p[1])),
            Math.max(...pts.map(p=>p[0])),Math.max(...pts.map(p=>p[1]))];
  };
  let b=extents(projector()),spanX=Math.max(1,b[2]-b[0]),spanY=Math.max(1,b[3]-b[1]);
  DG.zoom=Math.max(.25,Math.min(12,Math.min((w-48)/spanX,(h-48)/spanY)));
  b=extents(projector());
  DG.panX=w/2-(b[0]+b[2])/2;DG.panY=h/2-(b[1]+b[3])/2;
  render();
}

function d3ViewPreview(){
  try{
    if(DGR&&DG.scene)DGR.render(DG.scene,DG,DG.aerial.raw,DG.selected);
    const source=DGR?D$("#dgwebgl"):D$("#dgcanvas");
    if(!source||!source.width||!source.height)return "";
    const thumb=document.createElement("canvas");thumb.width=240;thumb.height=150;
    const ctx=thumb.getContext("2d"),bg=dgBackground();
    ctx.fillStyle=bg||"#111318";ctx.fillRect(0,0,thumb.width,thumb.height);
    const scale=Math.min(thumb.width/source.width,thumb.height/source.height);
    const dw=source.width*scale,dh=source.height*scale;
    ctx.drawImage(source,(thumb.width-dw)/2,(thumb.height-dh)/2,dw,dh);
    return thumb.toDataURL("image/jpeg",.78);
  }catch{return "";}
}

function d3ViewState(){
  const state={preview:d3ViewPreview()};
  for(const k of D3_VIEW_KEYS)state[k]=DG[k];
  return state;
}

function d3ViewLabel(s){
  return `방위 ${Math.round(((s.az||0)%360+360)%360)}° · 앙각 ${Math.round(s.el||0)}°`;
}

async function d3ViewApply(s){
  stopDGCubeAnimation();
  for(const k of D3_VIEW_KEYS)if(Number.isFinite(+s[k]))DG[k]=+s[k];
  syncControls();render();
}

function d3ViewRender(){
  const box=D$("#d3views");if(!box)return;
  const slots=D3VIEWS.filter(slot=>slot&&slot.state).sort((a,b)=>a.n-b.n);
  box.innerHTML=slots.map(slot=>{
    const state=slot.state,preview=state&&/^data:image\/(?:png|jpeg);base64,/.test(state.preview||"")?state.preview:"";
    return `<div class="d3-view-card">
      <button type="button" data-view-slot="${slot.n}" title="이 뷰로 전환">
        ${preview?`<img src="${dgEsc(preview)}" alt="저장된 뷰 ${slot.n}">`:`<div class="d3-view-empty">미리보기 없음</div>`}
        <span>${dgEsc(slot.label||d3ViewLabel(state))}</span>
      </button>
      <button type="button" class="d3-view-del" data-view-del="${slot.n}" title="이 뷰 지우기">×</button>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-view-slot]").forEach(button=>button.onclick=()=>{
    const n=+button.dataset.viewSlot,slot=D3VIEWS.find(s=>s.n===n);
    if(slot&&slot.state)d3ViewApply(slot.state);
  });
  box.querySelectorAll("[data-view-del]").forEach(button=>button.onclick=()=>d3ViewDelete(+button.dataset.viewDel));
}

async function d3ViewLoad(){
  try{
    const r=await fetch(d3ViewAPI());
    if(!r.ok)throw new Error("저장된 뷰를 불러오지 못했습니다.");
    D3VIEWS=((await r.json()).slots||[]).filter(slot=>slot&&slot.state);
  }catch(error){D$("#d3view-note").textContent=error.message||"저장된 뷰를 불러오지 못했습니다.";}
  d3ViewRender();
}

async function d3ViewSave(){
  const used=new Set(D3VIEWS.filter(slot=>slot&&slot.state).map(slot=>slot.n));
  const n=[1,2,3,4,5].find(slot=>!used.has(slot));
  if(!n){D$("#d3view-note").textContent="뷰는 최대 5개까지 저장할 수 있습니다.";return;}
  const state=d3ViewState(),label=d3ViewLabel(state);
  try{
    const r=await fetch(d3ViewAPI(n),{method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({label,state})});
    if(!r.ok)throw new Error("뷰를 저장하지 못했습니다.");
    D$("#d3view-note").textContent="현재 뷰를 저장했습니다.";await d3ViewLoad();
  }catch(error){D$("#d3view-note").textContent=error.message||"뷰를 저장하지 못했습니다.";}
}

async function d3ViewDelete(n){
  if(!confirm(`저장된 뷰 ${n}을 지울까요?`))return;
  try{
    const r=await fetch(d3ViewAPI(n),{method:"DELETE"});
    if(!r.ok)throw new Error("뷰를 지우지 못했습니다.");
    D$("#d3view-note").textContent="저장된 뷰를 지웠습니다.";await d3ViewLoad();
  }catch(error){D$("#d3view-note").textContent=error.message||"뷰를 지우지 못했습니다.";}
}


function syncControls() {
  ensureDGEnvironment();
  const bg=dLayer("background");
  if(bg){const [r,g,b]=rgbOf(bg.fill);DG.paper=(r*299+g*587+b*114)/1000>125;}
  D$("#dg-el").value=Math.round(DG.el);
  D$("#dg-elv").textContent=Math.round(DG.el)+"°";
  const values={floorH:DG.floorH,vScale:DG.vScale,groundDepth:DG.groundDepth,
                radiusReq:DG.radiusReq,grid:DG.grid};
  for(const [k,v] of Object.entries(values)){
    const input=D$(`#dglayers [data-d3-k="${k}"]`);if(input)input.value=v;
  }
  const labels={floorH:DG.floorH.toFixed(1)+" m",vScale:"×"+DG.vScale,
                groundDepth:DG.groundDepth.toFixed(1)+" m"};
  for(const [k,v] of Object.entries(labels)){
    const label=D$(`#dglayers [data-d3-v="${k}"]`);if(label)label.textContent=v;
  }
  D$("#dg-outline").checked=DG.outline;D$("#dg-quality").value=DG.renderQuality;
  document.querySelectorAll("#dg-render-modes [data-render-mode]").forEach(
    b=>b.classList.toggle("on",b.dataset.renderMode===DG.renderMode));
  dgSyncSectionUI();
}

// ───────────────────────────────────────────────────────── 조작

function bindDiagram() {
  const cv = D$("#dgcanvas");
  let last = null, mode = null;
  const repaint=()=>{
    render();
    if(D$("#dgmodal").style.display==="flex")dgExportPreview();
  };

  const local = e => {
    const r = cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  let cropFrom = null;

  cv.addEventListener("pointerdown", e => {
    if(DG.pickBuildingMode){
      const hit=DGR?.pickBuilding(...local(e));
      if(hit){
        if(e.ctrlKey||e.metaKey){
          if(DG.selectedBuildings.has(hit.key))DG.selectedBuildings.delete(hit.key);
          else DG.selectedBuildings.add(hit.key);
        }else{
          DG.selectedBuildings.clear();DG.selectedBuildings.add(hit.key);
        }
      }else DG.selectedBuildings.clear();
      renderDGLayers();render();return;
    }
    if (DG.cropMode) { cv.setPointerCapture(e.pointerId); cropFrom = local(e); return; }
    if(cubeTurnHit(...local(e))){
      DG.cubeTurnHover=false;turnDGPlanClockwise();return;
    }
    // 뷰큐브를 눌렀으면 회전이 아니라 시점 이동이다
    const hit = cubeHit(...local(e));
    if (hit) {
      const [az, el] = aimOf(hit);
      DG.cubeHover = null;
      animateDGCubeView(az,el);
      return;
    }
    stopDGCubeAnimation();
    cv.setPointerCapture(e.pointerId);
    last = [e.clientX, e.clientY];
    mode = (e.button === 2 || e.shiftKey) ? "pan" : "orbit";
    DG.dragging = true;
  });
  cv.addEventListener("pointermove", e => {
    if (cropFrom) {
      const [x, y] = local(e);
      dgSetCrop({ x: Math.min(x, cropFrom[0]), y: Math.min(y, cropFrom[1]),
                  w: Math.abs(x - cropFrom[0]), h: Math.abs(y - cropFrom[1]) });
      return;
    }
    if (!last) {
      if(DG.pickBuildingMode){cv.style.cursor="crosshair";cv.title="교체할 DESIGN AREA 건물을 선택";return;}
      const point=local(e),turn=cubeTurnHit(...point),hit=turn?null:cubeHit(...point);
      const changed = String(hit) !== String(DG.cubeHover)||turn!==!!DG.cubeTurnHover;
      DG.cubeTurnHover=turn;
      DG.cubeHover = hit;
      cv.style.cursor = hit||turn ? "pointer" : "grab";
      cv.title=turn?"평면을 시계방향으로 90° 회전":"";
      if (changed) render();
      return;
    }
    const dx = e.clientX - last[0], dy = e.clientY - last[1];
    last = [e.clientX, e.clientY];
    if (mode === "pan") { DG.panX += dx; DG.panY += dy; }
    else {
      // 화면이 손을 따라오게 한다(모델을 잡아 돌리는 방식).
      DG.az += dx * 0.4;
      DG.el = Math.max(2, Math.min(90, DG.el + dy * 0.3));
      D$("#dg-el").value = Math.round(DG.el);
      D$("#dg-elv").textContent = Math.round(DG.el) + "°";
    }
    render();
  });
  const stop = () => {
    last = null;
    if (cropFrom) {
      cropFrom = null;
      if (DG.crop && (DG.crop.w < 12 || DG.crop.h < 12)) DG.crop = null;
      dgSetCrop(DG.crop);
      return;
    }
    if (DG.dragging) { DG.dragging = false; render(); }
  };
  cv.addEventListener("pointerup", stop);
  cv.addEventListener("pointercancel", stop);
  cv.addEventListener("contextmenu", e => e.preventDefault());
  cv.addEventListener("wheel", e => {
    e.preventDefault();
    const [mx,my]=local(e),oldZoom=DG.zoom;
    const nextZoom=Math.max(0.25,Math.min(18,oldZoom*(e.deltaY<0?1.12:0.89)));
    const ratio=nextZoom/oldZoom;
    // 포인터 아래의 장면 좌표가 확대 전후 같은 화면 픽셀에 남도록 중심을 보정한다.
    const anchorX=cv.clientWidth/2+DG.panX,anchorY=cv.clientHeight/2+DG.panY;
    DG.panX+=(mx-anchorX)*(1-ratio);DG.panY+=(my-anchorY)*(1-ratio);
    DG.zoom=nextZoom;
    render();
  }, { passive: false });

  const on = (id, ev, fn) => D$(id).addEventListener(ev, fn);
  on("#dg-el", "input", e => {
    stopDGCubeAnimation();
    DG.el=+e.target.value;D$("#dg-elv").textContent=Math.round(DG.el)+"°";render();
  });
  on("#dg-section-on", "change", e=>{
    ensureDGEnvironment();DG.section.on=e.target.checked;
    if(DG.section.on)dgSectionToCurrentView({focusDesign:dgDesignPolygons().length>0});
    else{dgSyncSectionUI();render();}
  });
  on("#dg-section-position", "input", e=>{
    DG.section.position=+e.target.value;dgSyncSectionUI();render();
  });
  on("#dg-section-angle", "input", e=>{
    DG.section.az=+e.target.value;dgSyncSectionUI();render();
  });
  on("#dg-section-color", "input", e=>{DG.section.color=e.target.value;render();});
  on("#dg-section-align", "click", ()=>dgSectionToCurrentView());
  on("#dg-section-focus", "click", ()=>dgSectionToCurrentView({focusDesign:true}));
  D$("#dglayers").addEventListener("input",e=>{
    if(e.target.classList.contains("d3-expcb")){
      DG.layerOpen[e.target.dataset.layerOpen]=e.target.checked;return;
    }
    if(e.target.hasAttribute("data-sun-mode")){
      DG.sunMode=e.target.checked?"datetime":"manual";
      if(DG.sunMode==="datetime")applyDGSunDateTime();else syncDGSunUI();
      return;
    }
    if(e.target.hasAttribute("data-sun-datetime")){
      DG.sunDateTime=e.target.value;DG.sunMode="datetime";
      if(DG.sunDateTime)applyDGSunDateTime();else syncDGSunUI();
      return;
    }
    const toneKey=e.target.dataset.d3ToneK;
    if(toneKey){
      const L=dLayer("ground");ensureDGAerialTone(L);L[toneKey]=+e.target.value;
      queueDGTone();return;
    }
    const dk=e.target.dataset.d3K;
    if(dk){
      if(dk==="terrainMode"){
        DG.terrainMode=e.target.value==="stepped"?"stepped":"natural";repaint();return;
      }
      const v=+e.target.value;
      if(dk==="radiusReq"){
        if(v>DG.fullRadius&&!dgContextCovered(v)){
          DG.pendingRadius=v;DG.contextProgress=0;DG.contextStatus="";renderDGLayers();return;
        }
        DG.pendingRadius=0;DG.contextStatus="";return loadScene(current,v,DG.grid);
      }
      if(dk==="grid")return loadScene(current,DG.radiusReq,v);
      DG[dk]=v;
      const label=D$(`#dglayers [data-d3-v="${dk}"]`);
      if(label)label.textContent=dk==="floorH"||dk==="groundDepth"?v.toFixed(1)+" m":"×"+v;
      repaint();return;
    }
    const layerKey=e.target.dataset.d3LayerK;
    if(layerKey){
      const L=dLayer(e.target.dataset.layerId);
      if(L)L[layerKey]=e.target.type==="checkbox"?e.target.checked:
        (e.target.type==="number"||e.target.type==="range")?+e.target.value:e.target.value;
      if(L?.id==="renderMass"&&(layerKey==="mapping"||layerKey==="caps")){
        renderDGLayers();
        repaint();
        return;
      }
      if(L?.id==="ground"&&["aerialMap","gray","base","mapOpacity"].includes(layerKey)){
        if(layerKey!=="mapOpacity")renderDGLayers();
        if(layerKey!=="mapOpacity"&&needsDGAerial())loadDGAerial();else repaint();
        return;
      }
      if(L?.id==="sky"&&(layerKey==="clouds"||layerKey==="sunGlow")){
        const label=e.target.parentElement?.querySelector("b");if(label)label.textContent=`${e.target.value}%`;
      }
      repaint();return;
    }
    const sk=e.target.dataset.shadowK;
    if(sk){
      const v=+e.target.value;
      if(sk==="op")dLayer("shadow").op=v;else{
        DG[sk]=v;DG.sunMode="manual";
      }
      const label=D$("#dglayers").querySelector(`[data-shadow-v="${sk}"]`);
      if(label)label.textContent=sk==="sunAz"||sk==="sunAlt"?v.toFixed(1)+"°":sk==="op"?v+"%":v;
      const rowOp=D$("#dglayers [data-id=shadow] [data-k=op]");if(sk==="op"&&rowOp)rowOp.value=v;
      if(sk==="sunAz"||sk==="sunAlt")syncDGSunUI();
      repaint();return;
    }
    const row=e.target.closest(".lyr[data-id]");if(!row||!e.target.dataset.k)return;
    const L=dLayer(row.dataset.id),k=e.target.dataset.k;
    if(L?.id==="renderMass"&&k==="on"){
      L.on=e.target.checked;renderDGLayers();
      repaint();
      return;
    }
    const oldW=+L.w||0;
    const nextW=k==="w"?dgLineWidthFromInput(e.target):null;
    if(k==="w"&&nextW===null)return;
    L[k]=k==="w"?nextW:e.target.type==="checkbox"?e.target.checked:
         (e.target.type==="number"||e.target.type==="range")?+e.target.value:e.target.value;
    syncDGLineControls(row,L,k,oldW);
    if(L.id==="background"&&k==="fill"){
      const [r,g,b]=rgbOf(L.fill);DG.paper=(r*299+g*587+b*114)/1000>125;
    }
    if(L.id==="shadow"&&k==="op"){
      const slider=D$("#dglayers [data-shadow-k=op]"),label=D$("#dglayers [data-shadow-v=op]");
      if(slider)slider.value=L.op;if(label)label.textContent=L.op+"%";
    }
    repaint();
  });
  D$("#dglayers").addEventListener("focusout",e=>{
    if(e.target.dataset.k!=="w")return;
    const row=e.target.closest(".lyr[data-id]");if(!row)return;
    const L=dLayer(row.dataset.id);if(!L)return;
    const oldW=+L.w||0,nextW=dgLineWidthFromInput(e.target);
    L.w=nextW===null?0:nextW;
    syncDGLineControls(row,L,"w",oldW);
    e.target.value=L.w;
    repaint();
  });
  D$("#dglayers").addEventListener("change",async e=>{
    if(!e.target.hasAttribute("data-d3-model-file"))return;
    const file=e.target.files?.[0];e.target.value="";
    if(!file||!DG.selected.size)return;
    if(!/\.(glb|3dm)$/i.test(file.name))return alert("GLB 또는 Rhino 3DM 파일을 선택해 주세요.");
    const renderer=DGR||await ensure3DRenderer();
    if(!renderer)return alert("모델을 넣으려면 WebGL 렌더러가 필요합니다.");
    DG.modelBusy=true;renderDGLayers();
    try{
      const [x,y]=dgDesignCenter();
      const loaded=await renderer.loadBuildingModel(DESIGN_AREA_MODEL_KEY,file,{
        data:DG.scene,state:DG,fitToTarget:false,
        placement:{x,y,z:terrainHeightAt(x,y)*DG.vScale,scale:1},
      });
      render();dgOpenModelPlacement(loaded,null);
    }catch(error){alert("건물 모델을 불러오지 못했습니다: "+(error.message||error));}
    finally{DG.modelBusy=false;renderDGLayers();}
  });
  D$("#dglayers").addEventListener("click",e=>{
    if(e.target.closest("[data-d3-building-pick]")){
      if(!DGR)return ensure3DRenderer().then(renderer=>{
        if(!renderer)alert("건물 객체 선택에는 WebGL 렌더러가 필요합니다.");
        else{DG.pickBuildingMode=true;renderDGLayers();cv.style.cursor="crosshair";}
      });
      DG.pickBuildingMode=!DG.pickBuildingMode;
      if(!DG.pickBuildingMode){cv.style.cursor="grab";cv.title="";}
      else cv.style.cursor="crosshair";
      renderDGLayers();return;
    }
    if(e.target.closest("[data-d3-model-open]")){
      const designLayer=dLayer("designBldg");if(designLayer)designLayer.on=true;
      D$("#dglayers [data-d3-model-file]")?.click();return;
    }
    if(e.target.closest("[data-d3-building-remove]")){
      if(!DG.selectedBuildings.size)return;
      for(const key of DG.selectedBuildings)DG.removedBuildings.add(key);
      renderDGLayers();render();return;
    }
    if(e.target.closest("[data-d3-model-edit]")){dgEditBuildingModel();return;}
    if(e.target.closest("[data-sun-now]")){
      DG.sunDateTime=dgKSTNow();DG.sunMode="datetime";applyDGSunDateTime();return;
    }
    if(e.target.closest("[data-d3-tone-reset]")){
      const L=dLayer("ground");Object.assign(L,{gamma:1,contrast:0,black:0,white:255});
      renderDGLayers();applyDGTone();return;
    }
    const button=e.target.closest("[data-d3-expand]");
    if(button)expandDGContext(+button.dataset.d3Expand);
  });

  const placementCanvas=D$("#dgp-canvas");
  const placementFromEvent=event=>{
    const active=DG.modelPlacement,view=active?.view;if(!active||!view)return null;
    const rect=placementCanvas.getBoundingClientRect();
    const px=(event.clientX-rect.left)*placementCanvas.width/rect.width;
    const py=(event.clientY-rect.top)*placementCanvas.height/rect.height;
    return dgClampToDesignArea((px-view.ox)/view.scale,(view.oy-py)/view.scale);
  };
  placementCanvas.addEventListener("pointerdown",event=>{
    if(!DG.modelPlacement)return;
    placementCanvas.setPointerCapture(event.pointerId);DG.modelPlacement.dragging=true;
    const point=placementFromEvent(event);if(point)dgSetModelPlacement({x:point[0],y:point[1]});
  });
  placementCanvas.addEventListener("pointermove",event=>{
    if(!DG.modelPlacement?.dragging)return;
    const point=placementFromEvent(event);if(point)dgSetModelPlacement({x:point[0],y:point[1]});
  });
  const stopPlacementDrag=()=>{if(DG.modelPlacement)DG.modelPlacement.dragging=false;};
  placementCanvas.addEventListener("pointerup",stopPlacementDrag);
  placementCanvas.addEventListener("pointercancel",stopPlacementDrag);
  D$("#dgplacemodal").addEventListener("input",event=>{
    const key=event.target.dataset.dgpK;if(!key||!DG.modelPlacement)return;
    const value=Number(event.target.value);if(!Number.isFinite(value))return;
    if(key==="x"||key==="y"){
      const info=DGR?.buildingModelInfo(DG.modelPlacement.transaction.key),placement=info?.placement;if(!placement)return;
      const point=dgClampToDesignArea(key==="x"?value:placement.x,key==="y"?value:placement.y);
      dgSetModelPlacement({x:point[0],y:point[1]});
    }else dgSetModelPlacement({[key]:value});
  });
  on("#dgp-reset","click",()=>{
    const initial=DG.modelPlacement?.transaction?.initialPlacement;if(initial)dgSetModelPlacement({...initial});
  });
  on("#dgp-cancel","click",()=>dgCloseModelPlacement(false));
  on("#dgp-remove","click",dgRemoveEditedBuildingModel);
  on("#dgp-apply","click",()=>dgCloseModelPlacement(true));
  D$("#dgplacemodal").addEventListener("click",event=>{
    if(event.target.id==="dgplacemodal")dgCloseModelPlacement(false);
  });

  document.querySelectorAll("#dg-render-modes [data-render-mode]").forEach(b=>
    b.addEventListener("click",()=>{
      DG.renderMode=b.dataset.renderMode==="aerial"?"aerial":"diagram";
      const mappingOn=DG.renderMode==="aerial",mass=dLayer("renderMass"),ground=dLayer("ground");
      if(mass)mass.mapping=mappingOn;
      if(ground)ground.aerialMap=mappingOn;
      document.querySelectorAll("#dg-render-modes [data-render-mode]").forEach(
        x=>x.classList.toggle("on",x===b));
      renderDGLayers();
      // VWorld 실물 텍스처는 이미 타일에 들어 있으므로 항공사진 다운로드를
      // 기다리지 않고 현재 뷰에 먼저 전환한다.
      repaint();
      if(needsDGAerial()){
        loadDGAerial().then(()=>{if(D$("#dgmodal").style.display==="flex")dgExportPreview();});
      }
    }));
  on("#dg-outline","change",e=>{DG.outline=e.target.checked;repaint();});
  on("#dg-quality","change",e=>{DG.renderQuality=e.target.value;repaint();});

  cv.addEventListener("pointerleave", () => {
    if (DG.cubeHover||DG.cubeTurnHover) {
      DG.cubeHover=null;DG.cubeTurnHover=false;cv.title="";render();
    }
  });

  on("#dg-reset", "click", () => {
    stopDGCubeAnimation();
    Object.assign(DG, { az: 35, el: 32, zoom: D3_STYLE_BASE_ZOOM, panX: 0, panY: 0 });
    syncControls(); render();
  });
  on("#dg-fit","click",dgFitView);
  on("#d3view-save","click",d3ViewSave);

  on("#dg-go","click",dgOpenExport);
  on("#dg-nano-open","click",dgOpenNanoRender);
  on("#dgn-render","click",dgRunNanoRender);
  on("#dgn-download","click",()=>{
    if(!DG.nano.result)return;
    const link=document.createElement("a");link.download=`${dgStem()}_NanoBanana.png`;
    link.href=DG.nano.result;link.click();
  });
  on("#dgn-cancel","click",()=>{
    if(DG.nano.busy)return;
    D$("#dgnanomodal").style.display="none";D$("#dgmodal").style.display="flex";dgExportPreview();
  });
  D$("#dgnanomodal").addEventListener("click",event=>{
    if(event.target.id==="dgnanomodal")D$("#dgn-cancel").click();
  });
  on("#dgm-cancel","click",()=>{DG.cropMode=false;dgSetCrop(DG.crop);D$("#dgmodal").style.display="none";});
  D$("#dgmodal").addEventListener("click",e=>{if(e.target.id==="dgmodal")D$("#dgm-cancel").click();});
  document.querySelectorAll("#dgm-fmt button").forEach(b=>b.addEventListener("click",()=>{
    document.querySelectorAll("#dgm-fmt button").forEach(x=>x.classList.toggle("on",x===b));
    DG.fmt=b.dataset.fmt;D$("#dgm-scale").disabled=DG.fmt!=="png";dgExportPreview();
  }));
  on("#dgm-scale","change",e=>{DG.scale=+e.target.value;dgSetCrop(DG.crop);dgExportPreview();});
  on("#dgm-fit","click",()=>{dgFitView();dgExportPreview();});
  on("#dgm-crop","click",()=>{DG.cropMode=true;dgSetCrop(DG.crop);D$("#dgmodal").style.display="none";});
  on("#dgm-cropoff","click",()=>{DG.cropMode=false;dgSetCrop(null);dgExportPreview();});
  on("#dgm-go","click",()=>{
    if(DG.fmt==="svg")exportSVG();else if(DG.fmt==="aizip")exportDGAIPackage();
    else if(DG.fmt==="glb")exportGLB();else if(DG.fmt==="3dm")export3DM();else exportPNG();
    D$("#dgmodal").style.display="none";
  });
  document.addEventListener("keydown",e=>{
    if(!DG.cropMode||e.key!=="Enter")return;e.preventDefault();dgFinishCrop();
  });

  bindDGLayerDrag();
  renderDGLayers();
  syncControls();
  ensure3DRenderer();
  D3PS.bind();      // 담기·주고받기 단추는 presets.js 가 붙인다
  d3ViewLoad();
  dgSetCrop(null);
  window.addEventListener("resize", () => { if (DG.scene) render(); });
}
