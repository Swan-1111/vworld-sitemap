/* VWorld WebGL 3D 데이터를 이용한 화면 전용 렌더링 매스.
 *
 * 기존 Three.js 다이어그램은 도면·PNG·SVG·GLB 내보내기의 기준으로 그대로 둔다.
 * 이 모듈은 같은 대상지의 실물형 건물·지형을 레이어처럼 확인하는 보기만 맡는다.
 * 무거운 SDK는 사용자가 「렌더링용 매스」 레이어를 켠 뒤에만 내려받는다.
 */
(function (global) {
  "use strict";

  const state = {
    mode: "diagram", status: "idle", map: null, viewer: null,
    scriptPromise: null, sdkReady: false, scene: null, selected: new Set(),
    designSource: null,
    designRevision: 0, parcelCache: new Map(),
    modelEntities: new Map(),
    mappingEnabled: true, mappingOriginal: new Map(),
    designEnabled: false, onStatus: null, message: "", messageKind: "",
  };

  const el = id => document.getElementById(id);
  const say = (message, kind = "") => {
    state.message = message || "";
    state.messageKind = kind;
    const note = el("vw3d-note");
    if (note) {
      note.textContent = message || "";
      note.dataset.kind = kind;
    }
    const stage = el("vw3d-stage-status");
    if (stage) {
      stage.textContent = message || "";
      stage.dataset.kind = kind;
      stage.hidden = state.status === "ready" && kind !== "error";
    }
    if (typeof state.onStatus === "function") state.onStatus(message, kind);
  };

  function sceneCenter() {
    const center = state.scene?.center || [];
    return {lat: +center[0] || 37.5665, lon: +center[1] || 126.9780};
  }

  function sceneHeight() {
    const radius = +(state.scene?.radius || 250);
    return Math.max(320, Math.min(4200, radius * 2.8));
  }

  function appendScript(src, index) {
    const id = `vworld-webgl-engine-${index}`;
    const old = document.getElementById(id);
    if (old?.dataset.loaded === "1") return Promise.resolve();
    if (old) old.remove();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = id;
      script.src = src;
      script.async = false;
      script.onload = () => { script.dataset.loaded = "1"; resolve(); };
      script.onerror = () => {
        script.remove();
        reject(new Error(`VWorld 3D 엔진 ${index + 1}단계를 받지 못했습니다.`));
      };
      document.head.appendChild(script);
    });
  }

  function loadSDK(key) {
    // vw.Map 하나는 첫 스크립트만 읽어도 생길 수 있다. 모든 후속 의존성이
    // 준비됐다는 별도 표식이 없으면 실패 뒤 재시도가 반쪽짜리 SDK를 사용하게 된다.
    if (state.sdkReady && global.vw?.Map) return Promise.resolve(global.vw);
    if (state.scriptPromise) return state.scriptPromise;
    if (!key) return Promise.reject(new Error("VWorld 인증키가 없습니다."));
    state.status = "loading";
    say("렌더링용 실물 매스를 불러오는 중…");
    state.scriptPromise = (async () => {
      const response = await fetch("/api/vworld/webgl-config", {cache:"no-store"});
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || "VWorld WebGL 초기화 정보를 받지 못했습니다.");
      }
      const config = await response.json();
      // 공식 초기화 파일이 설정하던 전역값이다. document.write 부분만 실행하지 않고
      // 아래 두 엔진을 await로 순서대로 붙여 이미 열린 앱 문서를 보존한다.
      global.v_protocol = "https://";
      global.vworldUrl = "https://map.vworld.kr";
      global.vworld2DCache = "https://2d.vworld.kr/2DCache";
      global.vworldBaseMapUrl = "https://cdn.vworld.kr/2d";
      global.vworldStyledMapUrl = "https://2d.vworld.kr/stmap";
      global.isUserDomain = "";
      global.vworldIsValid = "true";
      global.vworldErrMsg = "";
      global.vworldApiKey = key;
      global.vworld3DUrl = "/js/webglMapInit.js.do";
      global.vworldNoCss = "n";
      global.vworldVectorKey = config.vector_key || "";
      for (const [index, src] of (config.scripts || []).entries()) {
        say(`렌더링용 실물 매스를 불러오는 중… ${index + 1}/${config.scripts.length}`);
        await appendScript(src, index);
      }
      const dependencies = [...new Set(global.__VWORLD_OL3_DEPS__ || [])].filter(Boolean);
      for (const [index, src] of dependencies.entries()) {
        say(`VWorld 지도 구성요소를 연결하는 중… ${index + 1}/${dependencies.length}`);
        await appendScript(src, (config.scripts || []).length + index);
      }
      // 이 엔진의 오래된 플러그인 일부는 window.jQuery가 아니라 전역 `$`를
      // 직접 참조한다. 앱의 DOM 단축 함수는 index.html 내부 스코프로 격리했고,
      // 여기서는 모든 의존성을 읽은 뒤 `$`가 실제 jQuery인지 한 번 더 보장한다.
      const jquery = global.jQuery;
      if (typeof jquery !== "function" || typeof jquery.fn?.addClass !== "function")
        throw new Error("VWorld가 사용하는 jQuery 구성요소가 준비되지 않았습니다.");
      global.$ = jquery;
      if (!global.vw?.Map) throw new Error("VWorld WebGL 3D 모듈이 초기화되지 않았습니다.");
      state.sdkReady = true;
      return global.vw;
    })().catch(error => {
      state.scriptPromise = null;
      state.sdkReady = false;
      state.status = "error";
      throw error;
    });
    return state.scriptPromise;
  }

  async function waitForViewer(timeout = 15000) {
    const started = performance.now();
    while (performance.now() - started < timeout) {
      const viewer = global.ws3d?.viewer || state.map?.getViewer?.();
      if (viewer?.scene && global.Cesium) return viewer;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error("VWorld 3D 뷰어 준비 시간이 초과됐습니다.");
  }

  async function ensure(options = {}) {
    state.scene = options.scene || state.scene;
    state.onStatus = options.onStatus || state.onStatus;
    await loadSDK(options.key || "");
    if (!state.map) {
      const center = sceneCenter();
      const map = new global.vw.Map();
      try {
        map.setOption({
          mapId: "vworld3d",
          initPosition: new global.vw.CameraPosition(
            new global.vw.CoordZ(center.lon, center.lat, sceneHeight()),
            new global.vw.Direction(0, -55, 0)
          ),
          logo: true,
          navigation: false,
        });
        map.setMapId("vworld3d");
        map.start();
        state.map = map;
        state.viewer = await waitForViewer();
      } catch (error) {
        try { map.stop?.(); map.destroy?.(); } catch (_) {}
        state.map = null; state.viewer = null;
        const host = el("vworld3d");if(host)host.replaceChildren();
        throw error;
      }
    } else if (!state.viewer) {
      state.viewer = await waitForViewer();
    }
    state.status = "ready";
    say("렌더링용 실물 매스 · 화면 조회 전용 · 내보내기 제외");
    return state.viewer;
  }

  function setRenderLoop(active) {
    const viewer = state.viewer;
    if (!viewer) return;
    try {
      viewer.useDefaultRenderLoop = !!active;
      if (active) viewer.scene.requestRender?.();
    } catch (_) {}
  }

  async function show(options = {}) {
    state.mode = "real";
    const host = el("vworld3d");
    if (host) host.style.display = "block";
    const stage = el("vw3d-stage-status");if(stage)stage.hidden=false;
    try {
      await ensure(options);
      if (state.mode !== "real") return;
      setRenderLoop(true);
      state.designEnabled = options.showDesign === true;
      await syncDesign(options.site, options.selected);
      setMapping(options.mapping ?? state.mappingEnabled);
      fit(false);
    } catch (error) {
      say(error.message || String(error), "error");
      if (typeof options.onError === "function") options.onError(error);
      throw error;
    }
  }

  function hide() {
    state.mode = "diagram";
    const host = el("vworld3d");
    if (host) host.style.display = "none";
    const stage = el("vw3d-stage-status");if(stage)stage.hidden=true;
    setRenderLoop(false);
  }

  function fit(animated = true) {
    const center = sceneCenter(), height = sceneHeight();
    if (state.viewer && global.Cesium) {
      const camera = state.viewer.camera;
      const destination = global.Cesium.Cartesian3.fromDegrees(center.lon, center.lat, height);
      const options = {
        destination,
        orientation: {heading: 0, pitch: global.Cesium.Math.toRadians(-55), roll: 0},
        duration: animated ? 1.1 : 0,
      };
      try { animated ? camera.flyTo(options) : camera.setView(options); return; } catch (_) {}
    }
    try {
      state.map?.moveTo?.(new global.vw.CameraPosition(
        new global.vw.CoordZ(center.lon, center.lat, height),
        new global.vw.Direction(0, -55, 0)
      ));
    } catch (_) {}
  }

  function setMapLayers(ids, visible, label = "실물") {
    if (!state.map) return false;
    let changed = false;
    for (const id of ids) {
      try {
        const layer = state.map.getLayerElement?.(id);
        if (!layer) continue;
        visible ? layer.show?.() : layer.hide?.();
        changed = true;
      } catch (_) {}
    }
    state.viewer?.scene?.requestRender?.();
    if (!changed && state.status === "ready")
      say(`현재 VWorld WebGL 엔진에서 ${label} 레이어 제어 항목을 찾지 못했습니다.`, "warning");
    return changed;
  }

  function setBuildings(visible) {
    return setMapLayers(["facility_build", "facility_build_all", "facility_build_lod1"], visible,
      "건물");
  }

  function setBridges(visible) {
    return setMapLayers(["facility_bridge", "facility_road", "facility_transport"], visible,
      "교량·고가도로");
  }

  function visitPrimitives(collection, visit, seen = new Set()) {
    if (!collection || seen.has(collection)) return;
    seen.add(collection);
    const length = Number(collection.length) || 0;
    for (let index = 0; index < length; index++) {
      let primitive = null;
      try { primitive = collection.get ? collection.get(index) : collection[index]; } catch (_) {}
      if (!primitive || seen.has(primitive)) continue;
      seen.add(primitive); visit(primitive);
      visitPrimitives(primitive._primitives, visit, seen);
      visitPrimitives(primitive.primitives, visit, seen);
    }
  }

  function isTileset(primitive) {
    const C = global.Cesium;
    try {
      if (C?.Cesium3DTileset && primitive instanceof C.Cesium3DTileset) return true;
    } catch (_) {}
    return primitive?.constructor?.name === "Cesium3DTileset" ||
      ("colorBlendMode" in (primitive || {}) && "style" in (primitive || {}));
  }

  function applyMassMaterial() {
    const viewer = state.viewer, C = global.Cesium;
    if (!viewer || !C || state.mappingEnabled) return 0;
    let count = 0;
    visitPrimitives(viewer.scene?.primitives, primitive => {
      if (!isTileset(primitive)) return;
      if (!state.mappingOriginal.has(primitive)) {
        state.mappingOriginal.set(primitive, {
          style: primitive.style,
          colorBlendMode: primitive.colorBlendMode,
          colorBlendAmount: primitive.colorBlendAmount,
        });
      }
      try {
        primitive.style = new C.Cesium3DTileStyle({color:"color('#d9dde2')",show:true});
        if (C.Cesium3DTileColorBlendMode)
          primitive.colorBlendMode = C.Cesium3DTileColorBlendMode.REPLACE;
        if ("colorBlendAmount" in primitive) primitive.colorBlendAmount = 1;
        count++;
      } catch (_) {}
    });
    viewer.scene?.requestRender?.();
    return count;
  }

  function setMapping(enabled) {
    state.mappingEnabled = enabled !== false;
    if (state.mappingEnabled) {
      for (const [primitive, original] of state.mappingOriginal) {
        try {
          primitive.style = original.style;
          primitive.colorBlendMode = original.colorBlendMode;
          if ("colorBlendAmount" in primitive) primitive.colorBlendAmount = original.colorBlendAmount;
        } catch (_) {}
      }
      state.mappingOriginal.clear();
      state.viewer?.scene?.requestRender?.();
      return true;
    }
    applyMassMaterial();
    // 실물 타일셋은 카메라가 열린 뒤 늦게 붙기도 한다. 짧은 구간만 다시 훑어
    // 새로 도착한 타일셋에도 같은 흰색 매스 재질을 적용한다.
    for (const delay of [300, 900, 1800, 3200]) setTimeout(() => {
      if (state.mode === "real" && !state.mappingEnabled) applyMassMaterial();
    }, delay);
    return true;
  }

  async function parcelsFor(site) {
    const siteKey = String(site || "");
    if (!siteKey) return {type:"FeatureCollection", features:[]};
    const key = `${siteKey}\u0000${state.scene?._fingerprint || "current"}`;
    for (const old of state.parcelCache.keys())
      if (old.startsWith(siteKey + "\u0000") && old !== key) state.parcelCache.delete(old);
    if (!state.parcelCache.has(key)) {
      const pending = fetch(DRAW.siteURL(siteKey, "/parcels"), {cache:"no-store"})
        .then(async response => {
          if (!response.ok) throw new Error("DESIGN AREA 필지를 읽지 못했습니다.");
          return response.json();
        })
        .catch(error => {
          state.parcelCache.delete(key);
          throw error;
        });
      state.parcelCache.set(key, pending);
    }
    return state.parcelCache.get(key);
  }

  function removeDesignSource(source = state.designSource) {
    if (!source || !state.viewer) return;
    try { state.viewer.dataSources.remove(source, true); } catch (_) {}
    if (state.designSource === source) state.designSource = null;
  }

  async function syncDesign(site, selected) {
    const revision = ++state.designRevision;
    state.selected = selected instanceof Set ? new Set(selected) : new Set(selected || []);
    if (!state.viewer || !global.Cesium) return;
    const enabled = state.designEnabled;
    if (!enabled || !site || !state.selected.size) {
      removeDesignSource();
      state.viewer.scene.requestRender?.();
      return;
    }
    try {
      const source = await parcelsFor(site);
      if (revision !== state.designRevision) return;
      const data = {...source, features:(source.features || []).filter(feature =>
        state.selected.has(String(feature.properties?.pnu || "")))};
      if (!data.features.length) {
        removeDesignSource();
        return;
      }
      const ds = await global.Cesium.GeoJsonDataSource.load(data, {
        clampToGround: true,
        stroke: global.Cesium.Color.fromCssColorString("#e2564a"),
        fill: global.Cesium.Color.fromCssColorString("#e2564a").withAlpha(.18),
        strokeWidth: 3,
      });
      if (revision !== state.designRevision || state.mode !== "real") return;
      const added = await state.viewer.dataSources.add(ds);
      if (revision !== state.designRevision || state.mode !== "real") {
        removeDesignSource(added);
        return;
      }
      const previous = state.designSource;
      state.designSource = added;
      if (previous && previous !== added) removeDesignSource(previous);
      state.viewer.scene.requestRender?.();
    } catch (error) {
      if (revision === state.designRevision)
        say("DESIGN AREA 표시 실패: " + (error.message || error), "error");
    }
  }

  function syncModels(models) {
    const viewer=state.viewer,C=global.Cesium;
    if(!viewer||!C)return;
    const wanted=models instanceof Map?models:new Map();
    for(const [key,entity] of state.modelEntities){
      if(wanted.has(key))continue;
      viewer.entities.remove(entity);state.modelEntities.delete(key);
    }
    for(const [key,model] of wanted){
      const old=state.modelEntities.get(key);if(old)viewer.entities.remove(old);
      const center=model.center||[];
      if(!Number.isFinite(+center[0])||!Number.isFinite(+center[1]))continue;
      const position=C.Cartesian3.fromDegrees(+center[0],+center[1],0);
      const entity=viewer.entities.add({
        name:`DESIGN AREA 사용자 모델 · ${model.name||"GLB"}`,
        position,
        orientation:C.Transforms.headingPitchRollQuaternion(position,new C.HeadingPitchRoll(0,0,0)),
        model:{uri:model.url,scale:Math.max(.0001,+model.scale||1),
          heightReference:C.HeightReference.CLAMP_TO_GROUND,runAnimations:true},
      });
      state.modelEntities.set(key,entity);
    }
    viewer.scene.requestRender?.();
  }

  function cameraState() {
    if (!state.viewer || !global.Cesium) return null;
    const camera = state.viewer.camera;
    const c = global.Cesium.Cartographic.fromCartesian(camera.positionWC);
    return {
      viewer: "vworld",
      lon: global.Cesium.Math.toDegrees(c.longitude),
      lat: global.Cesium.Math.toDegrees(c.latitude),
      height: c.height,
      heading: camera.heading, pitch: camera.pitch, roll: camera.roll,
    };
  }

  async function applyCamera(saved, options = {}) {
    if (!saved || saved.viewer !== "vworld") return false;
    await show(options);
    if (!state.viewer || !global.Cesium) return false;
    state.viewer.camera.flyTo({
      destination: global.Cesium.Cartesian3.fromDegrees(saved.lon, saved.lat, saved.height),
      orientation: {heading:saved.heading, pitch:saved.pitch, roll:saved.roll},
      duration: 1.1,
    });
    return true;
  }

  function preview() {
    try {
      const canvas = state.viewer?.scene?.canvas;
      if (!canvas?.width) return "";
      const thumb = document.createElement("canvas");
      thumb.width = 240; thumb.height = 150;
      const ctx = thumb.getContext("2d");
      ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
      return thumb.toDataURL("image/jpeg", .78);
    } catch (_) { return ""; }
  }

  global.VW3D = {
    state, show, hide, fit, setBuildings, setBridges, setMapping, syncDesign,
    syncModels, cameraState, applyCamera, preview,
    isReal: () => state.mode === "real",
  };
})(window);
