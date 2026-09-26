/* 2D 다이어그램 — 받아온 벡터를 평면에 깔고, 레이어마다 채우기·선색·굵기를 만진다.
 *
 * 3D와 같은 /api/site/{name}/scene 자료를 쓴다. 좌표가 이미 미터라
 * 여기서 정한 굵기(mm)를 그대로 도면 축척에 맞출 수 있다.
 * 그리기 목록은 draw.js 를 공유하므로 화면·PNG·SVG가 항상 같다.
 */

const P2 = {
  scene: null,
  zoom: 1.0, panX: 0, panY: 0,
  radius: 250,
  bg: "#ffffff",
  selected: new Set(),
  // 목록에 보이는 순서 그대로. **맨 위가 맨 위에 그려진다.**
  // 그릴 때만 뒤집어 쓴다 — 그래야 끌어서 옮기는 게 눈에 보이는 것과 같아진다.
  aerial: { img: null, href: "", key: "", loading: false, radius: 0,
            progress: 0, phase: "", jobId: "" },
  precision: {catalog:[], data:{}, loading:{}, errors:{}, site:"", catalogLoading:false},
  roadCatalog: null,
  crop: null, cropMode: false, scale: 2,   // 내보낼 범위 · PNG 배율
  exportScope: null,                       // null | context | project | design
  rulesOpen: {},                           // 레이어별로 조건 칸을 펴 두었는지
  bgNone: false,                           // 바탕 없이 — PNG·SVG 가 투명하게 나간다
  // 도판을 꾸미는 것들. 자료가 아니라 표현이라 레이어 목록과 따로 둔다.
  design: {
    grid:   {on: false, mode: "step", step: 50, cols: 10, rows: 10,
             w: 0.4, color: "#9aa3b2", op: 35, ls: "solid",
             dx: 0, dy: 0},          // 간격 모드에서는 격자를 동·북으로 옮길 수 있다
    // 비네트는 장면 좌표(미터)로 잡는다. 화면 % 로 두면 확대·이동할 때마다
    // 도면 위에서 자리가 흔들려, 같은 곳을 강조하고 있다고 말할 수 없다.
    // cx·cy 는 대상지 중심에서의 거리, rx·ry 는 반경. 0 이면 수집 반경의 60%.
    vig:    {on: false, shape: "ellipse", color: "#0e1013", op: 55,
             cx: 0, cy: 0, rx: 0, ry: 0, feather: 45},
    shadow: {on: false, color: "#26303c", op: 35, blur: 4, angle: 135, dist: 3},
    noise:  {on: false, amount: 5, distribution: "gaussian",
             monochromatic: true, seed: 2701},
  },
  // 건물 조건 레이어 — 대장 속성으로 골라 색을 달리한다. 위에서부터 먼저 맞는 규칙을 쓴다.
  rules: [], ruleCount: {}, rulesSeeded: false, choices: {},
  // op = 투명도(%). 채우기 색 자체의 알파와 곱해진다.
  layers: [
    { id: "site",    name: "03 DESIGN AREA", on: true, fill: "#e2564a", fillOn: true,  stroke: "#c0392b", strokeOn: true, w: 1.6, op: 100, ls: "solid", hull: false },
    { id: "boundary", name: "02 PROJECT SITE", on: true, fill: "#e0b088", fillOn: false, stroke: "#c8791f", strokeOn: true, w: 1.8, op: 100, ls: "solid" },
    { id: "spot",    name: "표고점",   on: false, fill: "#7a869a", fillOn: true,  stroke: "#7a869a", strokeOn: true, w: 0.6, op: 100, ls: "solid" },
    { id: "bldg",    name: "건물",     on: true,  fill: "#dfe3ea", fillOn: true,  stroke: "#3c4048", strokeOn: true, w: 0.5, op: 100, ls: "solid" },
    // 도로면 — 지역별 VWorld 실폭도로/도로경계 Polygon을 대상지 BBOX로 자른다.
    // 지역 SHP가 없을 때만 NGII 도로중심선의 폭 속성으로 만든 fallback이 온다.
    { id: "roadarea", name: "도로면 · VWorld Polygon", on: true, fill: "#ece7dc", fillOn: true, stroke: "#cfc7b5", strokeOn: true, w: 0.4, op: 100, ls: "solid",
      analysis: {on: false, field: "rvwd", low: "#ffffff", high: "#e2564a", op: 100, blend: 8},
      precision: {items:{}} },
    { id: "road",    name: "도로명 중심선 · 보조", on: false, fill: "#000000", fillOn: false, stroke: "#d8d2c4", strokeOn: true, w: 1.0, op: 100, ls: "solid" },
    { id: "contour", name: "등고선",   on: true,  fill: "#000000", fillOn: false, stroke: "#c2a86a", strokeOn: true, w: 0.6, op: 100, ls: "solid" },
    { id: "parcel",  name: "필지",     on: true,  fill: "#f7f7f4", fillOn: false, stroke: "#9aa3b2", strokeOn: true, w: 0.4, op: 100, ls: "solid",
      hatch: {on:false, spacing:9, w:.45, op:55, categories:{
        residential:{on:true, pattern:"diag", color:"#c79a3b"},
        commercial:{on:true, pattern:"cross", color:"#d65a5a"},
        industrial:{on:true, pattern:"horizontal", color:"#8d6bb8"},
        green:{on:true, pattern:"dots", color:"#5b9b63"},
      }} },
    { id: "zone",    name: "용도지역", on: false, fill: "#eef2fb", fillOn: true,  stroke: "#9db4de", strokeOn: true, w: 0.4, op: 100, ls: "solid" },
    // 지형 · 대지 — 3D 의 지반을 위에서 내려다본 것. 3D 와 같은 격자를 쓴다.
    // sun 은 해의 방위(°), alt 는 고도(°), relief 는 음영 세기, tint 는 표고 채색 세기.
    { id: "ground",  name: "지형 · 대지", on: false, fill: "#ded9cc", fillOn: true,
      stroke: "#aaa292", strokeOn: false, w: 0, op: 100, ls: "solid",
      sun: 315, alt: 45, relief: 65, tint: 0, lo: "#efeadd", hi: "#b4a98f" },
    // 바탕 사진 — 보통 맨 아래지만 끌어 올려 반투명으로 덮을 수도 있다.
    // gamma·contrast 는 흑백으로 받았을 때의 톤 곡선이다 (포토샵 커브 대신).
    { id: "aerial",  name: "위성사진", on: false, gray: false, base: false, op: 100,
      gamma: 1.0, contrast: 0, black: 0, white: 255 },
    // 바탕색 — 항상 맨 아래. 사진보다도 밑이라 목록에서 옮길 수 없다.
    { id: "bgfill",  name: "바탕색", on: true, fixed: true, op: 100 },
  ],
};

const P2$ = s => document.querySelector(s);
const layerOf = id => P2.layers.find(l => l.id === id);
const polygonGroups = item => Array.isArray(item?.polygons) && item.polygons.length
  ? item.polygons : (item?.rings || []).map(ring => [ring]);


// 선 종류 — 값은 굵기의 배수다. 굵기를 바꿔도 비율이 유지된다.
const DASHES = [
  { id: "solid",  name: "실선",     dash: [] },
  { id: "dash",   name: "파선",     dash: [4, 3] },
  { id: "dot",    name: "점선",     dash: [1, 2] },
  { id: "dashdot",name: "일점쇄선", dash: [6, 2, 1, 2] },
  { id: "dashdotdot", name: "이점쇄선", dash: [6, 2, 1, 2, 1, 2] },
  { id: "long",   name: "긴파선",   dash: [8, 4] },
];
const dashOf = id => (DASHES.find(d => d.id === id) || DASHES[0]).dash;

const PARCEL_HATCH_CATEGORIES = [
  {id:"residential", name:"주거", keyword:"주거", pattern:"diag", color:"#c79a3b"},
  {id:"commercial", name:"상업", keyword:"상업", pattern:"cross", color:"#d65a5a"},
  {id:"industrial", name:"공업", keyword:"공업", pattern:"horizontal", color:"#8d6bb8"},
  {id:"green", name:"녹지", keyword:"녹지", pattern:"dots", color:"#5b9b63"},
];
const HATCH_PATTERNS = [
  {id:"diag", name:"사선"}, {id:"cross", name:"교차선"},
  {id:"horizontal", name:"수평선"}, {id:"vertical", name:"수직선"},
  {id:"dots", name:"점"},
];

function parcelZoneCategory(zone) {
  const value = String(zone || "");
  return PARCEL_HATCH_CATEGORIES.find(category => value.includes(category.keyword))?.id || "";
}

function parcelHatchState(layer = layerOf("parcel")) {
  const current = layer?.hatch || {}, categories = {};
  for (const category of PARCEL_HATCH_CATEGORIES)
    categories[category.id] = {on:true, pattern:category.pattern, color:category.color,
      ...(current.categories?.[category.id] || {})};
  const state = {on:false, spacing:9, w:.45, op:55, ...current, categories};
  if (layer) layer.hatch = state;
  return state;
}

// ───────────────────────────────────────────────── 조건 (DB 질의 같은 것)
//
// 조건은 레이어의 하위 레이어다. 건물뿐 아니라 필지·용도지역에도 걸 수 있다.
// 무엇으로 고를 수 있는지는 그 레이어가 들고 있는 값에 달렸다.

// 구역 — 조건마다 「어디에 있는 것」인지 하나 더 건다.
// 비우면 전체에 걸린다. 구역만 걸면 그 안 전부, 속성과 같이 걸면 둘 다 맞는 것만.
const ZONES = [
  {v: "",        name: "구역 전체"},
  {v: "ps-in",   name: "PROJECT SITE 안"},
  {v: "ps-out",  name: "PROJECT SITE 밖"},
  {v: "da-in",   name: "DESIGN AREA 안"},
  {v: "da-out",  name: "DESIGN AREA 밖"},
];

// t: "pick" 은 실제로 들어 있는 값으로 채우는 드롭다운.
// 자유 입력으로 두면 무엇을 칠 수 있는지 알 방법이 없다 — 대장 용어는
// 「일반목구조」「목구조」처럼 갈래가 많아 짐작으로는 못 맞힌다.
// src 는 장면 객체에서 그 값을 읽는 열쇠 (조건 칸 이름과 다를 수 있다).
const RULE_FIELDS = {
  bldg: [
    {k: "strct", t: "pick", label: "구조",  src: "strct"},
    {k: "purps", t: "pick", label: "용도",  src: "purps"},
    {k: "y0",    t: "num",  label: "연도",  ph: "1950", pair: "y1", ph2: "1969", src: "year"},
    {k: "f0",    t: "num",  label: "층",    ph: "1",    pair: "f1", ph2: "3",    src: "floors"},
  ],
  parcel: [
    {k: "jimok",    t: "pick", label: "지목",     src: "jimok"},
    {k: "zone",     t: "pick", label: "용도지역", src: "zone"},
    {k: "district", t: "pick", label: "지구단위", src: "district"},
    {k: "a0",       t: "num",  label: "면적 m²",  ph: "100", pair: "a1", ph2: "300", src: "area"},
  ],
  zone: [
    {k: "zname", t: "pick", label: "이름", src: "name"},
  ],
};

/** 조건을 걸 수 있는 레이어인지 */
const canRule = id => !!RULE_FIELDS[id];

const itemsOf = layer => {
  const sc = P2.scene;
  if (!sc) return [];
  return layer === "bldg" ? sc.buildings
       : layer === "parcel" ? sc.parcels
       : layer === "zone" ? (sc.zones || []) : [];
};

/** 처음 여는 대상지에서는 조건 두 개를 실제 값으로 채워 둔다.
 *  「이렇게 쓰는 것」을 빈 칸으로 설명하기는 어렵다. 한 번만 하고, 지우면 그만이다. */
function seedRules() {
  if (P2.rulesSeeded || !P2.scene) return;
  P2.rulesSeeded = true;
  const strct = (P2.choices.bldg && P2.choices.bldg.strct) || [];
  const pick = word => (strct.find(([v]) => v.includes(word)) || [])[0];
  const wood = pick("목"), rc = pick("철근");
  P2.rules = [];
  if (wood) P2.rules.push(newRule("bldg",
    { name: wood, strct: wood, fill: "#c8791f", stroke: "#8a5210" }));
  if (rc) P2.rules.push(newRule("bldg",
    { name: rc, strct: rc, fill: "#7a869a", stroke: "#4d5766" }));
  // 처음 진입할 때는 세부 조건을 접어 둔다. 사용자가 직접 펼친 뒤에는
  // rulesOpen 상태가 그대로 유지된다.
  P2.rulesOpen.bldg = false;
}

/** 이 대상지에 실제로 들어 있는 값들. 많은 것부터. 숫자 칸은 최소·최대. */
function buildChoices() {
  const out = {};
  for (const [layer, fields] of Object.entries(RULE_FIELDS)) {
    const items = itemsOf(layer);
    out[layer] = {};
    for (const f of fields) {
      if (f.t === "pick") {
        const n = new Map();
        for (const o of items) {
          const v = String(o[f.src] || "").trim();
          if (v) n.set(v, (n.get(v) || 0) + 1);
        }
        out[layer][f.k] = [...n.entries()].sort((a, b) => b[1] - a[1]);
      } else if (f.t === "num") {
        let lo = Infinity, hi = -Infinity;
        for (const o of items) {
          const v = parseFloat(o[f.src]);
          if (isFinite(v) && v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        }
        out[layer][f.k] = isFinite(lo) ? [Math.round(lo), Math.round(hi)] : null;
      }
    }
  }
  P2.choices = out;
}

let ruleSeq = 0;

function newRule(layer, patch = {}) {
  return { id: "r" + (++ruleSeq), layer, on: true, name: "새 조건", area: "",
           strct: "", purps: "", y0: "", y1: "", f0: "", f1: "",
           jimok: "", zone: "", district: "", a0: "", a1: "", zname: "",
           fill: "#e2564a", fillOn: true, stroke: "#a5342a", strokeOn: true, w: 0.5, op: 100,
           ls: "solid", ...patch };
}

// ── 구역 판정
//
// 필지는 pnu 로 DESIGN AREA 를 바로 안다. 건물은 필지 위에 얹혀 있을 뿐이라
// 도형이 겹치는지로 본다 — 건물 셋 중 하나가 필지 경계를 넘기 때문이다.
// PROJECT SITE 는 장면이 실어 준 경계 고리(sc.boundary)로 본다.

function ptInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) &&
        x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** 도형의 대표점(첫 고리의 무게중심)이 PROJECT SITE 경계 안인가 */
function inProjectSite(o) {
  const rings = P2.scene && P2.scene.boundary;
  if (!rings || !rings.length) return null;        // 경계를 안 그렸으면 따질 수 없다
  const r = o.rings && o.rings[0];
  if (!r || !r.length) return false;
  let sx = 0, sy = 0;
  for (const q of r) { sx += q[0]; sy += q[1]; }
  const cx = sx / r.length, cy = sy / r.length;
  let hit = false;
  for (const ring of rings) if (ptInRing(ring, cx, cy)) hit = !hit;
  return hit;
}

/** DESIGN AREA — 고른 필지들. 건물은 그 필지와 겹치는지로 본다. */
function inDesignArea(o, layer) {
  if (!P2.selected.size) return false;
  if (layer === "parcel") return P2.selected.has(o.pnu);
  if (o.pnu && P2.selected.has(o.pnu)) return true;
  // pnu 가 옆 필지로 등록된 건물이 흔하다. 대표점이 고른 필지 안인지 본다.
  const r = o.rings && o.rings[0];
  if (!r || !r.length) return false;
  let sx = 0, sy = 0;
  for (const q of r) { sx += q[0]; sy += q[1]; }
  const cx = sx / r.length, cy = sy / r.length;
  for (const p of P2.scene.parcels) {
    if (!P2.selected.has(p.pnu)) continue;
    for (const ring of p.rings) if (ptInRing(ring, cx, cy)) return true;
  }
  return false;
}

