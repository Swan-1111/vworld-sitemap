import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const begin = html.indexOf("async function loadSiteCore(name)");
const end = html.indexOf('let mode = "addr";', begin);

function fixture() {
  const pending = [], shown = [], messages = [], nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {checked: true});
    return nodes.get(id);
  };
  const no = () => {};
  const shape = () => ({addTo() {return this;}, bringToBack: no});
  const context = vm.createContext({
    siteLoadId: 0, current: null, siteSceneFingerprint: "", picked: new Map(),
    ROAD_ANALYSIS_ATTEMPTED: new Set(), parcelLayer: null, bldgLayer: null,
    extentBox: null, extentVeil: null, PARCEL_BY_PNU: new Map(),
    Q: node, MAP: {fitBounds: no, removeLayer: no},
    L: {rectangle: shape, polygon: shape, geoJSON: data => ({...shape(), data})},
    DRAW: {siteURL: (name, path = "") => name + path},
    renderPicked: no, setTerrain: no, markStages: no,
    psLoad: async () => {}, resetFilter: no, bindRightPanel: no, setPanelReady: no,
    foldSec: no, openStage: no, site_label: name => name, esc: String,
    fillFilterOptions: data => shown.push(data[0].properties.pnu),
    log: message => messages.push(message), refreshSites: async () => {},
    trackSiteState: promise => promise,
    fetch: url => new Promise((resolve, reject) => pending.push({url, resolve, reject})),
  });
  context.clearSite = () => {context.siteLoadId++; context.current = null;};
  vm.runInContext(html.slice(begin, end), context);
  const load = name => context.loadSite(name);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const reply = (index, data) => pending[index].resolve({ok: true, json: async () => data});
  const info = {bbox: [127, 37, 127.01, 37.01], layers: []};
  const features = name => ({features: [{properties: {pnu: name, bd_mgt_sn: name}}]});
  return {context, pending, shown, messages, load, tick, reply, info, features};
}

test("늦게 끝난 A의 필지 응답이 B 대상지·필터를 덮어쓰지 않는다", async () => {
  const f = fixture();
  const first = f.load("A"); f.reply(0, f.info); await f.tick();
  assert.equal(f.pending.length, 3); // 필지·건물 요청이 동시에 시작됨
  const latest = f.load("B"); f.reply(3, f.info); await f.tick();
  f.reply(4, f.features("B")); f.reply(5, f.features("B"));
  assert.equal(await latest, true);
  f.reply(1, f.features("A")); f.reply(2, f.features("A"));
  assert.equal(await first, false);
  assert.equal(f.context.current, "B");
  assert.deepEqual(f.shown, ["B"]);
  assert.equal(f.context.parcelLayer.data.features[0].properties.pnu, "B");
});

test("선택을 해제한 뒤 끝난 요청은 대상지를 다시 열지 않는다", async () => {
  const f = fixture(); const work = f.load("A");
  f.context.clearSite(); f.reply(0, f.info);
  assert.equal(await work, false);
  assert.equal(f.pending.length, 1);
  assert.equal(f.context.current, null);
});

test("네트워크 오류는 처리되지 않은 Promise 대신 로그로 알려준다", async () => {
  const f = fixture(); const work = f.load("A");
  f.pending[0].reject(new Error("offline"));
  assert.equal(await work, false);
  assert.equal(f.context.current, null);
  assert.ok(f.messages.some(message => message.includes("offline")));
});

test("3D 뷰 삭제 실패를 성공으로 표시하지 않고 저장 목록을 보존한다", async () => {
  const source = readFileSync(new URL("../web/diagram.js", import.meta.url), "utf8");
  const note = {textContent: "", querySelectorAll: () => []};
  const context = vm.createContext({
    document: {querySelector: () => note}, confirm: () => true,
    createAerialLoader: () => () => {}, makePresets: () => ({}),
    DRAW: {esc: String}, fetch: async () => ({ok: false}),
  });
  vm.runInContext(source, context);
  vm.runInContext('D3VIEWS=[{n:1,label:"saved",state:{preview:""}}]', context);
  await context.d3ViewDelete(1);
  assert.match(note.textContent, /지우지 못/);
  await context.d3ViewLoad();
  assert.equal(vm.runInContext("D3VIEWS.length", context), 1);
});
