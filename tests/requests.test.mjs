import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/requests.js", import.meta.url), "utf8");
function api(overrides = {}) {
  return vm.runInNewContext(source + ";({withAPIKeys, createAerialLoader})", {
    URL, URLSearchParams, Request, Headers, ...overrides,
  });
}

test("개인 인증 헤더는 정확히 같은 origin의 요청에만 추가한다", async () => {
  const calls = [];
  const send = api().withAPIKeys((url, options) => calls.push({url, options}),
    "https://example.com", () => ({"x-vworld-key": "test-key"}));
  for (const url of ["//other.example/api", "https://example.com.evil.test/api", "https://example.com:444/api"])
    await send(url);
  assert.ok(calls.every(call => !call.options.headers));
  await send(new URL("https://example.com/api"), {headers: new Headers({"x-custom": "kept"})});
  assert.equal(calls.at(-1).options.headers.get("x-vworld-key"), "test-key");
  assert.equal(calls.at(-1).options.headers.get("x-custom"), "kept");
  await send(new Request("https://example.com/api", {headers: {"x-request": "kept"}}));
  assert.equal(calls.at(-1).options.headers.get("x-request"), "kept");
});

function fixture() {
  const pending = [], applied = [], errors = [], stops = [];
  let scene = {name: "A", radius: 200}, seq = 0, badImage = false;
  const layer = {on: true, gray: false, base: false};
  const state = {};
  class Reader {
    readAsDataURL(blob) { this.result = blob; queueMicrotask(() => this.onload()); }
  }
  class Image {
    set src(value) {
      this.value = value;
      queueMicrotask(() => badImage ? this.onerror() : this.onload());
    }
  }
  const {createAerialLoader} = api({FileReader: Reader, Image,
    newAerialJobId: () => String(++seq),
    watchAerialProgress: id => () => stops.push(id),
    acceptVWorldKeyFallback: () => {},
    DRAW: {siteURL: (name, path, query) => `${name}${path}?${query}`},
    fetch: url => new Promise(resolve => pending.push({url, resolve})),
  });
  const load = createAerialLoader({state, scene: () => scene, layer: () => layer,
    enabled: () => layer.on, hasImage: () => !!state.image,
    clear: () => { state.image = null; }, changed: () => {},
    accept: image => { state.image = image; }, apply: () => applied.push(state.image.value),
    failed: error => errors.push(error.message),
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  function resolve(index, ok = true) {
    pending[index].resolve({ok, headers: new Headers({"X-Aerial-Radius": "180"}),
      blob: async () => pending[index].url, json: async () => ({detail: "old request failed"})});
  }
  return {state, layer, load, pending, applied, errors, stops, tick, resolve,
    setScene: value => { scene = value; }, breakImage: () => { badImage = true; }};
}

test("A 수집 중 B→C를 선택하면 A를 무시하고 최신 C만 적용한다", async () => {
  const f = fixture();
  const work = f.load(); await f.tick();
  f.setScene({name: "B", radius: 300}); const again = f.load();
  f.setScene({name: "C", radius: 400}); f.load();
  assert.equal(work, again);
  assert.equal(f.pending.length, 1);
  f.resolve(0); await f.tick();
  assert.equal(f.applied.length, 0);
  assert.match(f.pending[1].url, /^C\/aerial/);
  f.resolve(1); await work;
  assert.equal(f.applied.length, 1);
  assert.match(f.applied[0], /^C\/aerial/);
  assert.equal(f.state.radius, 180);
  assert.equal(f.state.loading, false);
});

test("이전 대상지의 실패는 새 대상지 레이어를 끄지 않는다", async () => {
  const f = fixture(); const work = f.load(); await f.tick();
  f.setScene({name: "B", radius: 200}); f.load();
  f.resolve(0, false); await f.tick();
  assert.deepEqual(f.errors, []);
  f.resolve(1); await work;
  assert.equal(f.applied.length, 1);
});

test("같은 대상지의 반경 변경은 사진을 다시 받고, 톤 조절은 캐시를 사용한다", async () => {
  const f = fixture(); let work = f.load(); await f.tick(); f.resolve(0); await work;
  await f.load(); assert.equal(f.pending.length, 1);
  f.setScene({name: "A", radius: 350}); work = f.load(); await f.tick();
  assert.equal(f.state.image, null);
  assert.match(f.pending[1].url, /radius=350/);
  f.resolve(1); await work;
});

test("대상지 해제 후 도착한 사진을 표시하지 않는다", async () => {
  const f = fixture(); const work = f.load(); await f.tick();
  f.setScene(null); f.load(); f.resolve(0); await work;
  assert.deepEqual(f.applied, []);
  assert.equal(f.state.image, null);
  assert.equal(f.state.loading, false);
});

test("잘못된 이미지도 무한 로딩 없이 오류를 알린다", async () => {
  const f = fixture(); f.breakImage();
  const work = f.load(); await f.tick(); f.resolve(0); await work;
  assert.equal(f.errors.length, 1);
  assert.equal(f.state.loading, false);
});