function matchArea(o, want, layer) {
  if (!want) return true;                          // 구역을 안 걸었으면 전체
  if (want === "da-in")  return inDesignArea(o, layer);
  if (want === "da-out") return !inDesignArea(o, layer);
  const ps = inProjectSite(o);
  if (ps === null) return true;                    // 경계가 없으면 따지지 않는다
  return want === "ps-in" ? ps : !ps;
}

const rulesOf = layer => P2.rules.filter(r => (r.layer || "bldg") === layer);

// 드롭다운에서 고른 그 값이어야 한다. 예전처럼 부분일치로 두면 「목구조」를 골라도
// 「일반목구조」까지 걸려, 목록에 적힌 건수와 실제로 칠해지는 수가 어긋난다.
const has = (v, want) => !want || String(v || "") === want;
const inRange = (v, lo, hi) => {
  const n = parseFloat(v) || 0;
  if (lo !== "" && lo != null && (!n || n < +lo)) return false;
  if (hi !== "" && hi != null && (!n || n > +hi)) return false;
  return true;
};

/** 위에서부터 먼저 맞는 조건 하나. 빈 칸은 「따지지 않음」이다. */
function matchRule(o, layer = "bldg") {
  for (const r of rulesOf(layer)) {
    if (!r.on) continue;
    if (!matchArea(o, r.area, layer)) continue;
    if (layer === "bldg") {
      if (!has(o.strct, r.strct) || !has(o.purps, r.purps)) continue;
      if (!inRange(o.year, r.y0, r.y1)) continue;
      if (!inRange(o.floors, r.f0, r.f1)) continue;
    } else if (layer === "parcel") {
      if (!has(o.jimok, r.jimok) || !has(o.zone, r.zone)) continue;
      if (!has(o.district, r.district)) continue;
      if (!inRange(o.area, r.a0, r.a1)) continue;
    } else if (layer === "zone") {
      if (!has(o.name, r.zname)) continue;
    }
    return r;
  }
  return null;
}

// 건물 조건은 건물 레이어의 하위 레이어다 — 같은 표에서 같은 칸을 쓴다.
// 예전에는 따로 떨어진 상자였고, 색·굵기 칸이 레이어 표와 어긋나 있었다.
/** 조건 한 줄의 조건칸들. 어느 레이어냐에 따라 무엇으로 고르는지가 다르다. */
function ruleCondHTML(r) {
  const layer = r.layer || "bldg";
  const ch = (P2.choices && P2.choices[layer]) || {};
  const esc = DRAW.esc;

  const one = f => {
    if (f.t === "pick") {
      const list = ch[f.k] || [];
      const cur = r[f.k] || "";
      // 프리셋에서 온 값이 이 대상지에 없을 수 있다. 그래도 지워지지 않게 남긴다.
      const extra = cur && !list.some(([v]) => v === cur)
        ? `<option value="${esc(cur)}" selected>${esc(cur)} — 이 대상지엔 없음</option>` : "";
      return `<label>${f.label}<select data-k="${f.k}">
        <option value="">따지지 않음</option>${extra}` +
        list.map(([v, n]) =>
          `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)} (${n})</option>`
        ).join("") + `</select></label>`;
    }
    // 숫자 칸은 이 대상지의 최소·최대를 힌트로 보여 준다
    const mm = ch[f.k];
    const p1 = mm ? mm[0] : f.ph, p2 = mm ? mm[1] : f.ph2;
    return f.pair
      ? `<label>${f.label}<input type="number" data-k="${f.k}" value="${r[f.k]}"
           placeholder="${p1}"></label><span>~</span>
         <input type="number" data-k="${f.pair}" value="${r[f.pair]}" placeholder="${p2}">`
      : `<label>${f.label}<input type="number" data-k="${f.k}" value="${r[f.k]}"
           placeholder="${p1}"></label>`;
  };

  const fields = RULE_FIELDS[layer] || [];
  // 첫 줄은 구역. 그다음 고르는 칸은 두 개씩, 범위 칸(~)은 자리를 많이 먹으니 한 줄씩.
  // 한 줄에 욱여넣으면 패널 밖으로 밀려 나가 「지구단위」가 화살표만 남는다.
  const rows = [`<label class="wide">구역<select data-k="area">` +
    ZONES.map(z => `<option value="${z.v}"${r.area === z.v ? " selected" : ""}>${z.name}</option>`).join("") +
    `</select></label>`];
  const picks = fields.filter(f => !f.pair), ranges = fields.filter(f => f.pair);
  for (let i = 0; i < picks.length; i += 2) rows.push(picks.slice(i, i + 2).map(one).join(""));
  for (const f of ranges) rows.push(one(f));

  // 건수와 지우기는 제 줄에 — 앞줄에 붙이면 그 줄이 넘친다
  rows.push(`<span class="rule-n" data-n="${r.id}">${P2.ruleCount[r.id] || 0}건</span>
             <button data-del="${r.id}" class="rule-del" title="이 조건 지우기">✕</button>`);
  return rows.map(html => `<div class="rule-cond" data-rule="${r.id}">${html}</div>`).join("");
}

function ruleRowHTML(r) {
  return `
    <div class="lyr lyr-sub" data-rule="${r.id}">
      <span class="lyr-sub-mark" title="하위 조건">└</span>
      <label class="lyr-on"><input type="checkbox" data-k="on" ${r.on ? "checked" : ""}></label>
      <input class="lyr-name lyr-rname" type="text" data-k="name" value="${r.name}"
             title="${r.name}">
      <label class="lyr-fill" title="채우기">
        <input type="checkbox" data-k="fillOn" ${r.fillOn ? "checked" : ""}>
        <input type="color" data-k="fill" value="${r.fill}">
      </label>
      <label class="lyr-stroke" title="선 켜기 · 색">
        <input type="checkbox" data-k="strokeOn" ${r.strokeOn !== false ? "checked" : ""}>
        <input type="color" data-k="stroke" value="${r.stroke}">
      </label>
      <select data-k="ls" class="lyr-ls" title="선 종류">
        ${DASHES.map(d => `<option value="${d.id}"${(r.ls || "solid") === d.id ? " selected" : ""}>${d.name}</option>`).join("")}
      </select>
      <input type="number" data-k="w"  value="${r.w}"  min="0" max="8" step="0.01"
             inputmode="decimal" title="선 굵기">
      <input type="number" data-k="op" value="${r.op}" min="0" max="100" step="5"   title="투명도 %">
    </div>` + ruleCondHTML(r);
}

/** 조건은 레이어 표 안에서 그려진다. 표를 다시 그리면 조건도 따라온다. */
function plan2RenderRules() { plan2RenderLayers(); }

/** 선 체크와 굵기 숫자를 양방향으로 묶는다. 체크를 다시 켜면 직전 굵기를 복원한다. */
function lineWidthFromInput(input) {
  // type=number는 `0.`처럼 아직 입력 중인 값을 잠시 빈 문자열/badInput으로
  // 노출한다. 이 순간을 0으로 확정하면 소수점과 뒤따르는 자릿수가 사라진다.
  if (!input || input.value === "" || input.validity?.badInput) return null;
  const value = Number(input.value);
  return Number.isFinite(value) ? Math.max(0, Math.min(8, value)) : null;
}

function syncLineControls(row, item, key, oldW) {
  if (key === "w") {
    if (item.w > 0) {
      item.strokeOn = true;
      item.lastW = item.w;
    } else {
      if (oldW > 0) item.lastW = oldW;
      item.w = 0;
      item.strokeOn = false;
    }
  } else if (key === "strokeOn") {
    if (item.strokeOn) {
      item.w = item.w > 0 ? item.w : (item.lastW > 0 ? item.lastW : 0.5);
      item.lastW = item.w;
    } else {
      if (oldW > 0) item.lastW = oldW;
      item.w = 0;
    }
  } else return;
  const check = row.querySelector('[data-k="strokeOn"]');
  const width = row.querySelector('[data-k="w"]');
  if (check) check.checked = item.strokeOn;
  // `0.05`를 치는 동안 `0`, `0.`, `0.0`을 숫자로 다시 써 버리지 않는다.
  // 체크박스로 선을 켜고 끌 때나 입력이 끝난 뒤에는 아래 focusout에서 정리한다.
  if (width && !(key === "w" && width === document.activeElement)) width.value = item.w;
}

function updateRuleCounts() {
  for (const r of P2.rules) {
    const el = P2$(`[data-n="${r.id}"]`);
    if (el) el.textContent = (P2.ruleCount[r.id] || 0) + "동";
  }
}

function plan2Projector() {
  const cv = P2$("#p2canvas");
  const s = P2.zoom * Math.min(cv.clientWidth, cv.clientHeight) / (P2.radius * 2);
  const cx = cv.clientWidth / 2 + P2.panX, cy = cv.clientHeight / 2 + P2.panY;
  return { scale: s,
           p: (x, y) => [cx + x * s, cy - y * s],               // 북쪽이 위
           unp: (px, py) => [(px - cx) / s, (cy - py) / s] };   // 화면 → 장면(미터)
}

// ─────────────────────────────── 여러 필지를 한 덩어리로
//
// 맞닿은 필지는 같은 변을 공유한다. 그 변은 두 필지에서 **반대 방향으로** 한 번씩
// 나온다. 그러니 방향을 무시하고 두 번 나온 변을 지우면 바깥 테두리만 남는다.
// 라이브러리 없이 되는 방법이고, 지적도는 꼭짓점이 정확히 맞물려 있어 잘 듣는다.

function ringArea(r) {                                // 부호가 방향을 알려 준다
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], n = r[(i + 1) % r.length];
    a += p[0] * n[1] - n[0] * p[1];
  }
  return a / 2;
}

/**
 * 건물 외곽을 그림자 벡터만큼 밀면서 지나간 전체 면을 만든다.
 *
 * 단순히 옮긴 실루엣만 그리면 건물과 그림자 사이가 끊겨 보인다. 원래 면, 옮긴 면,
 * 그리고 각 변이 이동하며 만드는 사각면을 한 compound path로 채우면 매스 발끝부터
 * 그림자 끝까지 이어지는 투영 면이 된다. 모든 고리의 방향을 통일해 겹친 부분도 한 번만
 * 채워지게 하고, 실제 건물 면은 이 그림자 위에 다시 그린다.
 */
function sweptShadowRings(rings, dx, dy) {
  const out = [], sx = +dx || 0, sy = +dy || 0;
  const orient = ring => ringArea(ring) < 0 ? ring.slice().reverse() : ring;
  for (const source of rings || []) {
    if (!source || source.length < 3) continue;
    let base = source.filter(p => p && Number.isFinite(+p[0]) && Number.isFinite(+p[1]))
      .map(p => [+p[0], +p[1]]);
    if (base.length > 3) {
      const a = base[0], b = base[base.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7) base.pop();
    }
    if (base.length < 3) continue;
    base = orient(base);
    const shifted = base.map(p => [p[0] + sx, p[1] + sy]);
    out.push(base, shifted);
    if (Math.hypot(sx, sy) < 1e-7) continue;
    for (let i = 0; i < base.length; i++) {
      const j = (i + 1) % base.length;
      let side = [base[i], base[j], shifted[j], shifted[i]];
      if (Math.abs(ringArea(side)) < 1e-8) continue;
      side = orient(side);
      out.push(side);
    }
  }
  return out;
}

function dissolveRings(rings, precision = 100) {
  // 장면 좌표는 미터라 100=1cm. 지도 경위도에서 쓸 때는 호출부가 1e7을 넘겨
  // 약 1cm 정밀도를 유지한다. 경위도에 100을 쓰면 0.01도(약 1km)로 뭉개진다.
  const q = v => Math.round(v * precision) / precision;
  const kp = p => `${q(p[0])},${q(p[1])}`;

  // 방향을 **살려** 둔다. 방향을 버리면 세 갈래가 만나는 꼭짓점에서 어느 쪽으로
  // 이어야 할지 알 수 없어, 고리가 엉뚱하게 감기고 도형이 조각난다.
  // 모든 고리를 같은 방향(반시계)으로 맞춘 뒤, 정반대 변끼리 상쇄시킨다 —
  // 맞닿은 두 필지는 같은 변을 서로 반대 방향으로 한 번씩 갖기 때문이다.
  const dir = new Map();
  for (const r0 of rings) {
    if (!r0 || r0.length < 3) continue;
    const r = ringArea(r0) < 0 ? r0.slice().reverse() : r0;
    for (let i = 0; i < r.length; i++) {
      const a = kp(r[i]), b = kp(r[(i + 1) % r.length]);
      if (a === b) continue;
      const rev = b + "|" + a;
      if (dir.get(rev) > 0) dir.set(rev, dir.get(rev) - 1);
      else { const f = a + "|" + b; dir.set(f, (dir.get(f) || 0) + 1); }
    }
  }

  // 남은 변을 방향대로 이어 붙인다. 나가는 변과 들어오는 변의 수가 같으므로
  // 아무 데서 시작해도 반드시 제자리로 돌아온다.
  const out = new Map();
  for (const [k, c] of dir) {
    if (c <= 0) continue;
    const i = k.indexOf("|"), a = k.slice(0, i), b = k.slice(i + 1);
    if (!out.has(a)) out.set(a, []);
    for (let n = 0; n < c; n++) out.get(a).push(b);
  }
  if (!out.size) return rings;

  const num = s => { const i = s.indexOf(","); return [+s.slice(0, i), +s.slice(i + 1)]; };
  const done = [];
  let broken = false;
  for (const start of [...out.keys()]) {
    while ((out.get(start) || []).length) {
      const ring = [start];
      let cur = start, guard = 0, closed = false;
      while (guard++ < 200000) {
        const nx = out.get(cur);
        if (!nx || !nx.length) { broken = true; break; }
        const b = nx.pop();
        if (b === start) { closed = true; break; }    // 제자리로 — 고리 완성
        ring.push(b); cur = b;
      }
      if (!closed) broken = true;
      if (closed && ring.length >= 3) done.push(ring.map(num));
    }
  }
  // T자 접합이나 서로 다른 정밀도의 경계 때문에 한 경로라도 닫히지 않았다면
  // 부분 결과를 쓰지 않는다. 열린 경로를 Canvas/SVG가 직선으로 닫으면 존재하지
  // 않는 사선 면이 생기므로, 이때는 내부선이 남더라도 원본 필지를 보존한다.
  if (broken || !done.length) return rings;

  // 바깥 고리를 먼저, 구멍을 나중에 그려야 캔버스에서 구멍이 뚫린다
  done.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  return done;
}

/** 여러 고리의 모든 꼭짓점을 감싸는 최소 볼록 외곽선(Monotonic chain). */
function convexHull(rings) {
  const seen = new Set(), pts = [];
  for (const ring of rings || []) for (const p of ring || []) {
    if (!p || p.length < 2) continue;
    const key = `${p[0]},${p[1]}`;
    if (!seen.has(key)) { seen.add(key); pts.push([+p[0], +p[1]]); }
  }
  if (pts.length < 3) return pts;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1])
                            - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function convexHullOps(rings, P, fill, stroke, w, dash, layer) {
  const hull = convexHull(rings);
  if (hull.length < 3) return [];
  return [{t: "poly", pts: hull.map(q => P.p(q[0], q[1])), fill, stroke, w, dash, layer}];
}

/** 필지 여러 개를 한 덩어리로 그린다.
 *
 *  채우기와 테두리를 따로 만드는 것이 요점이다.
 *  채우기는 필지를 **그대로 겹쳐** nonzero 로 칠한다 — 무슨 일이 있어도 안 비는 방법이다.
 *  테두리만 합치기(dissolveRings)로 뽑는다. 지적도는 T자로 만나는 자리에서
 *  한쪽에만 꼭짓점이 있는 일이 흔해 합치기가 완벽하지 않은데,
 *  그 어긋남이 채우기까지 뚫어 버리면 도형이 조각나 보인다.
 */
function massOps(rings, P, fill, stroke, w, dash, layer, patch = 0) {
  const out = [];
  if (!rings.length) return out;
  const toScreen = r => r.map(q => P.p(q[0], q[1]));

  // 합치기 결과에서 안쪽 고리(구멍)를 가려낸다. 바깥은 반시계, 구멍은 시계 방향이다.
  const merged = dissolveRings(rings);

  // 메울 구멍을 고른다. 넓이만 보면 안 된다 — 도로 사이의 갈라진 틈은 가늘고 길어서
  // 넓이는 제법 되면서도 눈에는 「금」으로 보인다. 둥글기(4πA/P²)로 그런 것을 가려낸다.
  // 진짜 가구(街區)는 통통해서 둥글기가 크고, 금은 0 에 가깝다.
  const perim = r => {
    let p = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      p += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return p;
  };
  const small = patch <= 0 ? [] : merged.filter(r => {
    if (ringArea(r) >= 0) return false;                 // 바깥 고리는 건드리지 않는다
    const A = Math.abs(ringArea(r)), P0 = perim(r);
    if (A < patch) return true;                          // 자투리
    return P0 > 0 && (4 * Math.PI * A) / (P0 * P0) < 0.12;   // 가늘고 긴 금
  });
  const keep = merged.filter(r => !small.includes(r));

  if (fill) {
    // 필지를 그대로 겹쳐 nonzero 로 칠한다 — 합치기가 흔들려도 안 빈다.
    // 메우기로 정한 작은 구멍은 방향을 뒤집어 함께 칠한다.
    const same = rings.map(r => ringArea(r) < 0 ? r.slice().reverse() : r);
    for (const h of small) same.push(h.slice().reverse());
    out.push({ t: "poly", fill, stroke: null, w: 0,
               fillRule: "nonzero", rings: same.map(toScreen), layer });
  }
  if (stroke && w > 0)
    out.push({ t: "poly", fill: null, stroke, w, dash,
               rings: keep.map(toScreen), layer });
  return out;
}

// 색 다루기는 draw.js 한 곳에서 한다. 같은 파서를 세 벌 두었더니
// 이스케이프 범위가 파일마다 달라 SVG 가 잘리는 일이 있었다.
const hexRGB = hex => DRAW.rgb(hex);
const rgba = (hex, a) => DRAW._rgba(hex, a);

function roadAnalysisState(layer = layerOf("roadarea")) {
  if (!layer) return {on:false,field:"rvwd",low:"#ffffff",high:"#e2564a",op:100,blend:8,categories:{}};
  layer.analysis = {on:false, field:"rvwd", low:"#ffffff", high:"#e2564a", op:100, blend:8,
                    categories:{}, ...(layer.analysis || {})};
  if (!layer.analysis.categories || typeof layer.analysis.categories !== "object")
    layer.analysis.categories = {};
  return layer.analysis;
}

function precisionRoadState(layer = layerOf("roadarea")) {
  if (!layer) return {items:{}};
  layer.precision = {items:{}, ...(layer.precision || {})};
  if (!layer.precision.items || typeof layer.precision.items !== "object")
    layer.precision.items = {};
  return layer.precision;
}

function precisionSetting(meta, layer = layerOf("roadarea")) {
  const state = precisionRoadState(layer), base = meta?.style || {};
  return state.items[meta.id] ||= {
    on:false, color:base.fill || base.stroke || "#e2564a", op:100,
    w:Number.isFinite(+base.w) ? +base.w : .5,
    size:Number.isFinite(+base.size) ? +base.size : 2,
  };
}

async function loadPrecisionCatalog() {
  if (P2.precision.catalog.length || P2.precision.catalogLoading) return;
  P2.precision.catalogLoading = true;
  try {
    const response = await fetch("/api/precision-roads");
    if (!response.ok) throw new Error("정밀도로 목록을 읽지 못했습니다.");
    P2.precision.catalog = (await response.json()).layers || [];
    for (const meta of P2.precision.catalog) precisionSetting(meta);
  } catch (error) {
    P2.precision.errors.catalog = error.message || String(error);
  } finally {
    P2.precision.catalogLoading = false;
    if (P2.scene) plan2RenderLayers();
  }
}

async function loadRoadCatalogStatus(refresh=false) {
  if (!P2.scene) return;
  const scene = P2.scene;
  try {
    const url = `/api/roads/${refresh?"catalog/refresh":"status"}?site=${encodeURIComponent(P2.scene.name)}`;
    const response = await fetch(url, {method:refresh?"POST":"GET"});
    if (!response.ok) throw new Error((await response.json().catch(()=>({}))).detail || "도로 카탈로그 확인 실패");
    const data = await response.json();
    if (P2.scene !== scene) return;
    P2.roadCatalog = data;
  } catch (error) {
    if (P2.scene !== scene) return;
    P2.roadCatalog = {error:error.message || String(error)};
  }
  if (P2.scene) plan2RenderLayers();
}

async function loadPrecisionLayer(layerId, refresh=false) {
  const meta = P2.precision.catalog.find(layer => layer.id === layerId);
  if (!meta || !P2.scene || P2.precision.loading[layerId]) return;
  const site = P2.scene.name;
  const task = {};
  const loading = P2.precision.loading;
  loading[layerId] = task;
  const isCurrent = () => P2.precision.loading === loading && loading[layerId] === task;
  delete P2.precision.errors[layerId];
  plan2RenderLayers();
  try {
    const suffix = refresh ? "refresh=true" : "";
    const response = await fetch(DRAW.siteURL(site, `/precision-road/${layerId}`, suffix));
    if (!response.ok) throw new Error((await response.json().catch(()=>({}))).detail || `${meta.name}을 불러오지 못했습니다.`);
    const data = await response.json();
    if (!isCurrent()) return;
    P2.precision.data[layerId] = data;
  } catch (error) {
    if (!isCurrent()) return;
    P2.precision.errors[layerId] = error.message || String(error);
    precisionSetting(meta).on = false;
  } finally {
    if (isCurrent()) {
      loading[layerId] = false;
      plan2RenderLayers(); plan2Render();
    }
  }
}

function precisionRoadOps(layer, P) {
  const ops = [];
  for (const meta of P2.precision.catalog) {
    const style = precisionSetting(meta, layer), data = P2.precision.data[meta.id];
    if (!style.on || !data) continue;
    const name = `${layer.name} · 정밀_${meta.name}`;
    const opacity = Math.max(0, Math.min(1, (+style.op || 0) / 100));
    for (const feature of data.features || []) {
      for (const polygon of feature.polygons || []) {
        ops.push({t:"poly",rings:polygon.map(ring=>ring.map(point=>P.p(point[0],point[1]))),
          fill:style.color,stroke:style.color,w:Math.max(.01,(+style.w||.3)*P2.zoom),
          opacity,fillRule:"evenodd",independentOpacity:true,layer:name});
      }
      for (const path of feature.paths || []) {
        ops.push({t:"path",pts:path.map(point=>P.p(point[0],point[1])),stroke:style.color,
          w:Math.max(.01,(+style.w||.5)*P2.zoom),opacity,independentOpacity:true,layer:name});
      }
      for (const point of feature.points || []) {
        const at=P.p(point[0],point[1]);
        ops.push({t:"dot",x:at[0],y:at[1],r:Math.max(.1,(+style.size||2)*P2.zoom),
          fill:style.color,stroke:style.color,w:Math.max(.01,(+style.w||.5)*P2.zoom),
          opacity,independentOpacity:true,layer:name});
      }
    }
  }
  return ops;
}

function roadAnalysisField(state = roadAnalysisState()) {
  const fields = P2.scene?.road_analysis?.fields || [];
  return fields.find(f => f.id === state.field) || fields[0] || null;
}

function roadCategoryStyles(field, state = roadAnalysisState()) {
  if (!field || field.type !== "category") return {};
  const styles = state.categories[field.id] ||= {};
  for (const category of field.categories || []) {
    const previous = styles[category.id] || {};
    styles[category.id] = {on:true, color:category.color || "#8f8f8f", ...previous};
  }
  return styles;
}

/** 중심선 속성을 연속 가우시안 필드로 만든 뒤 실제 도로 Polygon 안에 매핑한다. */
function roadAnalysisOps(sc, layer, P) {
  const state = roadAnalysisState(layer), data = sc.road_analysis || {};
  const field = roadAnalysisField(state), features = data.features || [];
  if (!state.on || !field || !features.length) return [];
  if (state.field !== field.id) state.field = field.id;
  const categorical = field.type === "category";
  const min = +field.min || 0, max = +field.max || min, span = Math.max(1e-9, max - min);
  const styles = categorical ? roadCategoryStyles(field, state) : {};
  const activeCategories = categorical
    ? (field.categories || []).filter(category => styles[category.id]?.on !== false) : [];
  const categoryIndex = new Map(activeCategories.map((category, index) => [category.id, index]));
  const layerName = `${layer.name} · 분석_${field.name}`;
  const clipRings = [];
  for (const area of sc.road_areas || []) {
    // nonzero clip에서 겹친 도로 Polygon이 서로 구멍을 내지 않도록 모든 외곽은 같은
    // 방향, 각 Polygon의 내부 고리는 반대 방향으로 정규화한다.
    (area.rings || []).forEach((ring, ringIndex) => {
      let screenRing = ring.map(q => P.p(q[0], q[1]));
      const wantedSign = ringIndex ? -1 : 1;
      if (ringArea(screenRing) * wantedSign < 0) screenRing = screenRing.slice().reverse();
      clipRings.push(screenRing);
    });
  }
  // 분석은 도로 Polygon이 있을 때만 보인다. 중심선만 단독으로 노출하지 않는다.
  if (!clipRings.length) return [];
  const opacity = Math.max(0, Math.min(1, (+state.op || 0) / 100));
  const blendMeters = Math.max(1, Math.min(60, +state.blend || 8));
  const segments = [];
  features.forEach(feature => {
    const rawValue = (feature.values || {})[field.id];
    let value = null, category = null;
    if (categorical) {
      category = categoryIndex.get(String(rawValue ?? ""));
      if (category === undefined) return;
    } else {
      const numeric = +rawValue;
      if (!Number.isFinite(numeric)) return;
      value = Math.max(0, Math.min(1, (numeric - min) / span));
    }
    const sourceWidth = Math.max(1.5, +feature.width || 1.5);
    const mappedWidth = Math.max(3, sourceWidth * 1.35 + 2);
    // 도로 가장자리까지 값이 전달되도록 도로폭에도 비례시키되, 사용자가 정한 혼합
    // 반경보다 작아지지 않게 한다. 서로 다른 선이 만나면 두 가우시안의 가중평균이 된다.
    const sigma = Math.max(.2, Math.max(blendMeters, mappedWidth * .28) * P.scale);
    for (const path of feature.paths || []) for (let i = 0; i < path.length - 1; i++) {
      const a = P.p(path[i][0], path[i][1]), b = P.p(path[i + 1][0], path[i + 1][1]);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < .01) continue;
      segments.push({x1:a[0], y1:a[1], x2:b[0], y2:b[1],
        value, category, sigma,
        sourceWidthMeters:sourceWidth, mappedWidthMeters:mappedWidth});
    }
  });
  if (!segments.length) return [];
  const cv = P2$("#p2canvas");
  const palette = activeCategories.map(category => styles[category.id]?.color || category.color || "#8f8f8f");
  const cacheKey = ["p2-road-field", sc._fingerprint || sc.name || "scene", field.id,
    categorical ? activeCategories.map((category, index) => `${category.id}:${palette[index]}`).join(",")
                : `${state.low}:${state.high}`,
    blendMeters, cv?.clientWidth || 0, cv?.clientHeight || 0,
    P2.radius, P2.zoom, P2.panX, P2.panY].join("|");
  return [
    {t:"clipStart", rings:clipRings, fillRule:"nonzero", layer:layerName},
    {t:"roadField", segments, low:state.low, high:state.high, opacity,
      mode:categorical ? "category" : "number", palette,
      gaussian:true, roadSurface:true, blendMeters, cacheKey, layer:layerName},
    {t:"clipEnd", layer:layerName}
  ];
}

function plan2List(opts = {}) {
  const sc = P2.scene, ops = [];
  if (!sc) return ops;
  const P = plan2Projector();
  const ruleHits = {};                      // 조건마다 몇 건이 걸렸는지
  const cvEl = P2$("#p2canvas");
  const CW = cvEl.clientWidth, CH = cvEl.clientHeight;
  const D = P2.design;

  // 선 굵기는 확대에 따라 같이 커진다.
  // 화면 픽셀로 못 박아 두면, 축소했을 때는 건물보다 선이 굵어 뭉개지고
  // 확대했을 때는 실처럼 가늘어진다 — 도면의 선 굵기는 축척에 매인 값이다.
  const K = P2.zoom;
  const lw = v => v * K;

  // 건물 그림자 설정. 실제 도형은 모든 건물을 한 덩어리로 합쳐 건물보다 먼저 그린다.
  // 건물마다 그림자를 붙이면 나중 건물의 그림자가 먼저 그린 건물 위로 올라오기 때문이다.
  const shadowOf = () => {
    if (!D.shadow.on) return null;
    const rad = D.shadow.angle * Math.PI / 180;
    // 거리와 번짐도 선 굵기처럼 zoom=1 도판값이다. 화면 픽셀로 고정하면 축소할 때
    // 건물은 작아지는데 그림자만 그대로 남아 실제보다 몇 배 크게 보인다.
    return {color: rgba(D.shadow.color, D.shadow.op / 100), blur: D.shadow.blur * K,
            dx: Math.cos(rad) * D.shadow.dist * K,
            dy: Math.sin(rad) * D.shadow.dist * K};
  };

  // 목록의 맨 위가 화면에서도 맨 위 = 마지막에 그린다
  for (const L of P2.layers.slice().reverse()) {
    if (!L.on) continue;
    const at = ops.length;                  // 이 레이어가 밀어 넣은 op 의 시작점
    const opacity = (L.op ?? 100) / 100;
    if (opacity <= 0 && !canRule(L.id)) continue;
    // 채우기는 고른 색 그대로 — 100%면 불투명이다. 흐리게 하려면 「투명」 칸을 내린다.
    // 예전에는 여기서 0.35·0.85 를 몰래 곱해, 100 으로 놔도 비쳐 보였다.
    const fill = L.fillOn ? L.fill : null;
    const stroke = L.strokeOn !== false && L.w > 0 ? L.stroke : null;
    const dash = dashOf(L.ls);

    if (L.id === "bgfill") {
      // 바탕색도 레이어다 — 사진보다 아래. 투명으로 두면 아무것도 칠하지 않는다.
      if (!P2.bgNone) {
        const bg = opts.forExport && P2.crop
          ? { x: P2.crop.x, y: P2.crop.y, w: P2.crop.w, h: P2.crop.h }
          : { x: 0, y: 0, w: CW, h: CH };
        ops.push({ t: "poly", fill: P2.bg, layer: "바탕색",
                   pts: [[bg.x, bg.y], [bg.x + bg.w, bg.y],
                         [bg.x + bg.w, bg.y + bg.h], [bg.x, bg.y + bg.h]] });
      }
    } else if (L.id === "zone" || L.id === "parcel") {
      // 조건이 붙어 있으면 먼저 맞는 조건의 색·선으로 그린다 (건물과 같은 방식)
      for (const o of (L.id === "zone" ? sc.zones : sc.parcels) || []) {
        const r = matchRule(o, L.id);
        if (r) ruleHits[r.id] = (ruleHits[r.id] || 0) + 1;
        for (const polygon of polygonGroups(o))
          ops.push({ t: "poly", rings:polygon.map(ring=>ring.map(q=>P.p(q[0],q[1]))),
                     fillRule:"evenodd",
                     fill: r ? (r.fillOn ? r.fill : null) : fill,
                     stroke: r ? (r.strokeOn !== false && r.w > 0 ? r.stroke : null) : stroke,
                     w: lw(r ? r.w : L.w),
                     opacity: r ? (r.op ?? 100) / 100 : 1,
                     dash: r ? dashOf(r.ls) : dash,
                     ruled: !!r,             // 조건이 정한 값 — 부모가 덮지 않는다
                     layer: r ? `${L.name} · ${r.name}` : undefined });
      }
      if (L.id === "parcel") {
        const hatch = parcelHatchState(L);
        if (hatch.on) {
          const categoryRings = new Map(PARCEL_HATCH_CATEGORIES.map(category => [category.id, []]));
          for (const parcel of sc.parcels || []) {
            const category = parcelZoneCategory(parcel.zone);
            if (!category || !hatch.categories[category]?.on) continue;
            for (const polygon of polygonGroups(parcel)) for (const ring of polygon)
              categoryRings.get(category).push(ring.map(point => P.p(point[0], point[1])));
          }
          for (const category of PARCEL_HATCH_CATEGORIES) {
            const style = hatch.categories[category.id], rings = categoryRings.get(category.id);
            if (!style?.on || !rings?.length) continue;
            ops.push({t:"hatch", rings, pattern:style.pattern, color:style.color,
              spacing:Math.max(.1, (+hatch.spacing || 9) * K),
              w:Math.max(.01, (+hatch.w || .45) * K),
              opacity:Math.max(0, Math.min(1, (+hatch.op || 0) / 100)),
              fillRule:"evenodd", layer:`필지 · 해치_${category.name}`});
          }
        }
      }
    } else if (L.id === "roadarea") {
      // 서버에서 이미 dissolve한 Polygon이다. Polygon별 compound path로 그리면
      // 내부 도로 조각선은 없고 중앙분리대 같은 구멍은 even-odd로 남는다.
      for (const area of sc.road_areas || []) {
        const rings = (area.rings || []).map(r => r.map(q => P.p(q[0], q[1])));
        if (!rings.length) continue;
        ops.push({ t: "poly", rings, fill, stroke, w: lw(L.w), dash,
                   fillRule: "evenodd", layer: L.name });
      }
      ops.push(...roadAnalysisOps(sc, L, P));
      ops.push(...precisionRoadOps(L, P));
    } else if (L.id === "ground") {
      // 3D 의 지반을 위에서 내려다본 것. 같은 격자(sc.ground)를 쓴다.
      // 칸마다 기울기를 재어 해를 비추고, 원하면 높이에 따라 색도 입힌다.
      const g = sc.ground;
      if (!g || !g.n || !g.z) continue;
      const n = g.n, st = g.step, R = sc.radius;
      const span = Math.max(0.001, g.max - g.min);
      const az = (90 - L.sun) * Math.PI / 180, alt = L.alt * Math.PI / 180;
      const sx = Math.cos(alt) * Math.cos(az), sy = Math.cos(alt) * Math.sin(az),
            sz = Math.sin(alt);
      const k = (L.relief || 0) / 100, tint = (L.tint || 0) / 100;
      const base = hexRGB(L.fill), lo = hexRGB(L.lo), hi = hexRGB(L.hi);

      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const z00 = g.z[j][i], z10 = g.z[j][i + 1],
                z01 = g.z[j + 1][i], z11 = g.z[j + 1][i + 1];
          // 칸의 기울기 → 법선. 두 방향 차분의 평균이면 충분하다.
          const dzdx = ((z10 - z00) + (z11 - z01)) / (2 * st);
          const dzdy = ((z01 - z00) + (z11 - z10)) / (2 * st);
          const len = Math.hypot(dzdx, dzdy, 1);
          const lit = Math.max(0, (-dzdx * sx - dzdy * sy + sz) / len);
          const shade = 1 + k * (lit - 0.55);          // 0.55 를 기준으로 밝고 어둡게

          let c = base;
          if (tint > 0) {
            const t = ((z00 + z11) / 2 - g.min) / span;
            c = [0, 1, 2].map(q => base[q] * (1 - tint) + (lo[q] + (hi[q] - lo[q]) * t) * tint);
          }
          const x0 = -R + i * st, y0 = -R + j * st;
          ops.push({ t: "poly", stroke: null, w: 0, layer: L.name,
                     fill: `rgb(${c.map(v => Math.round(Math.min(255, Math.max(0, v * shade)))).join(",")})`,
                     pts: [P.p(x0, y0), P.p(x0 + st, y0),
                           P.p(x0 + st, y0 + st), P.p(x0, y0 + st)] });
        }
      }
    } else if (L.id === "contour") {
      for (const c of sc.contours || [])
        ops.push({ t: "path", pts: c.pts.map(q => P.p(q[0], q[1])), stroke, w: lw(L.w), dash });
    } else if (L.id === "road") {
      for (const r of sc.roads || [])
        for (const path of r.paths)
          ops.push({ t: "path", pts: path.map(q => P.p(q[0], q[1])), stroke, w: lw(L.w), dash });
    } else if (L.id === "bldg") {
      const sh = shadowOf();
      const buildings = (sc.buildings || []).map(b => {
        const polygons = polygonGroups(b).map(polygon =>
          polygon.map(ring => ring.map(q => P.p(q[0], q[1]))));
        return {b, rule:matchRule(b,"bldg"), polygons,
          rings:polygons.map(polygon => polygon[0]).filter(Boolean)};
      });
      // 건물 외곽에서 이동된 끝 실루엣까지 쓸어 연속된 투영 면을 만든다.
      // 하나의 compound path로 먼저 그려 그림자끼리 중첩되어 진해지지 않게 하고, 뒤이어
      // 모든 건물 면을 올려 인접 건물 위로 침범한 그림자는 자동으로 가린다.
      const sourceShadowRings = buildings.flatMap(entry => entry.rings);
      const shadowRings = sh ? sweptShadowRings(sourceShadowRings, sh.dx, sh.dy) : [];
      if (sh && shadowRings.length) {
        const shadowCacheKey = ["p2-shadow", sc._fingerprint || sc.name || "scene",
          CW, CH, P2.radius, P2.zoom, P2.panX, P2.panY, sh.dx, sh.dy].join("|");
        ops.push({ t: "shadow", rings: shadowRings, fill: sh.color,
                   blur: sh.blur, dx: 0, dy: 0,
                   castSweep: true, castDx: sh.dx, castDy: sh.dy,
                   cacheKey: shadowCacheKey,
                   fillRule: "nonzero", independentOpacity: true,
                   layer: `${L.name} · 그림자` });
      }
      for (const entry of buildings) {
        const {rule: r, polygons} = entry;
        if (r) ruleHits[r.id] = (ruleHits[r.id] || 0) + 1;
        for (const polygon of polygons)
          ops.push({ t: "poly", rings: polygon, fillRule:"evenodd",
                     fill: r ? (r.fillOn ? r.fill : null) : fill,
                     stroke: r ? (r.strokeOn !== false && r.w > 0 ? r.stroke : null) : stroke,
                     w: lw(r ? r.w : L.w),
                     opacity: r ? (r.op ?? 100) / 100 : 1,
                     dash: r ? dashOf(r.ls) : dash,
                     ruled: !!r,             // 조건이 정한 값 — 부모가 덮지 않는다
                     layer: r ? `${L.name} · ${r.name}` : undefined });
      }
    } else if (L.id === "spot") {
      for (const s of sc.spots || []) {
        const q = P.p(s[0], s[1]);
        // 표고점도 도면 요소다. 1px 하한을 두면 극단적으로 축소했을 때 점만 커진다.
        ops.push({ t: "dot", x: q[0], y: q[1], r: Math.max(.05, lw(L.w)),
                   fill, stroke, w: lw(L.w) });
      }
    } else if (L.id === "site") {
      if (!P2.selected.size) continue;
      // 고른 필지들을 하나로 합쳐 **바깥 테두리만** 그린다.
      // 필지 경계선을 그대로 두면 설계 범위가 한 덩어리로 안 읽힌다.
      const rings = [];
      for (const p of sc.parcels) if (P2.selected.has(p.pnu)) rings.push(...p.rings);
      ops.push(...(L.hull
        ? convexHullOps(rings, P, fill, stroke, lw(L.w), dash, L.name)
        : massOps(rings, P, fill, stroke, lw(L.w), dash, L.name)));
    } else if (L.id === "aerial") {
      const A = P2.aerial;
      if (!A.img) continue;
      // 사진은 장면 범위(±radius)에 딱 맞게 서버가 재투영해 준 것이다
      // 사진이 덮는 반경은 장면 반경과 다를 수 있다 (서버가 줄여서 줬을 때)
      const AR = A.radius || sc.radius;
      const a = P.p(-AR, AR), b = P.p(AR, -AR);
      ops.push({ t: "image", img: A.img, href: opts.forExport ? A.href : "",
                 x: a[0], y: a[1], w: b[0] - a[0], h: b[1] - a[1] });
    } else if (L.id === "boundary") {
      for (const ring of sc.boundary || [])
        ops.push({ t: "poly", pts: ring.map(q => P.p(q[0], q[1])),
                   fill, stroke, w: lw(L.w), dash });
    }

    // 이 레이어가 만든 op 전부에 투명도를 입힌다 (규칙이 준 값에 곱한다)
    for (let i = at; i < ops.length; i++) {
      // 레이어 투명도는 조건에 걸리지 **않은** 것에만 먹인다.
      // 조건은 하위 레이어이면서 덮어쓰기다 — 목구조에 60%를 줬으면 그게 60%여야지,
      // 부모가 40%라고 24%가 되면 조건에 준 값이 무슨 뜻인지 알 수 없어진다.
      if (opacity < 1 && !ops[i].ruled && !ops[i].independentOpacity)
        ops[i].opacity = (ops[i].opacity ?? 1) * opacity;
      // SVG 로 나갈 때 레이어로 묶이도록 이름을 붙여 둔다
      if (ops[i].layer === undefined) ops[i].layer = L.name;
    }

    // 조건이 붙은 레이어는 건물마다 이름이 번갈아 나와, 그대로 두면 SVG 묶음이
    // 수천 개로 잘게 쪼개진다. 이 레이어 안에서만 같은 이름끼리 모은다.
    // 레이어 사이의 순서는 건드리지 않는다 — 위아래가 뒤집히면 안 되기 때문이다.
    if (canRule(L.id) && rulesOf(L.id).length) {
      const block = ops.splice(at);
      const bins = new Map();
      for (const o of block) {
        if (!bins.has(o.layer)) bins.set(o.layer, []);
        bins.get(o.layer).push(o);
      }
      for (const arr of bins.values()) ops.push(...arr);
    }
  }
  P2.ruleCount = ruleHits;

  // 필지 해치는 용도지역을 읽는 바탕 표현이다. 사용자가 필지 레이어를 위로 옮겼거나
  // 오래된 프리셋의 순서가 달라도 건물·건물 그림자를 덮어서는 안 된다. Canvas 화면과
  // PNG·SVG가 모두 같은 ops를 쓰므로 여기서 한 번만 건물 바로 아래로 정렬한다.
  const buildingName = layerOf("bldg")?.name || "건물";
  const isBuildingOp = op => op.layer === buildingName || op.layer?.startsWith(`${buildingName} · `);
  const hatchOps = ops.filter(op => op.t === "hatch");
  if (hatchOps.length && ops.some(isBuildingOp)) {
    const withoutHatches = ops.filter(op => op.t !== "hatch");
    const buildingAt = withoutHatches.findIndex(isBuildingOp);
    withoutHatches.splice(buildingAt, 0, ...hatchOps);
    ops.splice(0, ops.length, ...withoutHatches);
  }

  // ── 디자인 — 자료 위에 얹는 것들
  if (D.grid.on && (D.grid.mode==="count" || D.grid.step > 0)) {
    const g = D.grid, o = g.op / 100;
    const line = (a, b) => ops.push({ t: "path", pts: [P.p(...a), P.p(...b)],
      stroke: g.color, w: lw(g.w), opacity: o, dash: dashOf(g.ls), layer: "그리드" });
    if(g.mode==="count"){
      // 전체 칸 수의 기준은 화면이 아니라 01 CONTEXT다. 따라서 확대·이동해도
      // 항상 CONTEXT 외곽에서 시작해 정확히 cols × rows 칸으로 끝난다.
      const b=plan2ScopeBounds("context"),cols=Math.max(1,Math.min(200,Math.round(g.cols||10)));
      const rows=Math.max(1,Math.min(200,Math.round(g.rows||10)));
      if(b){
        const dx=Number.isFinite(+g.dx)?+g.dx:0,dy=Number.isFinite(+g.dy)?+g.dy:0;
        for(let i=0;i<=cols;i++){
          const x=b[0]+(b[2]-b[0])*i/cols+dx;
          line([x,b[1]+dy],[x,b[3]+dy]);
        }
        for(let i=0;i<=rows;i++){
          const y=b[1]+(b[3]-b[1])*i/rows+dy;
          line([b[0]+dx,y],[b[2]+dx,y]);
        }
      }
    }else{
      // 간격 모드는 기존처럼 화면 전체에 깐다. 내보낼 때 선택 범위로 잘린다.
      const [x0, y1] = P.unp(0, 0),[x1, y0] = P.unp(CW, CH);
      const snap = (v, off) => Math.floor((v - off) / g.step) * g.step + off;
      let n = 0;
      for (let v = snap(x0, g.dx); v <= x1 && n < 400; v += g.step, n++) line([v, y0], [v, y1]);
      n = 0;
      for (let v = snap(y0, g.dy); v <= y1 && n < 400; v += g.step, n++) line([x0, v], [x1, v]);
    }
  }

  if (D.vig.on) {
    const v = D.vig;
    const dflt = sc.radius * 0.6;                 // 반경을 안 정했으면 수집 반경의 60%
    const rxm = v.rx > 0 ? v.rx : dflt;
    const rym = v.shape === "circle" ? rxm : (v.ry > 0 ? v.ry : dflt);
    const [cx, cy] = P.p(v.cx, v.cy);             // 장면 좌표 → 화면
    ops.push({ t: "vignette", shape: v.shape, cx, cy,
               rx: rxm * P.scale, ry: rym * P.scale,
               feather: v.feather / 100, color: v.color, op: v.op / 100,
               w: CW, h: CH, layer: "비네트" });
  }

  // 축척 막대
  const cv = P2$("#p2canvas");
  const px = 100 * P.scale, x0 = 22, y0 = cv.clientHeight - 26;
  ops.push({ t: "path", pts: [[x0, y0], [x0 + px, y0]], stroke: "#3c4048", w: 1.4, layer:"축척" });
  ops.push({ t: "path", pts: [[x0, y0 - 4], [x0, y0 + 4]], stroke: "#3c4048", w: 1.4, layer:"축척" });
  ops.push({ t: "path", pts: [[x0 + px, y0 - 4], [x0 + px, y0 + 4]], stroke: "#3c4048", w: 1.4, layer:"축척" });
  ops.push({ t: "text", x: x0 + px + 8, y: y0, s: "100 m", size: 11, weight: 400,
             fill: "#3c4048", anchor: "left", layer:"축척" });

  // Photoshop의 Add Noise처럼 앞에서 합성한 도판 픽셀 전체에 마지막으로 적용한다.
  // 북쪽 표시와 크롭 테두리는 화면 조작용이므로 그 뒤에 그려 또렷하게 남긴다.
  if (D.noise?.on && D.noise.amount > 0) {
    const noise = D.noise;
    ops.push({t:"noise", x:0, y:0, w:CW, h:CH,
      amount:Math.max(0, Math.min(400, +noise.amount || 0)),
      distribution:noise.distribution === "uniform" ? "uniform" : "gaussian",
      monochromatic:noise.monochromatic !== false,
      seed:Number.isFinite(+noise.seed) ? +noise.seed : 2701,
      layer:"노이즈 · Photoshop Add Noise"});
  }

  if (!opts.forExport) {                    // 북쪽 표시는 화면용
    ops.push({ t: "path", pts: [[cv.clientWidth - 40, 66], [cv.clientWidth - 40, 34]],
               stroke: "#3c4048", w: 1.4 });
    ops.push({ t: "text", x: cv.clientWidth - 40, y: 24, s: "N", size: 11, fill: "#3c4048" });
    ops.push(...DRAW.cropOverlay(P2.crop, cv.clientWidth, cv.clientHeight, "#e2564a"));
  }
  return ops;
}

/** 내보내기에 넘길 화면 정보 */
function plan2View(scale) {
  const cv = P2$("#p2canvas");
  // 바탕색은 목록의 맨 아래 레이어가 칠한다. 여기서 또 칠하면 투명 설정이 죽는다.
  return { w: cv.clientWidth, h: cv.clientHeight, bg: null,
           crop: P2.crop, scale: scale || 1 };
}

function plan2SetCrop(c) {
  P2.crop = c;
  P2$("#p2m-crop").classList.toggle("on", P2.cropMode);
  P2$("#p2m-cropoff").disabled = !c;
  P2$("#p2cropinfo").textContent = c
    ? `내보낼 범위 ${Math.round(c.w)} × ${Math.round(c.h)} px` +
      ` → PNG ${Math.round(c.w * P2.scale)} × ${Math.round(c.h * P2.scale)}` +
      (P2.cropMode ? " · Enter로 확정" : "")
    : "범위를 지정하지 않으면 화면 전체가 나갑니다.";
  plan2Render();
}

/** 화면에서 범위를 잡은 뒤 Enter로 확정하고 미리보기 창으로 돌아간다. */
function plan2FinishCrop() {
  if (!P2.cropMode) return;
  P2.cropMode = false;
  plan2SetCrop(P2.crop);
  P2$("#p2modal").style.display = "flex";
  plan2ExportPreview();
}

function plan2Render() {
  const cv = P2$("#p2canvas");
  if (!cv) return;
  const after = () => updateRuleCounts();
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // 화면에서 투명은 격자무늬로 보여 준다 — 흰 바탕과 구별되게
  if (P2.bgNone) {
    const t = 10;
    for (let y = 0; y < h; y += t)
      for (let x = 0; x < w; x += t) {
        ctx.fillStyle = ((x / t + y / t) % 2) ? "#e9ebef" : "#f7f8fa";
        ctx.fillRect(x, y, t, t);
      }
  }
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  if (!P2.scene) return;
  DRAW.paintCanvas(ctx, plan2List());        // 바탕색도 목록의 맨 아래 레이어다
  after();                                  // 규칙별 「N동」을 실제 그린 결과로 갱신
  plan2Info();
}

function plan2Load(scene) {
  const changed = !P2.scene || !scene || P2.scene.name !== scene.name;
  P2.scene = scene;
  P2.radius = scene ? scene.radius : 250;
  if (changed) {
    P2.aerial.img = null; P2.aerial.href = ""; P2.aerial.key = "";
    P2.exportScope = null; P2.crop = null; P2.cropMode = false;
    P2.precision.data={};P2.precision.loading={};P2.precision.errors={};
    P2.precision.site=scene?.name||"";P2.roadCatalog=null;
  }
  buildChoices();                        // 조건 드롭다운에 실제 값을 채운다
  seedRules();
  plan2RenderLayers();
  plan2Info();
  syncGridModeUI();
  if (P2.vigShow) P2.vigShow();          // 반경을 안 정했으면 기본값이 여기서 정해진다
  loadAerial();
  if(scene){void loadPrecisionCatalog();void loadRoadCatalogStatus(false);}
}

/** 도판 왼쪽 위 정보. 화면에만 얹는 DOM 이라 PNG·SVG 에는 안 들어간다. */
function plan2Info() {
  const el = P2$("#p2info"); if (!el) return;
  const sc = P2.scene;
  if (!sc) { el.innerHTML = `<div class="t">대상지를 먼저 고르세요</div>`; return; }
  const n = v => (v || 0).toLocaleString();
  const roadSource = sc.road_area_source || {};
  const roadLabel = roadSource.label || "VWorld 도로 Polygon 없음";
  const dropped = (sc.warnings || []).reduce((sum,item)=>
    sum+(+item.invalid_geometry||0)+(+item.clip_errors||0),0);
  const roadVersion = roadSource.version && roadSource.version !== "live"
    ? ` · ${DRAW.esc(roadSource.version)}` : "";
  el.innerHTML =
    `<div class="t">${sc.name}</div>` +
    `필지 <b>${n(sc.parcels.length)}</b> · 건물 <b>${n(sc.buildings.length)}</b><br>` +
    `도로 <b>${n((sc.roads || []).length)}</b> · 용도지역 <b>${n((sc.zones || []).length)}</b>` +
    `<br>도로면 <b>${DRAW.esc(roadLabel)}${roadVersion}</b>` +
    (P2.selected.size ? `<br>DESIGN AREA <b>${n(P2.selected.size)}</b>필지` : "") +
    (dropped ? `<br><span class="data-warning">해석 제외 도형 ${n(dropped)}건</span>` : "") +
    (P2.aerial.loading ? `<div class="aerial-progress">
      <div class="aerial-progress-head"><span>${DRAW.esc(P2.aerial.phase || "위성사진 준비 중")}</span>
      <b>${Math.round(P2.aerial.progress || 0)}%</b></div>
      <progress max="100" value="${P2.aerial.progress || 0}"></progress></div>` : "");
}

// ───────────────────────────────────────────────────────── 레이어 UI

function roadAnalysisHTML(layer) {
  const state = roadAnalysisState(layer), fields = P2.scene?.road_analysis?.fields || [];
  const field = roadAnalysisField(state);
  if (!fields.length) return `<div class="lyr-subs"><div class="road-analysis road-analysis-empty">
    도로망 분석 자료가 없습니다. 다음에 이 대상지를 열면 기존 프리셋을 유지한 채 자동으로 다시 준비합니다.
  </div></div>`;
  const value = n => Number.isFinite(+n)
    ? (+n).toLocaleString("ko-KR", {maximumFractionDigits:2}) : "-";
  const unit = field?.unit ? ` ${DRAW.esc(field.unit)}` : "";
  const groups = [];
  for (const item of fields) {
    const name = item.group || "기타";
    let group = groups.find(candidate => candidate.name === name);
    if (!group) groups.push(group = {name, fields:[]});
    group.fields.push(item);
  }
  const categorical = field?.type === "category";
  const categoryStyles = categorical ? roadCategoryStyles(field, state) : {};
  const method = P2.scene?.road_analysis?.method || {};
  return `<div class="lyr-subs"><div class="road-analysis">
    <label class="road-analysis-on"><input type="checkbox" data-road-k="on" ${state.on ? "checked" : ""}>
      도로망 분석</label>
    <select data-road-k="field" title="도로중심선에서 색으로 표현할 값">
      ${groups.map(group => `<optgroup label="${DRAW.esc(group.name)}">${group.fields.map(f =>
        `<option value="${DRAW.esc(f.id)}"${f.id === field?.id ? " selected" : ""}>${DRAW.esc(f.name)}</option>`
      ).join("")}</optgroup>`).join("")}
    </select>
    ${categorical ? `<div class="road-analysis-categories">
      ${(field.categories || []).map(category => {
        const style = categoryStyles[category.id];
        return `<label data-road-category="${DRAW.esc(category.id)}">
          <input type="checkbox" data-road-category-k="on" ${style.on !== false ? "checked" : ""}>
          <input type="color" data-road-category-k="color" value="${style.color}" title="${DRAW.esc(category.name)} 색">
          <span>${DRAW.esc(category.name)}</span><small>${(+category.count || 0).toLocaleString()}구간</small>
        </label>`;
      }).join("")}
    </div>` : `<div class="road-analysis-colors road-analysis-number-colors">
      <label>낮은 값 <input type="color" data-road-k="low" value="${state.low}"></label>
      <label>높은 값 <input type="color" data-road-k="high" value="${state.high}"></label>
    </div>
    <div class="road-analysis-ramp" style="--road-low:${state.low};--road-high:${state.high}"></div>
    <div class="road-analysis-values"><span>${value(field?.min)}${unit}</span><span>${value(field?.max)}${unit}</span></div>`}
    <div class="road-analysis-colors road-analysis-common">
      <label>투명도 <input type="number" data-road-k="op" value="${state.op}" min="0" max="100" step="5"></label>
      <label>혼합 반경 m <input type="number" data-road-k="blend" value="${state.blend}"
        min="1" max="60" step="1" inputmode="decimal"></label>
    </div>
    <p>${categorical
      ? "범주마다 고른 색을 도로면에 매핑합니다. 교차부에서는 가장 영향력이 큰 도로의 범주를 유지합니다."
      : "중심선 값의 가우시안 필드를 도로면 안에만 매핑합니다. 교차부는 원 없이 인접 값의 가중평균으로 이어집니다."}</p>
    ${field?.group === "계산 지표" && method.note
      ? `<p class="road-analysis-method">${DRAW.esc(method.note)}</p>` : ""}
  </div></div>`;
}

function precisionRoadHTML(layer) {
  const source=P2.scene?.road_area_source||{},catalog=P2.roadCatalog;
  const installed=(catalog?.datasets||[]).find(item=>item.installed);
  const status=catalog?.error
    ? DRAW.esc(catalog.error)
    : installed
      ? `${DRAW.esc(installed.name)} · ${DRAW.esc(installed.installed.version||"")} · 보존 ${installed.preserved_versions||1}판`
      : `${DRAW.esc(source.label||"도로 Polygon 미설치")} · ${source.mode==="centerline_fallback"?"현재 중심선 fallback":"현재 대상지 clip"}`;
  const list=P2.precision.catalog;
  return `<div class="lyr-subs"><div class="road-analysis precision-road">
    <div class="precision-road-head"><span>정밀도로 요소 · 필요할 때만 수집</span>
      <button type="button" class="ghost" data-road-catalog-refresh>버전 확인</button></div>
    <div class="precision-road-status">${status}</div>
    <div class="precision-road-list">
      ${P2.precision.catalogLoading?`<div class="road-analysis-empty">정밀도로 목록을 불러오는 중…</div>`:
        P2.precision.errors.catalog?`<div class="road-analysis-empty">${DRAW.esc(P2.precision.errors.catalog)}</div>`:
        list.map(meta=>{
          const style=precisionSetting(meta,layer),data=P2.precision.data[meta.id];
          const busy=!!P2.precision.loading[meta.id],error=P2.precision.errors[meta.id];
          const warning=(data?.warnings||[]).join(" ");
          const state=busy?"받는 중…":error?"오류":data
            ? `${(+data.count||0).toLocaleString()}개${warning?" ⚠":""}`:"대기";
          return `<label class="precision-road-row ${busy?"loading":error?"error":""}" data-precision-id="${meta.id}">
            <input type="checkbox" data-precision-k="on" ${style.on?"checked":""} ${busy?"disabled":""}>
            <input type="color" data-precision-k="color" value="${style.color}" title="${DRAW.esc(meta.name)} 색">
            <span title="${DRAW.esc(meta.data_id)}">${DRAW.esc(meta.name)}</span><small title="${DRAW.esc(error||warning||"")}">${state}</small>
          </label>`;
        }).join("")}
    </div>
    <p>차도·노면표시·신호·안전시설은 기본 분석을 늦추지 않도록 체크한 항목만 WFS로 받아 로컬 캐시에 저장합니다.</p>
  </div></div>`;
}

function parcelHatchHTML(layer) {
  const hatch = parcelHatchState(layer), counts = Object.fromEntries(
    PARCEL_HATCH_CATEGORIES.map(category => [category.id, 0]));
  for (const parcel of P2.scene?.parcels || []) {
    const category = parcelZoneCategory(parcel.zone);
    if (category) counts[category]++;
  }
  return `<div class="lyr-subs"><div class="parcel-hatch">
    <label class="road-analysis-on"><input type="checkbox" data-hatch-k="on" ${hatch.on ? "checked" : ""}>
      주거·상업·공업·녹지 필지 해치</label>
    <div class="parcel-hatch-global">
      <label>간격 <input type="number" data-hatch-k="spacing" value="${hatch.spacing}"
        min="2" max="40" step="0.5" inputmode="decimal"></label>
      <label>굵기 <input type="number" data-hatch-k="w" value="${hatch.w}"
        min="0.1" max="4" step="0.05" inputmode="decimal"></label>
      <label>투명 % <input type="number" data-hatch-k="op" value="${hatch.op}"
        min="0" max="100" step="5"></label>
    </div>
    <div class="parcel-hatch-list">
      ${PARCEL_HATCH_CATEGORIES.map(category => {
        const style = hatch.categories[category.id];
        return `<div class="parcel-hatch-row" data-hatch-cat="${category.id}">
          <label><input type="checkbox" data-hatch-c-k="on" ${style.on ? "checked" : ""}>
            <b>${category.name}</b><span>${counts[category.id].toLocaleString()}필지</span></label>
          <select data-hatch-c-k="pattern" title="해치 모양">
            ${HATCH_PATTERNS.map(pattern => `<option value="${pattern.id}"${style.pattern === pattern.id ? " selected" : ""}>${pattern.name}</option>`).join("")}
          </select>
          <input type="color" data-hatch-c-k="color" value="${style.color}" title="해치 색">
        </div>`;
      }).join("")}
    </div>
    <p>필지의 용도지역 명칭을 네 분류로 묶고, 각 필지 경계 안에서만 패턴을 자릅니다.</p>
  </div></div>`;
}

function plan2RenderLayers() {
  const op = L => `<input type="number" data-k="op" value="${L.op}" min="0" max="100"
      step="5" title="투명도 %">`;
  P2$("#p2layers").innerHTML = P2.layers.map(L => L.id === "bgfill" ? `
    <div class="lyr lyr-fixed" data-id="bgfill">
      <span class="lyr-grip" title="바탕색은 항상 맨 아래입니다">·</span>
      <label class="lyr-on"><input type="checkbox" data-k="on" ${L.on ? "checked" : ""}></label>
      <span class="lyr-name" title="${L.name}">${L.name}</span>
      <div class="lyr-opts">
        <label class="lyr-mini" title="바탕색"><input type="color"
          data-bg-k="color" value="${P2.bg}"></label>
        <label class="lyr-mini" title="PNG·SVG를 투명하게 내보냅니다"><input type="checkbox"
          data-bg-k="none" ${P2.bgNone ? "checked" : ""}>투명</label>
      </div>
      ${op(L)}
    </div>` : L.id === "aerial" ? `
    <div class="lyr" data-id="aerial" draggable="true">
      <span class="lyr-grip" title="끌어서 순서 바꾸기">⋮⋮</span>
      <label class="lyr-on"><input type="checkbox" data-k="on" ${L.on ? "checked" : ""}></label>
      <span class="lyr-name" title="${L.name}">${L.name}</span>
      <div class="lyr-opts">
        <label class="lyr-mini" title="색을 빼고 흑백으로 받습니다"><input type="checkbox"
          data-k="gray" ${L.gray ? "checked" : ""}>흑백</label>
        ${L.gray ? `<label class="lyr-exp" for="p2exp-tone"
          title="레벨 — 검정점·중간톤·흰점">▾</label>` : ""}
        <label class="lyr-mini" title="항공사진 대신 일반지도를 깝니다"><input type="checkbox"
          data-k="base" ${L.base ? "checked" : ""}>일반지도</label>
      </div>
      ${op(L)}
    </div>` + (L.gray ? `<div class="lyr-subs">
    <div class="p2levels" data-levels="aerial">
      <div class="p2level-track" title="가까운 손잡이를 끌어 검정점·중간톤·흰점을 조절합니다">
        <div class="p2level-ramp"></div>
        <button type="button" class="p2level-handle" data-level-h="black"></button>
        <button type="button" class="p2level-handle" data-level-h="gamma"></button>
        <button type="button" class="p2level-handle" data-level-h="white"></button>
      </div>
      <div class="p2level-values">
        <span data-level-v="black">검정 ${L.black}</span>
        <span data-level-v="gamma">중간 γ${(+L.gamma || 1).toFixed(2)}</span>
        <span data-level-v="white">흰 ${L.white}</span>
      </div>
      <div class="p2level-foot">
        <label>대비 <input type="range" data-tone-k="contrast" value="${L.contrast}"
          min="-100" max="100" step="1"></label>
        <button data-tone-reset="1" class="rule-del" title="레벨 기본값으로">↺</button>
      </div>
    </div></div>` : "") : `
    <div class="lyr" data-id="${L.id}" draggable="true">
      <span class="lyr-grip" title="끌어서 순서 바꾸기">⋮⋮</span>
      <label class="lyr-on"><input type="checkbox" data-k="on" ${L.on ? "checked" : ""}></label>
      ${canRule(L.id) || L.id === "ground" || L.id === "roadarea" ? `
      <span class="lyr-namewrap">
        <span class="lyr-name" title="${L.name}">${L.name}</span>
        <label class="lyr-exp" for="p2exp-${L.id}"
               title="${L.id === "ground" ? "해·음영 설정" : L.id === "roadarea" ? "도로망 분석" : L.id === "parcel" ? "용도지역 해치·필지 조건" : L.name + " 조건"} 펴기·접기">▾</label>
        ${canRule(L.id) && rulesOf(L.id).length ? `<span class="lyr-nsub">${rulesOf(L.id).length}</span>` : ""}
      </span>` : `<span class="lyr-name" title="${L.name}">${L.name}</span>`}
      <label class="lyr-fill" title="채우기">
        <input type="checkbox" data-k="fillOn" ${L.fillOn ? "checked" : ""}>
        <input type="color" data-k="fill" value="${L.fill}">
      </label>
      <label class="lyr-stroke" title="선 켜기 · 색">
        <input type="checkbox" data-k="strokeOn" ${L.strokeOn !== false ? "checked" : ""}>
        <input type="color" data-k="stroke" value="${L.stroke}">
      </label>
      <select data-k="ls" class="lyr-ls" title="선 종류">
        ${DASHES.map(d => `<option value="${d.id}"${(L.ls || "solid") === d.id ? " selected" : ""}>${d.name}</option>`).join("")}
      </select>
      <input type="number" data-k="w" value="${L.w}" min="0" max="8" step="0.01"
             inputmode="decimal" title="선 굵기">
      ${op(L)}
    </div>` + (L.id === "ground" ? `<div class="lyr-subs">
    <div class="rule-cond" data-tone="1">
      <label>해 방향 °<input type="number" data-tone-k="sun" data-tone-l="ground"
        value="${L.sun}" min="0" max="360" step="15" title="0=북, 90=동, 180=남, 270=서"></label>
      <label>해 높이 °<input type="number" data-tone-k="alt" data-tone-l="ground"
        value="${L.alt}" min="5" max="89" step="5"></label>
    </div>
    <div class="rule-cond" data-tone="1">
      <label>음영 세기 %<input type="number" data-tone-k="relief" data-tone-l="ground"
        value="${L.relief}" min="0" max="150" step="5"></label>
      <label>표고 채색 %<input type="number" data-tone-k="tint" data-tone-l="ground"
        value="${L.tint}" min="0" max="100" step="5" title="높이에 따라 낮은 색↔높은 색을 섞습니다"></label>
    </div>
    <div class="rule-cond" data-tone="1">
      <label class="cwrap">낮은 곳<input type="color" data-tone-k="lo" data-tone-l="ground"
        value="${L.lo}"></label>
      <label class="cwrap">높은 곳<input type="color" data-tone-k="hi" data-tone-l="ground"
        value="${L.hi}"></label>
    </div></div>` : "") + (L.id === "roadarea" ? roadAnalysisHTML(L) + precisionRoadHTML(L) : "") +
      (L.id === "parcel" ? parcelHatchHTML(L) : "") + (L.id === "site" ? `
    <div class="rule-cond" data-tone="1">
      <label class="wide" title="떨어져 있거나 오목하게 연결된 선택 필지를 하나의 볼록 외곽선으로 감쌉니다">
        <input type="checkbox" data-tone-k="hull" data-tone-l="site" ${L.hull ? "checked" : ""}>
        선택 필지를 Convex Hull 한 덩어리로
      </label>
    </div>` : "") + (!canRule(L.id) ? "" : `<div class="lyr-subs">` +
        rulesOf(L.id).map(ruleRowHTML).join("") +
        // 조건이 하나도 없어도 여는 칸은 남는다 — 여기서 첫 조건을 만든다.
        `<div class="rule-cond rule-add">
           <button data-add="${L.id}" class="ghost">+ ${L.name} 조건 만들기</button>
         </div></div>`)
  ).map(html => {
    // 하위 칸을 가진 줄은 그 칸과 한 묶음으로 싸고, 접는 스위치를 앞에 둔다.
    // 접기는 CSS 의 :checked 만으로 돈다 — 스크립트가 끊겨도 살아 있다.
    const m = html.match(/data-id="([a-z]+)"/);
    if (!m) return html;
    // 위성사진은 흑백일 때만 하위 칸(레벨)이 생긴다
    const key = m[1] === "aerial" ? "tone" : m[1];
    if (key === "tone" && !layerOf("aerial").gray) return html;
    if (key !== "tone" && key !== "ground" && key !== "roadarea" && !canRule(m[1])) return html;
    return `<div class="lyr-group">
       <input type="checkbox" class="lyr-expcb" id="p2exp-${key}"
              ${P2.rulesOpen[key] ? "checked" : ""}>${html}
     </div>`;
  }).join("");
  syncLevelBars();
}

// ── 위성사진 레벨: 검정점·중간톤·흰점을 한 트랙에서 조절
let toneFrame = 0;
function queueTone() {
  if (toneFrame) return;
  toneFrame = requestAnimationFrame(() => { toneFrame = 0; applyTone(); });
}

function levelState(L) {
  const black = Math.max(0, Math.min(254, Math.round(+L.black || 0)));
  const white = Math.max(black + 1, Math.min(255, Math.round(+L.white || 255)));
  const gamma = Math.max(0.2, Math.min(3, +L.gamma || 1));
  // 레벨의 중간 손잡이는 입력값 위치다. gamma=1이면 정확히 가운데(0.5).
  const middle = black + Math.pow(0.5, gamma) * (white - black);
  return {black, white, gamma, middle};
}

function syncLevelBar(box, L) {
  if (!box || !L) return;
  const s = levelState(L);
  for (const k of ["black", "gamma", "white"]) {
    const h = box.querySelector(`[data-level-h="${k}"]`);
    const value = k === "gamma" ? s.middle : s[k];
    if (h) h.style.left = `${value / 255 * 100}%`;
  }
  const put = (k, text) => {
    const el = box.querySelector(`[data-level-v="${k}"]`);
    if (el) el.textContent = text;
  };
  put("black", `검정 ${s.black}`);
  put("gamma", `중간 γ${s.gamma.toFixed(2)}`);
  put("white", `흰 ${s.white}`);
}

function setLevelAt(box, kind, clientX) {
  const L = layerOf("aerial"), track = box && box.querySelector(".p2level-track");
  if (!L || !track) return;
  const r = track.getBoundingClientRect();
  const value = Math.round(Math.max(0, Math.min(1,
    (clientX - r.left) / Math.max(1, r.width))) * 255);
  const s = levelState(L);
  if (kind === "black") L.black = Math.min(value, s.white - 1);
  else if (kind === "white") L.white = Math.max(value, s.black + 1);
  else {
    const rel = Math.max(0.125, Math.min(0.87,
      (value - s.black) / (s.white - s.black)));
    L.gamma = Math.max(0.2, Math.min(3, Math.log(rel) / Math.log(0.5)));
  }
  syncLevelBar(box, L);
  queueTone();
}

function bindLevelBar(box) {
  syncLevelBar(box, layerOf("aerial"));
  box.onpointerdown = e => {
    const track = e.target.closest(".p2level-track");
    if (!track) return;
    e.preventDefault(); e.stopPropagation();
    const L = layerOf("aerial"), s = levelState(L);
    const r = track.getBoundingClientRect();
    const value = Math.max(0, Math.min(255,
      (e.clientX - r.left) / Math.max(1, r.width) * 255));
    const direct = e.target.closest("[data-level-h]");
    const pos = {black:s.black, gamma:s.middle, white:s.white};
    const kind = direct ? direct.dataset.levelH
      : Object.keys(pos).sort((a, b) =>
          Math.abs(pos[a] - value) - Math.abs(pos[b] - value))[0];
    setLevelAt(box, kind, e.clientX);
    const move = ev => setLevelAt(box, kind, ev.clientX);
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      if (toneFrame) { cancelAnimationFrame(toneFrame); toneFrame = 0; }
      applyTone();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  };
}

function syncLevelBars() {
  P2$("#p2layers")?.querySelectorAll("[data-levels]").forEach(bindLevelBar);
}

/** 바탕 사진 받기. 서버가 장면과 같은 좌표계로 재투영해 한 장으로 준다.
 *  SVG 로도 나가야 하므로 data URL 로 들고 있는다. */
const loadAerial = createAerialLoader({
  state: P2.aerial, scene: () => P2.scene, layer: () => layerOf("aerial"),
  enabled: () => layerOf("aerial").on,
  hasImage: () => !!P2.aerial.raw,
  clear: () => {
    P2.aerial.raw = P2.aerial.img = null; P2.aerial.href = "";
    P2.aerial.toneVersion = (P2.aerial.toneVersion || 0) + 1;
  },
  changed: () => { plan2Info(); plan2Render(); },
  accept: image => { P2.aerial.raw = image; },
  apply: applyTone,
  failed: error => {
    alert("위성사진 오류: " + error.message);
    layerOf("aerial").on = false; plan2RenderLayers();
  },
});

/** 흑백 사진의 톤 곡선 — 포토샵 커브 자리. 받아 둔 원본은 그대로 두고 사본을 만든다.
 *  밝기(감마)는 out = in^(1/γ), 대비는 0.5 를 축으로 벌리거나 좁힌다. */
function applyTone() {
  const L = layerOf("aerial"), A = P2.aerial;
  const version = A.toneVersion = (A.toneVersion || 0) + 1;
  if (!A.raw) { A.img = null; A.href = ""; plan2Render(); return; }

  const g = +L.gamma || 1, c = +L.contrast || 0;
  const bp = Math.max(0, Math.min(254, +L.black || 0));
  const wp = Math.max(bp + 1, Math.min(255, +L.white === 0 ? 255 : (+L.white || 255)));
  const plain = Math.abs(g - 1) < 0.001 && !c && bp === 0 && wp === 255;
  if (!L.gray || plain) {                              // 건드릴 것이 없으면 원본 그대로
    A.img = A.raw; A.href = A.raw.src; plan2Render(); return;
  }
  const cv = document.createElement("canvas");
  cv.width = A.raw.naturalWidth; cv.height = A.raw.naturalHeight;
  const ctx = cv.getContext("2d");
  ctx.drawImage(A.raw, 0, 0);
  const im = ctx.getImageData(0, 0, cv.width, cv.height), d = im.data;

  // 256칸 대응표를 미리 만들어 두고 픽셀마다 찾아 쓴다 — 픽셀마다 pow 를 하면 느리다
  // 포토샵 레벨과 같은 차례: 검정점·흰점으로 먼저 늘린 뒤, 감마, 그다음 대비
  const k = (c + 100) / 100, lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = (i - bp) / (wp - bp);                     // 검정점 아래는 완전한 검정
    v = Math.min(1, Math.max(0, v));
    v = Math.pow(v, 1 / g);
    v = (v - 0.5) * k + 0.5;
    lut[i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
  }
  ctx.putImageData(im, 0, 0);

  const href = cv.toDataURL("image/png");
  const img = new Image();
  img.onload = () => {
    if (A.toneVersion !== version) return;
    A.img = img; A.href = href; plan2Render();
  };
  img.src = href;
}

// ───────────────────────────────────────────── 도판 프리셋
//
// 사이트 분석 프리셋과 따로 둔다. 저쪽은 「어느 대상지를 어떻게 잡았나」이고
// 이쪽은 「그 자료를 어떻게 그리나」다. 대상지가 달라도 같은 도판 스타일을 쓴다.
// 담기·주고받기의 몸통은 presets.js 가 맡는다.

function p2psCapture() {
  return {
    layers: P2.layers.map(L => ({ ...L,
      analysis: L.analysis ? {...L.analysis} : undefined,
      precision: L.precision ? JSON.parse(JSON.stringify(L.precision)) : undefined,
      hatch: L.hatch ? JSON.parse(JSON.stringify(L.hatch)) : undefined })),
    rules: P2.rules.map(r => ({ ...r })),
    design: JSON.parse(JSON.stringify(P2.design)),
    bg: P2.bg, bgNone: P2.bgNone,
  };
}
function p2psLabel(s) {
  const on = (s.layers || []).filter(L => L.on).length;
  const dz = ["grid", "vig", "shadow", "noise"].filter(k => s.design && s.design[k] && s.design[k].on);
  const NM = { grid: "그리드", vig: "비네트", shadow: "그림자", noise: "노이즈" };
  const parcelHatch = (s.layers || []).find(layer => layer.id === "parcel")?.hatch?.on;
  return `레이어 ${on}개 · 조건 ${(s.rules || []).length}개` +
         (dz.length ? ` · ${dz.map(k => NM[k]).join("·")}` : "") +
         (parcelHatch ? " · 필지해치" : "");
}
function syncGridModeUI(){
  const g=P2.design.grid;
  g.mode=g.mode==="count"?"count":"step";
  g.cols=Math.max(1,Math.min(200,Math.round(+g.cols||10)));
  g.rows=Math.max(1,Math.min(200,Math.round(+g.rows||10)));
  const count=g.mode==="count";
  const mode=P2$("#dz-grid-mode");if(mode)mode.value=g.mode;
  const step=P2$("#dz-grid-step-wrap");if(step)step.style.display=count?"none":"flex";
  const cells=P2$("#dz-grid-count-row");if(cells)cells.style.display=count?"flex":"none";
  const offset=P2$("#dz-grid-offset-row");if(offset)offset.style.display="flex";
  const note=P2$("#dz-grid-summary");
  if(note){
    const b=plan2ScopeBounds("context"),width=b?Math.abs(b[2]-b[0]):0,height=b?Math.abs(b[3]-b[1]):0;
    note.textContent=count
      ?b?`CONTEXT ${Math.round(width)} × ${Math.round(height)} m · ${g.cols} × ${g.rows}칸 · 한 칸 약 ${(width/g.cols).toFixed(1)} × ${(height/g.rows).toFixed(1)} m`+
          ((+g.dx||+g.dy)?` · 이동 동 ${+g.dx||0}m / 북 ${+g.dy||0}m`:"")
        :`CONTEXT를 불러오면 ${g.cols} × ${g.rows}칸으로 나눕니다.`
      :"간격 기준 그리드는 현재 화면과 내보내기 범위 전체에 이어집니다.";
  }
}
function p2psSyncForm() {
  const D = P2.design;
  const put = (id, v) => { const e = P2$("#" + id); if (e) e.value = v; };
  const tick = (id, v) => { const e = P2$("#" + id); if (e) e.checked = !!v; };
  D.noise = {on:false,amount:5,distribution:"gaussian",monochromatic:true,seed:2701,
    ...(D.noise || {})};
  tick("dz-grid", D.grid.on); tick("dz-vig", D.vig.on); tick("dz-shadow", D.shadow.on);
  tick("dz-noise", D.noise.on);
  ["grid", "vig", "shadow", "noise"].forEach(k => {
    const box = P2$("#dz-" + (k === "shadow" ? "shadow" : k) + "-box");
    if (box) box.style.display = D[k].on ? "block" : "none";
  });
  put("dz-grid-mode", D.grid.mode||"step");put("dz-grid-step", D.grid.step); put("dz-grid-w", D.grid.w);
  put("dz-grid-cols", D.grid.cols||10);put("dz-grid-rows", D.grid.rows||10);
  put("dz-grid-color", D.grid.color); put("dz-grid-op", D.grid.op);
  put("dz-grid-ls", D.grid.ls);
  put("dz-vig-shape", D.vig.shape); put("dz-vig-color", D.vig.color);
  put("dz-vig-op", D.vig.op);
  put("dz-vig-rx", D.vig.rx); put("dz-vig-ry", D.vig.ry);
  put("dz-vig-feather", D.vig.feather);
  put("dz-sh-color", D.shadow.color); put("dz-sh-op", D.shadow.op);
  put("dz-sh-blur", D.shadow.blur); put("dz-sh-angle", D.shadow.angle);
  put("dz-sh-dist", D.shadow.dist);
  put("dz-noise-amount", D.noise.amount); put("dz-noise-distribution", D.noise.distribution);
  tick("dz-noise-monochromatic", D.noise.monochromatic);
  syncGridModeUI();
}
function p2psApply(s) {
  if (s.layers) P2.layers = s.layers.map(L => ({ ...L, strokeOn: L.strokeOn !== false }));
  // 예전 지목=도 프리셋을 불러도 현재 VWorld Polygon 이름으로 바로 교정한다.
  const roadArea = layerOf("roadarea");
  if (roadArea) {
    roadArea.name = "도로면 · VWorld Polygon";
    delete roadArea.patch;
    roadAnalysisState(roadArea);                // 예전 프리셋에도 새 하위 레이어 기본값 보충
    precisionRoadState(roadArea);
  }
  parcelHatchState();                           // 예전 프리셋에도 주·상·공·녹 해치 기본값 보충
  if (s.rules)  P2.rules  = s.rules.map(r => ({ ...r, strokeOn: r.strokeOn !== false }));
  if (s.design) P2.design = JSON.parse(JSON.stringify(s.design));
  P2.design.grid={mode:"step",step:50,cols:10,rows:10,w:.4,color:"#9aa3b2",op:35,
    ls:"solid",dx:0,dy:0,...(P2.design.grid||{})};
  P2.design.noise={on:false,amount:5,distribution:"gaussian",monochromatic:true,seed:2701,
    ...(P2.design.noise||{})};
  if (s.bg) P2.bg = s.bg;
  P2.bgNone = !!s.bgNone;
  P2.aerial.key = "";                            // 사진 설정이 바뀌었을 수 있다
  p2psSyncForm();
  plan2RenderLayers();
  for(const meta of P2.precision.catalog){
    if(precisionSetting(meta).on&&!P2.precision.data[meta.id])void loadPrecisionLayer(meta.id);
  }
  if (layerOf("aerial").on) loadAerial(); else plan2Render();
}

const P2PS = makePresets({
  kind: "plan2d", chipsId: "p2presets", prefix: "p2ps", fileKind: "vworld-plan2d-presets",
  fileName: n => `도판프리셋_${n}개.json`,
  capture: p2psCapture, apply: p2psApply, label: p2psLabel,
  say: t => (typeof log === "function" ? log(t) : console.log(t)),
});

// ───────────────────────────────────────────── 내보내기 창
//
// 사이트 분석의 04 와 같은 짜임 — 무엇으로 받을지 고르고, 오른쪽에서 확인한 뒤 받는다.

/** CONTEXT·PROJECT SITE·DESIGN AREA의 장면 좌표 외곽 [x0,y0,x1,y1]. */
function plan2ScopeBounds(scope) {
  const sc = P2.scene;
  if (!sc) return null;
  if (scope === "context") {
    const b = sc.context_bounds;
    if (Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) return b.slice();
    return [-sc.radius, -sc.radius, sc.radius, sc.radius];
  }

  let rings = [];
  if (scope === "project") {
    rings = sc.boundary || [];
  } else if (scope === "design") {
    if (!P2.selected.size) return null;
    for (const p of sc.parcels || [])
      if (P2.selected.has(p.pnu)) rings.push(...(p.rings || []));
  }
  if (!rings.length) return null;

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings) for (const q of ring || []) {
    if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) continue;
    x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]);
    x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]);
  }
  return Number.isFinite(x0) && x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

function plan2SyncExportScope() {
  const box = P2$("#p2m-area");
  if (box) {
    box.querySelectorAll("button[data-scope]").forEach(b => {
      b.classList.toggle("on", b.dataset.scope === P2.exportScope);
      b.disabled = b.dataset.scope === "project" ? !plan2ScopeBounds("project")
                 : b.dataset.scope === "design" ? !plan2ScopeBounds("design") : false;
    });
  }
  const note = P2$("#p2m-scope");
  if (!note) return;
  const names = { context: "01 CONTEXT 수집 범위만 크롭",
                  project: "02 PROJECT SITE 경계 외곽만 크롭",
                  design: "03 DESIGN AREA 필지 외곽만 크롭" };
  note.textContent = names[P2.exportScope] ||
    (P2.crop ? "직접 지정한 범위만" : "화면에 보이는 대로");
}

/** 카메라는 건드리지 않고 고른 영역의 화면상 외곽을 내보내기 크롭으로 삼는다. */
function plan2CropExportScope(scope, notify = true) {
  const b = plan2ScopeBounds(scope);
  if (!b) {
    if (notify) alert(scope === "project"
      ? "먼저 PROJECT SITE 경계를 확정하세요."
      : "먼저 DESIGN AREA 필지를 고르세요.");
    return false;
  }
  const P = plan2Projector();
  const a = P.p(b[0], b[1]), z = P.p(b[2], b[3]);
  const crop = { x: Math.min(a[0], z[0]), y: Math.min(a[1], z[1]),
                 w: Math.abs(z[0] - a[0]), h: Math.abs(z[1] - a[1]) };
  if (crop.w < 1 || crop.h < 1) return false;
  P2.exportScope = scope;
  P2.cropMode = false;
  plan2SetCrop(crop);
  plan2SyncExportScope();
  plan2ExportPreview();
  return true;
}

function plan2OpenExport() {
  if (!P2.scene) return alert("대상지를 먼저 고르세요.");
  P2.fmt = P2.fmt || "png";
  document.querySelectorAll("#p2m-fmt button").forEach(
    b => b.classList.toggle("on", b.dataset.fmt === P2.fmt));
  P2$("#p2m-scale").value = P2.scale;
  P2$("#p2m-bgnone").checked = P2.bgNone;
  plan2SyncExportScope();
  P2$("#p2modal").style.display = "flex";
  setTimeout(plan2ExportPreview, 30);
}

/** 실제로 나갈 그림을 그대로 축소해 보여 준다 — 같은 목록, 같은 그리기. */
function plan2ExportPreview() {
  const cv = P2$("#p2m-canvas"); if (!cv || !P2.scene) return;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);

  const view = plan2View();
  const c = view.crop || { x: 0, y: 0, w: view.w, h: view.h };
  // 나갈 그림을 한 번 그린 뒤 미리보기 칸에 맞춰 줄인다
  const full = DRAW.renderToCanvas(plan2List({ forExport: true }), { ...view, scale: 1 });
  const s = Math.min(cv.width / full.width, cv.height / full.height);
  const w = full.width * s, h = full.height * s;
  const ox = (cv.width - w) / 2, oy = (cv.height - h) / 2;

  if (P2.bgNone) {                       // 투명은 격자무늬로 보여 준다
    const t = 8;
    for (let y = 0; y < cv.height; y += t)
      for (let x = 0; x < cv.width; x += t) {
        ctx.fillStyle = ((x / t + y / t) % 2) ? "#e9ebef" : "#f7f8fa";
        ctx.fillRect(x, y, t, t);
      }
  } else { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height); }
  ctx.drawImage(full, ox, oy, w, h);
  ctx.strokeStyle = "#c7ccd6"; ctx.lineWidth = 1;
  ctx.strokeRect(ox + .5, oy + .5, w - 1, h - 1);

  const vector=P2.fmt === "svg"||P2.fmt==="aizip";
  const px = vector
    ? `${Math.round(c.w)} × ${Math.round(c.h)} pt`
    : `${Math.round(c.w * P2.scale)} × ${Math.round(c.h * P2.scale)} px`;
  const layers = [...new Set(plan2List({ forExport: true }).map(o => o.layer).filter(Boolean))];
  P2$("#p2m-hint").innerHTML =
    `<b>${px}</b>` +
    (P2.bgNone ? `<br>바탕 없이 — 그린 것만 남습니다.` : "") +
    (P2.fmt === "svg" ? `<br>SVG 그룹 ${layers.length}개로 나갑니다.` : "")+
    (P2.fmt === "aizip" ? `<br>스크립트가 Illustrator 실제 레이어 ${layers.length}개로 분리합니다.` : "");
}

/** 레이어 순서 바꾸기. 목록에서 옮긴 그대로 그리는 순서가 된다. */
function bindLayerDrag() {
  const box = P2$("#p2layers");
  let from = null;

  // 조건 줄(.lyr-sub)은 레이어가 아니다. 순서 바꾸기에서 제외한다.
  const rowOf = t => t.closest(".lyr[data-id]");

  box.addEventListener("dragstart", e => {
    const row = rowOf(e.target); if (!row) return;
    from = row.dataset.id;
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", from);   // 파이어폭스는 이게 있어야 끌린다
  });
  box.addEventListener("dragend", () => {
    from = null;
    box.querySelectorAll(".lyr").forEach(r => r.classList.remove("dragging", "over"));
  });
  box.addEventListener("dragover", e => {
    e.preventDefault();
    const row = rowOf(e.target);
    box.querySelectorAll(".lyr").forEach(r => r.classList.toggle("over", r === row && r.dataset.id !== from));
  });
  box.addEventListener("drop", e => {
    e.preventDefault();
    const row = rowOf(e.target);
    if (!row || !from || row.dataset.id === from) return;
    const at = P2.layers.findIndex(l => l.id === from);
    const to = P2.layers.findIndex(l => l.id === row.dataset.id);
    if (at < 0 || to < 0) return;
    const [moved] = P2.layers.splice(at, 1);
    P2.layers.splice(to, 0, moved);
    plan2RenderLayers();
    plan2Render();
  });
}

function bindPlan2() {
  const cv = P2$("#p2canvas");
  let last = null;

  const local = e => {
    const r = cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  let cropFrom = null;
  let vigFrom = null, vigMoved = false;   // 비네트 중심을 누른 자리(장면 좌표)

  cv.addEventListener("pointerdown", e => {
    // 비네트 — 누른 자리가 중심, 끈 만큼이 반경. 끌지 않고 놓으면 반경은 그대로 둔다.
    if (P2.pickVig) {
      cv.setPointerCapture(e.pointerId);
      const [px, py] = local(e);
      vigFrom = plan2Projector().unp(px, py);
      vigMoved = false;
      P2.vigSet(Math.round(vigFrom[0]), Math.round(vigFrom[1]));
      return;
    }
    cv.setPointerCapture(e.pointerId);
    if (P2.cropMode) { cropFrom = local(e); return; }
    last = [e.clientX, e.clientY];
  });
  cv.addEventListener("pointermove", e => {
    if (vigFrom) {
      const [mx, my] = plan2Projector().unp(...local(e));
      const dx = Math.abs(mx - vigFrom[0]), dy = Math.abs(my - vigFrom[1]);
      // 손이 떨린 정도는 크기 조절로 치지 않는다
      if (!vigMoved && Math.hypot(dx, dy) * plan2Projector().scale < 4) return;
      vigMoved = true;
      const v = P2.design.vig;
      if (v.shape === "circle") P2.vigSet(vigFrom[0], vigFrom[1], Math.hypot(dx, dy));
      else                      P2.vigSet(vigFrom[0], vigFrom[1], dx, dy);
      return;
    }
    if (cropFrom) {
      const [x, y] = local(e);
      plan2SetCrop({ x: Math.min(x, cropFrom[0]), y: Math.min(y, cropFrom[1]),
                     w: Math.abs(x - cropFrom[0]), h: Math.abs(y - cropFrom[1]) });
      return;
    }
    if (!last) return;
    P2.exportScope = null;
    P2.panX += e.clientX - last[0]; P2.panY += e.clientY - last[1];
    last = [e.clientX, e.clientY];
    plan2Render();
  });
  const stop = () => {
    last = null;
    if (vigFrom) {
      vigFrom = null;
      P2.pickVig = false;
      P2$("#dz-vig-pick").classList.remove("on");
      cv.style.cursor = "";
      return;
    }
    if (cropFrom) {
      cropFrom = null;
      // 클릭에 가까운 드래그는 범위로 치지 않는다
      if (P2.crop && (P2.crop.w < 12 || P2.crop.h < 12)) plan2SetCrop(null);
      // 드래그를 놓아도 선택 모드를 유지한다. Enter가 최종 확정이다.
      plan2SetCrop(P2.crop);
    }
  };
  cv.addEventListener("pointerup", stop);
  cv.addEventListener("pointercancel", stop);
  cv.addEventListener("wheel", e => {
    e.preventDefault();
    P2.exportScope = null;
    const [mx,my]=local(e),oldZoom=P2.zoom;
    const nextZoom=Math.max(0.2,Math.min(24,oldZoom*(e.deltaY<0?1.12:0.89)));
    const ratio=nextZoom/oldZoom;
    // 화면 중앙이 아니라 포인터 아래의 도면 좌표를 확대 기준으로 삼는다.
    const anchorX=cv.clientWidth/2+P2.panX,anchorY=cv.clientHeight/2+P2.panY;
    P2.panX+=(mx-anchorX)*(1-ratio);P2.panY+=(my-anchorY)*(1-ratio);
    P2.zoom=nextZoom;
    plan2Render();
  }, { passive: false });

  // 레이어 값 변경 — 같은 표에 레이어 줄과 건물 조건 줄이 섞여 있다
  P2$("#p2layers").addEventListener("input", e => {
    // 접기 스위치. 그리기와는 무관하고, 다시 그릴 때 상태를 잃지 않게 기억만 해 둔다.
    if (e.target.classList.contains("lyr-expcb")) {
      P2.rulesOpen[e.target.id.replace("p2exp-", "")] = e.target.checked;
      return;
    }
    const precisionKey=e.target.dataset.precisionK;
    if(precisionKey){
      const row=e.target.closest("[data-precision-id]"),meta=P2.precision.catalog.find(
        item=>item.id===row?.dataset.precisionId);
      if(!meta)return;
      const style=precisionSetting(meta);
      style[precisionKey]=e.target.type==="checkbox"?e.target.checked:e.target.value;
      P2.rulesOpen.roadarea=true;
      if(precisionKey==="on"&&style.on&&!P2.precision.data[meta.id])void loadPrecisionLayer(meta.id);
      else plan2Render();
      return;
    }
    const roadCategoryKey = e.target.dataset.roadCategoryK;
    if (roadCategoryKey) {
      const state = roadAnalysisState(), field = roadAnalysisField(state);
      const row = e.target.closest("[data-road-category]");
      const category = row?.dataset.roadCategory;
      const style = roadCategoryStyles(field, state)[category];
      if (!style) return;
      style[roadCategoryKey] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      P2.rulesOpen.roadarea = true;
      plan2Render();
      return;
    }
    // 도로면 하위의 중심선 속성 분석. 색과 필드를 바꾸면 범례도 함께 갱신한다.
    const roadKey = e.target.dataset.roadK;
    if (roadKey) {
      const state = roadAnalysisState();
      state[roadKey] = e.target.type === "checkbox" ? e.target.checked
                     : e.target.type === "number" ? +e.target.value
                     : e.target.value;
      P2.rulesOpen.roadarea = true;
      // 숫자를 타이핑하는 중 DOM을 갈아 끼우면 첫 자리 뒤에 포커스를 잃는다.
      // 필드 변경만 범위 문구 때문에 다시 만들고, 색은 범례 바만 바로 갱신한다.
      if (roadKey === "field") plan2RenderLayers();
      else if (roadKey === "low" || roadKey === "high") {
        const ramp = P2$(".road-analysis-ramp");
        if (ramp) {
          ramp.style.setProperty("--road-low", state.low);
          ramp.style.setProperty("--road-high", state.high);
        }
      }
      plan2Render();
      return;
    }

    // 필지 용도지역 해치. 네 분류의 켜기·모양·색은 필지 레이어의 하위 상태다.
    const hatchKey = e.target.dataset.hatchK;
    if (hatchKey) {
      const hatch = parcelHatchState();
      hatch[hatchKey] = e.target.type === "checkbox" ? e.target.checked
                       : e.target.type === "number" ? +e.target.value
                       : e.target.value;
      P2.rulesOpen.parcel = true;
      plan2Render();
      return;
    }
    const hatchCategoryKey = e.target.dataset.hatchCK;
    if (hatchCategoryKey) {
      const row = e.target.closest("[data-hatch-cat]");
      const category = row?.dataset.hatchCat, hatch = parcelHatchState();
      if (!category || !hatch.categories[category]) return;
      hatch.categories[category][hatchCategoryKey] = e.target.type === "checkbox"
        ? e.target.checked : e.target.value;
      P2.rulesOpen.parcel = true;
      plan2Render();
      return;
    }

    // 위성사진 톤 곡선 — 사진을 다시 받지 않고 사본만 다시 만든다
    const tk = e.target.dataset.toneK;
    if (tk) {
      const id = e.target.dataset.toneL || "aerial";
      // 색 칸은 숫자로 바꾸면 안 된다 (#efeadd → NaN)
      layerOf(id)[tk] = e.target.type === "checkbox" ? e.target.checked
                      : e.target.type === "color" ? e.target.value
                      : +e.target.value;
      id === "aerial" ? applyTone() : plan2Render();
      return;
    }

    // 바탕색은 독립 디자인 항목이 아니라 레이어 줄에서 직접 조정한다.
    const bgk = e.target.dataset.bgK;
    if (bgk) {
      if (bgk === "color") P2.bg = e.target.value;
      else P2.bgNone = e.target.checked;
      P2$("#p2m-bgnone").checked = P2.bgNone;
      plan2Render();
      return;
    }

    const k = e.target.dataset.k; if (!k) return;
    const row = e.target.closest("[data-rule], .lyr[data-id]"); if (!row) return;

    if (row.dataset.rule) {                      // 건물의 하위 조건
      const r = P2.rules.find(x => x.id === row.dataset.rule); if (!r) return;
      const oldW = +r.w || 0;
      const nextW = k === "w" ? lineWidthFromInput(e.target) : null;
      if (k === "w" && nextW === null) return;  // `0.` 같은 입력 중간 상태
      // 숫자는 문자열로 둔다 — 빈 칸이 살아야 「따지지 않음」이 된다
      r[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      if (k === "w") r[k] = nextW;
      else if (k === "op") r[k] = +e.target.value;
      syncLineControls(row, r, k, oldW);
      if (k === "name") e.target.title = e.target.value;
      plan2Render();
      return;
    }

    const L = layerOf(row.dataset.id); if (!L) return;
    const oldW = +L.w || 0;
    const nextW = k === "w" ? lineWidthFromInput(e.target) : null;
    if (k === "w" && nextW === null) return;    // `.`과 끝자리 0을 그대로 둔다
    L[k] = k === "w" ? nextW
         : e.target.type === "checkbox" ? e.target.checked
         : (e.target.type === "number" || e.target.type === "range") ? +e.target.value
         : e.target.value;
    syncLineControls(row, L, k, oldW);
    // 사진은 서버에서 다시 만들어야 하는 항목(켜기·흑백·지도전환)이 있다
    if (L.id === "aerial" && k !== "op") {
      // 흑백을 누른 바로 그 프레임에 레벨 칸을 넣는다.
      // 켠 김에 펴 준다 — 안 그러면 눌러도 아무 일이 없어 보인다.
      if (k === "gray") { if (L.gray) P2.rulesOpen.tone = true; plan2RenderLayers(); }
      loadAerial();
    }
    else plan2Render();
  });

  // 빈 굵기 칸을 떠나면 0으로 확정한다. 완성된 소수는 보기 좋은 숫자로 정리한다.
  P2$("#p2layers").addEventListener("focusout", e => {
    if (e.target.dataset.k !== "w") return;
    const row = e.target.closest("[data-rule], .lyr[data-id]"); if (!row) return;
    const item = row.dataset.rule
      ? P2.rules.find(x => x.id === row.dataset.rule)
      : layerOf(row.dataset.id);
    if (!item) return;
    const oldW = +item.w || 0, nextW = lineWidthFromInput(e.target);
    item.w = nextW === null ? 0 : nextW;
    syncLineControls(row, item, "w", oldW);
    e.target.value = item.w;
    plan2Render();
  });

  P2$("#p2layers").addEventListener("click", e => {
    if(e.target.closest("[data-road-catalog-refresh]")){
      e.preventDefault();void loadRoadCatalogStatus(true);return;
    }
    if (e.target.closest("[data-tone-reset]")) {
      const L = layerOf("aerial");
      L.gamma = 1; L.contrast = 0; L.black = 0; L.white = 255;
      plan2RenderLayers(); applyTone();
      return;
    }
    const add = e.target.closest("[data-add]");
    if (add) {
      const id = add.dataset.add;
      P2.rules.push(newRule(id, {name: (layerOf(id) || {}).name + " 조건 " + (rulesOf(id).length + 1)}));
      P2.rulesOpen[id] = true;               // 만들었으면 펴 둔다
      plan2RenderLayers(); plan2Render();
      return;
    }
    const del = e.target.closest("[data-del]"); if (!del) return;
    P2.rules = P2.rules.filter(x => x.id !== del.dataset.del);
    plan2RenderLayers(); plan2Render();
  });

  // ── 디자인 섹터 — 켜면 설정칸이 펴지고, 값을 바꾸면 바로 다시 그린다
  const dz = (id, path, key, num) => {
    const el = P2$("#" + id); if (!el) return;
    el.addEventListener("input", () => {
      P2.design[path][key] = el.type === "checkbox" ? el.checked
                           : num ? +el.value : el.value;
      plan2Render();
    });
  };
  const toggle = (id, path) => {
    const el = P2$("#" + id), box = P2$("#" + id + "-box");
    el.addEventListener("change", () => {
      P2.design[path].on = el.checked;
      box.style.display = el.checked ? "block" : "none";
      plan2Render();
    });
  };
  toggle("dz-grid", "grid"); toggle("dz-vig", "vig"); toggle("dz-shadow", "shadow");
  toggle("dz-noise", "noise");
  dz("dz-grid-step", "grid", "step", 1); dz("dz-grid-cols", "grid", "cols", 1);
  dz("dz-grid-rows", "grid", "rows", 1);dz("dz-grid-w", "grid", "w", 1);
  dz("dz-grid-color", "grid", "color");  dz("dz-grid-op", "grid", "op", 1);
  dz("dz-grid-ls", "grid", "ls");
  dz("dz-grid-dx", "grid", "dx", 1);     dz("dz-grid-dy", "grid", "dy", 1);
  P2$("#dz-grid-mode").addEventListener("change",e=>{
    P2.design.grid.mode=e.target.value==="count"?"count":"step";
    syncGridModeUI();plan2Render();
  });
  for(const id of ["dz-grid-cols","dz-grid-rows","dz-grid-dx","dz-grid-dy"])
    P2$("#"+id).addEventListener("input",syncGridModeUI);
  dz("dz-vig-shape", "vig", "shape");    dz("dz-vig-color", "vig", "color");
  dz("dz-vig-op", "vig", "op", 1);
  dz("dz-vig-rx", "vig", "rx", 1);       dz("dz-vig-ry", "vig", "ry", 1);
  dz("dz-vig-feather", "vig", "feather", 1);
  dz("dz-sh-color", "shadow", "color");  dz("dz-sh-op", "shadow", "op", 1);
  dz("dz-sh-blur", "shadow", "blur", 1); dz("dz-sh-angle", "shadow", "angle", 1);
  dz("dz-sh-dist", "shadow", "dist", 1);
  dz("dz-noise-amount", "noise", "amount", 1);
  dz("dz-noise-distribution", "noise", "distribution");
  dz("dz-noise-monochromatic", "noise", "monochromatic");
  P2$("#dz-grid-ls").innerHTML =
    DASHES.map(d => `<option value="${d.id}">${d.name}</option>`).join("");

  // 비네트를 DESIGN AREA 한가운데로 옮긴다
  // ── 비네트 중심·반경 — 화면 % 가 아니라 장면(미터)이라 확대·이동해도 안 흔들린다
  const vigShow = () => {
    const v = P2.design.vig, sc = P2.scene;
    const r = v.rx > 0 ? v.rx : (sc ? Math.round(sc.radius * 0.6) : 0);
    P2$("#dz-vig-at").textContent =
      `중심 ${!v.cx && !v.cy ? "대상지 한가운데"
            : `동 ${Math.round(v.cx)}m · 북 ${Math.round(v.cy)}m`} · 반경 ${r}m`;
  };
  const vigSet = (cx, cy, rx, ry) => {
    const v = P2.design.vig;
    v.cx = cx; v.cy = cy;
    if (rx != null) {
      v.rx = Math.round(rx); v.ry = Math.round(ry == null ? rx : ry);
      P2$("#dz-vig-rx").value = v.rx;
      P2$("#dz-vig-ry").value = v.ry;
    }
    vigShow(); plan2Render();
  };
  P2.vigSet = vigSet;                       // 도판을 눌렀을 때 쓴다
  P2.vigShow = vigShow;                     // 대상지를 불러온 뒤 기본 반경을 다시 적는다

  P2$("#dz-vig-pick").addEventListener("click", () => {
    P2.pickVig = !P2.pickVig;
    P2$("#dz-vig-pick").classList.toggle("on", P2.pickVig);
    P2$("#p2canvas").style.cursor = P2.pickVig ? "crosshair" : "";
    if (P2.pickVig && !P2.design.vig.on) P2$("#dz-vig").click();   // 꺼져 있으면 켜 준다
  });

  P2$("#dz-vig-center").addEventListener("click", () => vigSet(0, 0));

  // DESIGN AREA 한가운데로. 반경도 그 범위를 덮게 맞춘다.
  P2$("#dz-vig-fit").addEventListener("click", () => {
    const sc = P2.scene;
    if (!sc || !P2.selected.size) return alert("DESIGN AREA 로 고른 필지가 없습니다.");
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of sc.parcels) {
      if (!P2.selected.has(p.pnu)) continue;
      for (const ring of p.rings) for (const q of ring) {
        x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]);
        y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
      }
    }
    if (!isFinite(x0)) return;
    vigSet((x0 + x1) / 2, (y0 + y1) / 2,
           (x1 - x0) / 2 * 1.25, (y1 - y0) / 2 * 1.25);
  });
  vigShow();

  // ── 도판 프리셋
  P2PS.bind();      // 담기·주고받기 단추는 presets.js 가 붙인다

  // ── 내보내기 창
  P2$("#p2-go").addEventListener("click", plan2OpenExport);
  P2$("#p2m-cancel").addEventListener("click", () => {
    P2.cropMode = false; plan2SetCrop(P2.crop);
    P2$("#p2modal").style.display = "none";
  });
  P2$("#p2modal").addEventListener("click", e => {
    if (e.target.id === "p2modal") P2$("#p2m-cancel").click();
  });
  document.querySelectorAll("#p2m-fmt button").forEach(b =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#p2m-fmt button").forEach(x => x.classList.toggle("on", x === b));
      P2.fmt = b.dataset.fmt;
      plan2ExportPreview();
    }));
  P2$("#p2m-scale").addEventListener("change", e => {
    P2.scale = +e.target.value; plan2ExportPreview();
  });
  P2$("#p2m-bgnone").addEventListener("change", e => {
    P2.bgNone = e.target.checked;
    plan2RenderLayers();
    plan2Render(); plan2ExportPreview();
  });
  P2$("#p2m-fit").addEventListener("click", () => {
    P2.exportScope = null; P2.cropMode = false;
    P2.zoom = 1; P2.panX = P2.panY = 0;
    plan2SetCrop(null); plan2SyncExportScope(); plan2ExportPreview();
  });
  P2$("#p2m-area").querySelectorAll("button[data-scope]").forEach(b =>
    b.addEventListener("click", () => plan2CropExportScope(b.dataset.scope)));
  P2$("#p2m-crop").addEventListener("click", () => {
    P2.exportScope = null; plan2SyncExportScope();
    P2.cropMode = true; plan2SetCrop(P2.crop);
    P2$("#p2modal").style.display = "none";  // 끌 동안은 창을 비킨다
  });
  P2$("#p2m-cropoff").addEventListener("click", () => {
    P2.exportScope = null; P2.cropMode = false;
    plan2SetCrop(null); plan2SyncExportScope(); plan2ExportPreview();
  });
  P2$("#p2m-go").addEventListener("click", () => {
    if (!P2.scene) return;
    const suffix = { context: "_CONTEXT", project: "_PROJECT_SITE",
                     design: "_DESIGN_AREA" }[P2.exportScope] || (P2.crop ? "_부분" : "");
    const stem = P2.scene.name + "_2D" + suffix;
    const ops = plan2List({ forExport: true });
    if (P2.fmt === "svg") DRAW.exportSVG(`${stem}.svg`, ops, plan2View());
    else if(P2.fmt==="aizip")DRAW.exportIllustratorPackage(`${stem}_AI레이어.zip`,ops,plan2View());
    else DRAW.exportPNG(`${stem}.png`, ops, plan2View(P2.scale));
    P2$("#p2modal").style.display = "none";
  });

  document.addEventListener("keydown", e => {
    if (!P2.cropMode || e.key !== "Enter") return;
    e.preventDefault();
    plan2FinishCrop();
  });

  // 예시 조건은 대상지를 연 뒤 seedRules() 가 실제 값으로 채운다.
  // 여기서 「목」 같은 부분 문자열로 심어 두면 드롭다운에 없는 값이 되어 버린다.

  plan2RenderLayers();
  bindLayerDrag();
  plan2SetCrop(null);
  window.addEventListener("resize", () => { if (P2.scene) plan2Render(); });
}
