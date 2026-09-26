/* 그리기 목록(display list)과 두 가지 출력.
 *
 * 3D·2D 모두 「무엇을 그릴지」를 목록으로 만든 뒤, 그 목록을 캔버스에 칠하거나
 * SVG로 뱉는다. 화면과 저장본이 갈라지지 않게 하려면 이 방법밖에 없다.
 *
 * op 종류
 *   {t:"poly",     pts | rings, fill, stroke, w, close, fillRule}
 *   {t:"path",     pts, stroke, strokeGradient, w}       열린 선
 *   {t:"dot",      x, y, r, fill, stroke, w}
 *   {t:"text",     x, y, s, size, weight, fill, anchor}
 *   {t:"image",    img, href, x, y, w, h}                href 는 SVG 용 data URL
 *   {t:"vignette", shape, cx, cy, rx, ry, feather, color, op, w, h}
 *   {t:"noise",    x, y, w, h, amount, distribution, monochromatic, seed}
 *   {t:"hatch",    rings, pattern, color, spacing, w}      면 안쪽 해치
 *   {t:"roadField",segments, low, high, blendMeters}        도로 중심선 가우시안 필드
 *   {t:"clipStart", rings} … {t:"clipEnd"}               캔버스/SVG 레이어 clip
 *
 * 어느 op 에나 붙일 수 있는 것
 *   opacity   0~1
 *   dash      [켬, 끔, …] — 굵기의 배수다
 *   shadow    {color, blur, dx, dy}
 *   layer     이 op 가 속한 레이어 이름. SVG 에서 <g id="…"> 로 묶인다
 *   rings     고리 여럿을 한 도형으로. fillRule 이 evenodd 면 안쪽이 구멍
 */

// 비네트가 캔버스와 SVG 에서 같아 보이려면 이 값을 함께 써야 한다.
// 캔버스는 반지름을 이만큼 늘려 그러데이션을 만들고, SVG 는 그 역수를 %로 쓴다.
// 한쪽만 고치면 화면과 저장본이 조용히 달라진다.
const VIG_SPREAD = 1.6;

// 화면을 움직일 때마다 수만 개의 그림자 고리를 다시 nonzero 한 번으로 채우면
// Chromium의 winding 판정 비용이 급격히 커진다. 작은 고리들을 불투명 마스크에
// 따로 채우면 겹친 곳의 농도는 그대로 한 번이고 훨씬 빠르다. 완성된 마스크는 같은
// 뷰에서 다시 쓸 수 있도록 제한된 LRU에 둔다.
const shadowMaskCache = new Map(), noisePatternCache = new Map(), roadFieldCache = new Map();
// 수천 필지를 한 Canvas path/SVG compound path로 만들면 일부 브라우저와 Illustrator가
// 뒤 레이어까지 렌더하지 못한다. 한 묶음의 복잡도를 제한하되 패턴 원점은 유지한다.
const HATCH_RING_CHUNK = 160;
const shadowCacheState = {bytes: 0, max: 48 * 1024 * 1024};
const noiseCacheState = {bytes: 0, max: 48 * 1024 * 1024};
const roadFieldCacheState = {bytes: 0, max: 64 * 1024 * 1024};
const drawCacheStats = {shadowHits: 0, shadowMisses: 0, noiseHits: 0, noiseMisses: 0,
  roadFieldHits: 0, roadFieldMisses: 0};

function cacheGet(cache, key) {
  if (!key || !cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key); cache.set(key, value);       // 최근 사용 항목을 맨 뒤로
  return value;
}

function cachePut(cache, state, key, value, bytes) {
  if (!key || bytes > state.max) return;
  if (cache.has(key)) {
    state.bytes -= cache.get(key).bytes || 0;
    cache.delete(key);
  }
  value.bytes = bytes; cache.set(key, value); state.bytes += bytes;
  while (state.bytes > state.max && cache.size) {
    const oldest = cache.keys().next().value, dropped = cache.get(oldest);
    state.bytes -= dropped.bytes || 0; cache.delete(oldest);
  }
}

// Photoshop Add Noise처럼 현재까지 합성된 픽셀의 RGB 값에 양·음의 난수를 더한다.
// 좌표 해시를 쓰므로 반복 타일이 없고, 같은 배율에서는 전체 화면과 크롭 결과가 같다.
function noiseRandom(x, y, channel, seed) {
  let h = Math.imul((x | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul((y | 0) ^ 0xc2b2ae35, 0x27d4eb2d);
  h ^= Math.imul((channel | 0) + (seed | 0), 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function noiseSample(distribution, x, y, channel, seed) {
  if (distribution !== "gaussian") return noiseRandom(x, y, channel, seed) * 2 - 1;
  // 독립 균등분포 여섯 개의 합을 표준화한 정규분포 근사. 반복 타일 없이
  // 가운데 값이 많고 드문 큰 편차가 생겨 Photoshop의 speckled Gaussian에 가깝다.
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += noiseRandom(x, y, channel * 7 + i, seed);
  return (sum - 3) * Math.SQRT2;
}

const NOISE_SAMPLE_SCALE = 4096;

function cachedNoisePattern(width, height, originX, originY, distribution, monochromatic, seed) {
  const channels = monochromatic ? 1 : 3;
  const key = `${width}x${height}|${originX},${originY}|${distribution}|${channels}|${seed}`;
  let cached = cacheGet(noisePatternCache, key);
  if (cached) { drawCacheStats.noiseHits++; return cached.data; }
  drawCacheStats.noiseMisses++;
  const data = new Int16Array(width * height * channels);
  let at = 0;
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const x = originX + px, y = originY + py;
    if (monochromatic) {
      data[at++] = Math.round(noiseSample(distribution, x, y, 0, seed) * NOISE_SAMPLE_SCALE);
    } else {
      for (let channel = 0; channel < 3; channel++)
        data[at++] = Math.round(noiseSample(distribution, x, y, channel, seed) * NOISE_SAMPLE_SCALE);
    }
  }
  cachePut(noisePatternCache, noiseCacheState, key, {data}, data.byteLength);
  return data;
}

function addNoiseCanvas(ctx, o) {
  const transform = ctx.getTransform();
  const left = Math.max(0, Math.floor((o.x || 0) * transform.a + transform.e));
  const top = Math.max(0, Math.floor((o.y || 0) * transform.d + transform.f));
  const right = Math.min(ctx.canvas.width,
    Math.ceil(((o.x || 0) + (o.w || 0)) * transform.a + transform.e));
  const bottom = Math.min(ctx.canvas.height,
    Math.ceil(((o.y || 0) + (o.h || 0)) * transform.d + transform.f));
  if (right <= left || bottom <= top) return;
  const image = ctx.getImageData(left, top, right - left, bottom - top);
  const pixels = image.data;
  const amount = Math.max(0, Math.min(400, +o.amount || 0));
  const amplitude = amount / 100 * 255;
  const gaussianScale = o.distribution === "gaussian" ? .5 : 1;
  const monochromatic = o.monochromatic !== false;
  const seed = Number.isFinite(+o.seed) ? +o.seed : 2701;
  // 난수 자체는 도판을 이동하거나 확대해도 같은 화면 픽셀에서 변하지 않는다.
  // 비싼 좌표 해시는 한 번만 계산하고, 이후에는 캐시된 표본에 현재 강도만 곱한다.
  const originX = Math.floor(left - transform.e), originY = Math.floor(top - transform.f);
  const pattern = cachedNoisePattern(image.width, image.height, originX, originY,
    o.distribution, monochromatic, seed);
  const factor = amplitude * gaussianScale / NOISE_SAMPLE_SCALE;
  const patternChannels = monochromatic ? 1 : 3;
  for (let py = 0, i = 0, pi = 0; py < image.height; py++)
    for (let px = 0; px < image.width; px++, i += 4, pi += patternChannels) {
    if (!pixels[i + 3]) continue;             // 투명 바탕은 그대로 보존한다.
    const common = monochromatic ? Math.round(pattern[pi] * factor) : 0;
    for (let channel = 0; channel < 3; channel++) {
      const delta = monochromatic ? common
        : Math.round(pattern[pi + channel] * factor);
      pixels[i + channel] = Math.max(0, Math.min(255, Math.round(pixels[i + channel] + delta)));
    }
  }
  ctx.putImageData(image, left, top);
}

function paintShadowCanvas(ctx, o) {
  const rings = o.rings || [];
  if (!rings.length) return;
  if (!o.castSweep) {
    ctx.save();
    ctx.translate(+o.dx || 0, +o.dy || 0);
    const blur = Math.max(0, +o.blur || 0);
    if (blur > 0) ctx.filter = `blur(${blur}px)`;
    ctx.beginPath();
    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      ctx.moveTo(ring[0][0], ring[0][1]);
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0], ring[i][1]);
      ctx.closePath();
    }
    ctx.fillStyle = o.fill || "rgba(0,0,0,.3)";
    ctx.fill(o.fillRule || "nonzero");
    ctx.restore();
    return;
  }

  const transform = ctx.getTransform(), width = ctx.canvas.width, height = ctx.canvas.height;
  const matrixKey = [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f]
    .map(value => Math.round(value * 10000) / 10000).join(",");
  const key = o.cacheKey
    ? `${o.cacheKey}|${width}x${height}|${matrixKey}|${o.fill}|${+o.blur || 0}` : "";
  let cached = cacheGet(shadowMaskCache, key);
  if (cached) {
    drawCacheStats.shadowHits++;
  } else {
    drawCacheStats.shadowMisses++;
    const mask = document.createElement("canvas"); mask.width = width; mask.height = height;
    const maskCtx = mask.getContext("2d");
    maskCtx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
    maskCtx.fillStyle = "#ffffff";
    // 한 거대한 compound fill은 고리 사이의 winding 관계를 모두 판정해 매우 느리다.
    // 불투명 마스크에는 고리를 따로 채워도 겹친 부분이 진해지지 않는다.
    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      maskCtx.beginPath(); maskCtx.moveTo(ring[0][0], ring[0][1]);
      for (let i = 1; i < ring.length; i++) maskCtx.lineTo(ring[i][0], ring[i][1]);
      maskCtx.closePath(); maskCtx.fill();
    }
    maskCtx.setTransform(1, 0, 0, 1, 0, 0);
    maskCtx.globalCompositeOperation = "source-in";
    maskCtx.fillStyle = o.fill || "rgba(0,0,0,.3)";
    maskCtx.fillRect(0, 0, width, height);

    const blur = Math.max(0, +o.blur || 0);
    let image = mask;
    if (blur > 0) {
      image = document.createElement("canvas"); image.width = width; image.height = height;
      const imageCtx = image.getContext("2d"); imageCtx.filter = `blur(${blur}px)`;
      imageCtx.drawImage(mask, 0, 0);
    }
    cached = {image};
    cachePut(shadowMaskCache, shadowCacheState, key, cached, width * height * 4);
  }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(cached.image, 0, 0); ctx.restore();
}

/** 중심선 표본을 가우시안으로 누적해 값/가중치 필드를 만들고 색상 램프로 변환한다. */
function roadFieldImage(o, width, height, transform) {
  const matrix = transform || {a:1, b:0, c:0, d:1, e:0, f:0};
  const matrixKey = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]
    .map(value => Math.round(value * 10000) / 10000).join(",");
  const key = o.cacheKey
    ? `${o.cacheKey}|${width}x${height}|${matrixKey}|${o.mode || "number"}|${o.low}|${o.high}|${(o.palette || []).join(",")}` : "";
  let cached = cacheGet(roadFieldCache, key);
  if (cached) { drawCacheStats.roadFieldHits++; return cached.image; }
  drawCacheStats.roadFieldMisses++;

  // 두 실제 픽셀마다 필드 한 칸을 계산한다. 결과는 부드럽게 확대하고 최종 도로
  // Polygon clip은 원 해상도에서 처리하므로 경계는 흐려지지 않는다.
  const cell = 2, gridW = Math.max(1, Math.ceil(width / cell));
  const gridH = Math.max(1, Math.ceil(height / cell));
  const categoryMode = o.mode === "category";
  const weights = new Float32Array(gridW * gridH);
  const values = new Float32Array(gridW * gridH);
  const categoryAt = categoryMode ? new Int16Array(gridW * gridH) : null;
  if (categoryAt) categoryAt.fill(-1);
  const detScale = Math.sqrt(Math.max(1e-12, Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)));
  const point = (x, y) => [
    (matrix.a * x + matrix.c * y + matrix.e) / cell,
    (matrix.b * x + matrix.d * y + matrix.f) / cell
  ];

  for (const segment of o.segments || []) {
    const a = point(segment.x1, segment.y1), b = point(segment.x2, segment.y2);
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (length < .005) continue;
    const sigma = Math.max(.55, (+segment.sigma || 1) * detScale / cell);
    const radius = Math.max(2, Math.ceil(sigma * 2.75));
    const sigma2 = sigma * sigma, step = Math.max(.75, sigma * .6);
    const count = Math.max(1, Math.ceil(length / step));
    const value = Math.max(0, Math.min(1, +segment.value || 0));
    const category = Math.max(0, Math.floor(+segment.category || 0));
    for (let sample = 0; sample <= count; sample++) {
      const t = sample / count, sx = a[0] + dx * t, sy = a[1] + dy * t;
      const x0 = Math.max(0, Math.floor(sx - radius)), x1 = Math.min(gridW - 1, Math.ceil(sx + radius));
      const y0 = Math.max(0, Math.floor(sy - radius)), y1 = Math.min(gridH - 1, Math.ceil(sy + radius));
      for (let gy = y0; gy <= y1; gy++) {
        const oy = gy + .5 - sy, oy2 = oy * oy;
        for (let gx = x0; gx <= x1; gx++) {
          const ox = gx + .5 - sx, distance2 = ox * ox + oy2;
          if (distance2 > radius * radius) continue;
          const weight = Math.exp(-distance2 / (2 * sigma2));
          const index = gy * gridW + gx;
          if (categoryMode) {
            // 범주 코드는 평균낼 수 없다. 가장 가까워 영향력이 큰 선의 범주를 고른다.
            if (weight > weights[index]) {
              weights[index] = weight;
              categoryAt[index] = category;
            }
          } else {
            weights[index] += weight; values[index] += weight * value;
          }
        }
      }
    }
  }

  const low = DRAW.rgb(o.low || "#ffffff"), high = DRAW.rgb(o.high || "#e2564a");
  const palette = (o.palette || []).map(color => DRAW.rgb(color));
  const small = document.createElement("canvas"); small.width = gridW; small.height = gridH;
  const smallCtx = small.getContext("2d"), imageData = smallCtx.createImageData(gridW, gridH);
  const pixels = imageData.data;
  for (let index = 0, at = 0; index < weights.length; index++, at += 4) {
    if (weights[index] < .003) continue;
    if (categoryMode) {
      const color = palette[categoryAt[index]] || low;
      pixels[at] = color[0]; pixels[at + 1] = color[1]; pixels[at + 2] = color[2];
    } else {
      const t = Math.max(0, Math.min(1, values[index] / weights[index]));
      pixels[at] = Math.round(low[0] + (high[0] - low[0]) * t);
      pixels[at + 1] = Math.round(low[1] + (high[1] - low[1]) * t);
      pixels[at + 2] = Math.round(low[2] + (high[2] - low[2]) * t);
    }
    pixels[at + 3] = 255;
  }
  smallCtx.putImageData(imageData, 0, 0);
  const image = document.createElement("canvas"); image.width = width; image.height = height;
  const imageCtx = image.getContext("2d"); imageCtx.imageSmoothingEnabled = true;
  imageCtx.imageSmoothingQuality = "high";
  imageCtx.drawImage(small, 0, 0, width, height);
  cached = {image};
  cachePut(roadFieldCache, roadFieldCacheState, key, cached, width * height * 4);
  return image;
}

function paintRoadFieldCanvas(ctx, o) {
  if (!(o.segments || []).length) return;
  const image = roadFieldImage(o, ctx.canvas.width, ctx.canvas.height, ctx.getTransform());
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(image, 0, 0); ctx.restore();
}

function paintCanvasHatch(ctx, o) {
  const rings = (o.rings || []).filter(ring => ring && ring.length >= 3);
  if (!rings.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings) for (const point of ring) {
    x0 = Math.min(x0, point[0]); y0 = Math.min(y0, point[1]);
    x1 = Math.max(x1, point[0]); y1 = Math.max(y1, point[1]);
  }
  const spacing = Math.max(.1, Math.min(160, +o.spacing || 8));
  const width = Math.max(.01, Math.min(12, +o.w || .5));
  ctx.save();
  ctx.beginPath();
  for (const ring of rings) {
    ctx.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0], ring[i][1]);
    ctx.closePath();
  }
  ctx.clip(o.fillRule || "evenodd");
  ctx.strokeStyle = o.color || "#555555";
  ctx.fillStyle = o.color || "#555555";
  ctx.lineWidth = width;
  if (o.pattern === "dots") {
    const radius = Math.max(.02, width * 1.35);
    ctx.beginPath();
    for (let y = Math.floor(y0 / spacing) * spacing; y <= y1; y += spacing)
      for (let x = Math.floor(x0 / spacing) * spacing; x <= x1; x += spacing) {
        ctx.moveTo(x + radius, y); ctx.arc(x, y, radius, 0, Math.PI * 2);
      }
    ctx.fill();
  } else {
    const drawAngle = degrees => {
      const angle = degrees * Math.PI / 180;
      const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
      const corners = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
      const projections = corners.map(point => point[0] * nx + point[1] * ny);
      const p0 = Math.min(...projections), p1 = Math.max(...projections);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const centerProjection = cx * nx + cy * ny;
      const length = Math.hypot(x1 - x0, y1 - y0) + spacing * 2;
      for (let p = Math.floor(p0 / spacing) * spacing; p <= p1; p += spacing) {
        const mx = cx + nx * (p - centerProjection), my = cy + ny * (p - centerProjection);
        ctx.moveTo(mx - dx * length, my - dy * length);
        ctx.lineTo(mx + dx * length, my + dy * length);
      }
    };
    ctx.beginPath();
    const pattern = o.pattern || "diag";
    drawAngle(pattern === "horizontal" ? 0 : pattern === "vertical" ? 90 : 45);
    if (pattern === "cross") drawAngle(-45);
    ctx.stroke();
  }
  ctx.restore();
}

const DRAW = {
  cacheStats() { return {...drawCacheStats}; },
  clearCaches() {
    shadowMaskCache.clear(); noisePatternCache.clear(); roadFieldCache.clear();
    shadowCacheState.bytes = 0; noiseCacheState.bytes = 0; roadFieldCacheState.bytes = 0;
    for (const key of Object.keys(drawCacheStats)) drawCacheStats[key] = 0;
  },

  /** #rrggbb → [r,g,b] */
  rgb(hex) {
    const v = String(hex).replace("#", "");
    const n = parseInt(v.length === 3 ? v.split("").map(c => c + c).join("") : v, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  },

  /** #rrggbb + 알파 → rgba(). 비네트 그러데이션이 이걸로 만들어진다. */
  _rgba(hex, a) {
    const [r, g, b] = DRAW.rgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  },

  /** 대상지 API 주소. 이름에 한글·공백이 들어가므로 반드시 인코딩해야 한다 —
   *  스무 군데에 손으로 적다 보면 한 군데씩 빠뜨린다. */
  siteURL(name, path = "", query = "") {
    return `/api/site/${encodeURIComponent(name)}${path}` + (query ? "?" + query : "");
  },

  /** XML 특수문자 막기. 레이어 이름이 id 속성에 그대로 들어가므로
   *  따옴표까지 막아야 한다 — 안 그러면 SVG 가 그 자리에서 잘린다. */
  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  paintCanvas(ctx, ops) {
    for (const o of ops) {
      // 레이어 투명도. 채우기 색 자체의 알파와 곱해진다.
      const a = o.opacity ?? 1;
      if (a <= 0) continue;
      const structural = o.t === "clipStart" || o.t === "clipEnd";
      const dim = !structural && (a < 1 || o.shadow);
      if (dim) {
        ctx.save();
        if (a < 1) ctx.globalAlpha = a;
        // 그림자 — 매스가 지면에서 떠 보이게 한다
        if (o.shadow) {
          ctx.shadowColor = o.shadow.color;
          ctx.shadowBlur = o.shadow.blur;
          ctx.shadowOffsetX = o.shadow.dx;
          ctx.shadowOffsetY = o.shadow.dy;
        }
      }
      switch (o.t) {
        case "clipStart": {
          ctx.save();
          ctx.beginPath();
          for (const r of o.rings || []) {
            if (!r || r.length < 3) continue;
            ctx.moveTo(r[0][0], r[0][1]);
            for (let i = 1; i < r.length; i++) ctx.lineTo(r[i][0], r[i][1]);
            ctx.closePath();
          }
          ctx.clip(o.fillRule || "evenodd");
          break;
        }
        case "clipEnd":
          ctx.restore();
          break;
        case "shadow": {
          // 그림자는 건물보다 먼저 합성한다. 연속 투영 그림자는 빠른 불투명 마스크,
          // 예전 형식의 단순 이동 그림자는 기존 벡터 경로로 처리한다.
          paintShadowCanvas(ctx, o);
          break;
        }
        case "roadField": {
          paintRoadFieldCanvas(ctx, o);
          break;
        }
        case "poly":
        case "path": {
          // rings 가 있으면 여러 고리를 한 도형으로 — 안쪽 고리가 구멍이 된다
          const rs = o.rings || (o.pts ? [o.pts] : null);
          if (!rs || !rs[0] || rs[0].length < 2) break;
          ctx.beginPath();
          for (const r of rs) {
            if (r.length < 2) continue;
            ctx.moveTo(r[0][0], r[0][1]);
            for (let i = 1; i < r.length; i++) ctx.lineTo(r[i][0], r[i][1]);
            if (o.t === "poly" && o.close !== false) ctx.closePath();
          }
          // evenodd 는 안쪽 고리를 구멍으로 뚫는다. nonzero 는 겹쳐도 꽉 채운다 —
          // 필지를 그대로 겹쳐 덩어리를 만들 때 쓴다.
          if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(o.fillRule || "evenodd"); }
          if (o.stroke && o.w > 0) {
            if (o.strokeGradient) {
              const g = o.strokeGradient;
              const gradient = ctx.createLinearGradient(g.x1, g.y1, g.x2, g.y2);
              gradient.addColorStop(0, g.c1);
              gradient.addColorStop(1, g.c2);
              ctx.strokeStyle = gradient;
            } else ctx.strokeStyle = o.stroke;
            ctx.lineWidth = o.w;
            // 선 종류. 굵기에 비례해야 확대해도 같은 모양으로 보인다.
            if (o.dash && o.dash.length) ctx.setLineDash(o.dash.map(v => v * o.w));
            ctx.stroke();
            if (o.dash && o.dash.length) ctx.setLineDash([]);
          }
          break;
        }
        case "image":
          if (o.img) ctx.drawImage(o.img, o.x, o.y, o.w, o.h);
          break;
        case "vignette": {
          // 가운데는 비우고 바깥으로 갈수록 짙어진다. 사각형은 네 변에서 스며든다.
          ctx.save();
          if (o.shape === "rect") {
            const g = (x0, y0, x1, y1) => {
              const gr = ctx.createLinearGradient(x0, y0, x1, y1);
              gr.addColorStop(0, DRAW._rgba(o.color, o.op));
              gr.addColorStop(1, DRAW._rgba(o.color, 0));
              return gr;
            };
            const mx = o.rx * (1 - o.feather), my = o.ry * (1 - o.feather);
            const l = o.cx - o.rx, r = o.cx + o.rx, t = o.cy - o.ry, b = o.cy + o.ry;
            ctx.fillStyle = DRAW._rgba(o.color, o.op);
            ctx.fillRect(0, 0, o.w, Math.max(0, t));
            ctx.fillRect(0, b, o.w, Math.max(0, o.h - b));
            ctx.fillRect(0, t, Math.max(0, l), Math.max(0, b - t));
            ctx.fillRect(r, t, Math.max(0, o.w - r), Math.max(0, b - t));
            ctx.fillStyle = g(l, 0, l + (o.rx - mx), 0); ctx.fillRect(l, t, o.rx - mx, b - t);
            ctx.fillStyle = g(r, 0, r - (o.rx - mx), 0); ctx.fillRect(r - (o.rx - mx), t, o.rx - mx, b - t);
            ctx.fillStyle = g(0, t, 0, t + (o.ry - my)); ctx.fillRect(l, t, r - l, o.ry - my);
            ctx.fillStyle = g(0, b, 0, b - (o.ry - my)); ctx.fillRect(l, b - (o.ry - my), r - l, o.ry - my);
          } else {
            const R = Math.max(o.rx, o.ry, 1);
            ctx.translate(o.cx, o.cy);
            ctx.scale(o.rx / R, o.ry / R);
            const gr = ctx.createRadialGradient(0, 0, R * (1 - o.feather), 0, 0, R * VIG_SPREAD);
            gr.addColorStop(0, DRAW._rgba(o.color, 0));
            gr.addColorStop(1, DRAW._rgba(o.color, o.op));
            ctx.fillStyle = gr;
            // 현재 변환에는 화면 DPR뿐 아니라 내보내기 크롭의 -crop.x/-crop.y 이동도
            // 들어 있다. 여기서 단위 행렬로 초기화하면 비네트만 원래 화면 좌표에
            // 남아 CONTEXT 크롭에서 오른쪽·아래로 밀린다. 위에서 적용한 변환을
            // 그대로 사용해야 화면·PNG·SVG의 중심이 정확히 일치한다.
            ctx.fillRect(-o.w / (o.rx / R), -o.h / (o.ry / R),
                         o.w * 2 / (o.rx / R), o.h * 2 / (o.ry / R));
          }
          ctx.restore();
          break;
        }
        case "noise": {
          addNoiseCanvas(ctx, o);
          break;
        }
        case "hatch": {
          const rings = o.rings || [];
          for (let at = 0; at < rings.length; at += HATCH_RING_CHUNK)
            paintCanvasHatch(ctx, {...o, rings:rings.slice(at, at + HATCH_RING_CHUNK)});
          break;
        }
        case "dot":
          ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
          if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
          if (o.stroke && o.w > 0) {
            ctx.strokeStyle = o.stroke; ctx.lineWidth = o.w; ctx.stroke();
          }
          break;
        case "text":
          ctx.font = `${o.weight || 600} ${o.size || 10}px system-ui`;
          ctx.textAlign = o.anchor || "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = o.fill;
          ctx.fillText(o.s, o.x, o.y);
          break;
      }
      if (dim) ctx.restore();
    }
  },

  /** 같은 목록을 SVG 문자열로. 일러스트레이터에서 선 굵기를 바로 만질 수 있다.
   *  crop 을 주면 viewBox 로 그만큼만 잘라 낸다. */
  toSVG(ops, w, h, bg, crop) {
    const n = v => {
      const value = Number(v);
      return Number.isFinite(value) ? (Math.round(value * 100) / 100) : 0;
    };
    const esc = DRAW.esc;
    // Illustrator is still most reliable with SVG 1.1 paint values. In
    // particular it can reject CSS rgba() in presentation attributes, so keep
    // the colour and alpha in separate SVG attributes.
    const paint = value => {
      const raw = String(value ?? "none").trim();
      const rgba = raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+)\s*)?\)$/i);
      if (rgba) {
        const rgb = rgba.slice(1, 4).map(v => Math.max(0, Math.min(255, Math.round(Number(v) || 0))));
        const alpha = rgba[4] == null ? 1 : Math.max(0, Math.min(1, Number(rgba[4]) || 0));
        return { color: `#${rgb.map(v => v.toString(16).padStart(2, "0")).join("")}`, alpha };
      }
      const hex = raw.match(/^#([\da-f]{4}|[\da-f]{8})$/i);
      if (hex) {
        const long = hex[1].length === 4
          ? hex[1].split("").map(v => v + v).join("")
          : hex[1];
        return { color: `#${long.slice(0, 6)}`, alpha: parseInt(long.slice(6), 16) / 255 };
      }
      return { color: raw || "none", alpha: 1 };
    };
    const paintAttrs = (name, value, extraAlpha = 1) => {
      const p = paint(value);
      const alpha = Math.max(0, Math.min(1, p.alpha * extraAlpha));
      // SVG 그라데이션 스톱의 투명도 속성은 stop-color-opacity가 아니라
      // stop-opacity다. 브라우저는 잘못된 속성을 너그럽게 보기도 하지만
      // Illustrator는 무시해 비네트를 불투명한 검정 면으로 열 수 있다.
      const opacityName=name==="stop-color"?"stop-opacity":`${name}-opacity`;
      return ` ${name}="${esc(p.color)}"` +
        (alpha < 1 ? ` ${opacityName}="${n(alpha)}"` : "");
    };
    const c = crop || { x: 0, y: 0, w, h };
    const out = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" ` +
      `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
      `stroke-linejoin="round" stroke-linecap="round" ` +
      `width="${n(c.w)}pt" height="${n(c.h)}pt" ` +
      `viewBox="0 0 ${n(c.w)} ${n(c.h)}">`,
    ];
    // bg 가 없으면 배경을 깔지 않는다 — 일러스트레이터에서 투명하게 열린다
    if (bg)
      out.push(`<g id="SVG_Background" data-name="바탕" inkscape:groupmode="layer" inkscape:label="바탕">`+
        `<rect x="0" y="0" width="${n(c.w)}" height="${n(c.h)}"${paintAttrs("fill", bg)}/></g>`);
    // 그림자·비네트는 SVG 정의로 먼저 만들어 두고 참조한다
    const defs = [];
    const layerClips = new Map();
    let layerClipN = 0;
    for (const o of ops) {
      if (o.t !== "clipStart" || !(o.rings || []).length) continue;
      const id = `layerClip${layerClipN++}`;
      const d = o.rings.map(r => r.map((p, i) =>
        `${i ? "L" : "M"}${n(p[0])} ${n(p[1])}`).join("") + "Z").join("");
      defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse">` +
        `<path d="${d}" clip-rule="${o.fillRule || "evenodd"}"/></clipPath>`);
      layerClips.set(o.layer ?? "기타", id);
    }
    const strokeGradients = new Map();
    let strokeGradientN = 0;
    for (const o of ops) {
      if (!o.strokeGradient) continue;
      const g = o.strokeGradient, id = `strokeGradient${strokeGradientN++}`;
      strokeGradients.set(o, id);
      defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
        `x1="${n(g.x1)}" y1="${n(g.y1)}" x2="${n(g.x2)}" y2="${n(g.y2)}">` +
        `<stop offset="0%"${paintAttrs("stop-color", g.c1)}/>` +
        `<stop offset="100%"${paintAttrs("stop-color", g.c2)}/></linearGradient>`
      );
    }
    const sh = ops.find(o => o.shadow);
    if (sh) {
      const shadowPaint = paint(sh.shadow.color);
      defs.push(
        `<filter id="sh" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">` +
        `<feGaussianBlur in="SourceAlpha" stdDeviation="${n(sh.shadow.blur / 2)}" result="blur"/>` +
        `<feOffset in="blur" dx="${n(sh.shadow.dx)}" dy="${n(sh.shadow.dy)}" result="offsetBlur"/>` +
        `<feFlood flood-color="${esc(shadowPaint.color)}" flood-opacity="${n(shadowPaint.alpha)}" result="shadowColor"/>` +
        `<feComposite in="shadowColor" in2="offsetBlur" operator="in" result="shadow"/>` +
        `<feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`);
    }
    const shadowFilters = new Map();
    ops.filter(o => o.t === "shadow").forEach((o, i) => {
      const blur = Math.max(0, +o.blur || 0);
      if (blur <= 0) return;
      const id = `buildingShadow${i}`;
      shadowFilters.set(o, id);
      defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" ` +
        `color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${n(blur / 2)}"/></filter>`);
    });
    ops.filter(o => o.t === "vignette").forEach((o, i) => {
      if(o.shape==="rect"){
        const l=o.cx-o.rx,r=o.cx+o.rx,t=o.cy-o.ry,b=o.cy+o.ry;
        const fx=Math.max(0,o.rx*o.feather),fy=Math.max(0,o.ry*o.feather);
        const linear=(suffix,x1,y1,x2,y2,reverse=false)=>
          `<linearGradient id="vig${i}${suffix}" gradientUnits="userSpaceOnUse" `+
          `x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}">`+
          `<stop offset="0%"${paintAttrs("stop-color",o.color,reverse?0:o.op)}/>`+
          `<stop offset="100%"${paintAttrs("stop-color",o.color,reverse?o.op:0)}/></linearGradient>`;
        if(fx>0){defs.push(linear("L",l,0,l+fx,0),linear("R",r-fx,0,r,0,true));}
        if(fy>0){defs.push(linear("T",0,t,0,t+fy),linear("B",0,b-fy,0,b,true));}
      }else{
        const R=Math.max(o.rx,o.ry,1),sx=o.rx/R,sy=o.ry/R;
        defs.push(
          `<radialGradient id="vig${i}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${n(R*VIG_SPREAD)}" `+
          `gradientTransform="translate(${n(o.cx)} ${n(o.cy)}) scale(${n(sx)} ${n(sy)})">`+
          `<stop offset="${n((1-o.feather)*100/VIG_SPREAD)}%"${paintAttrs("stop-color",o.color,0)}/>`+
          `<stop offset="100%"${paintAttrs("stop-color",o.color,o.op)}/></radialGradient>`);
      }
    });
    const noiseFilters = new Map();
    ops.filter(o => o.t === "noise").forEach((o, i) => {
      const id = `photoshopNoise${i}`;
      const type = o.distribution === "gaussian" ? "fractalNoise" : "turbulence";
      const mono = o.monochromatic === false ? "" :
        `<feColorMatrix type="saturate" values="0"/>`;
      defs.push(`<filter id="${id}" x="0" y="0" width="100%" height="100%" ` +
        `color-interpolation-filters="sRGB"><feTurbulence type="${type}" baseFrequency="0.85" ` +
        `numOctaves="${type === "fractalNoise" ? 3 : 1}" seed="${Math.abs((+o.seed || 2701) | 0)}" ` +
        `stitchTiles="stitch"/>${mono}</filter>`);
      noiseFilters.set(o, id);
    });
    const hatchPatterns = new Map();
    ops.filter(o => o.t === "hatch").forEach((o, i) => {
      const id = `hatch${i}`;
      const spacing = Math.max(.1, Math.min(160, +o.spacing || 8));
      const width = Math.max(.01, Math.min(12, +o.w || .5));
      const color = o.color || "#555555", kind = o.pattern || "diag";
      let body = "", transform = "";
      if (kind === "dots") {
        body = `<circle cx="${n(spacing / 2)}" cy="${n(spacing / 2)}" ` +
          `r="${n(Math.max(.02, width * 1.35))}"${paintAttrs("fill", color)}/>`;
      } else {
        const lines = kind === "vertical" ? `M0 0V${n(spacing)}`
          : kind === "cross" ? `M0 0H${n(spacing)}M0 0V${n(spacing)}`
          : `M0 0H${n(spacing)}`;
        const angle = kind === "diag" || kind === "cross" ? 45 : 0;
        transform = angle ? ` patternTransform="rotate(${angle})"` : "";
        body = `<path d="${lines}" fill="none"${paintAttrs("stroke", color)} ` +
          `stroke-width="${n(width)}"/>`;
      }
      defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(spacing)}" ` +
        `height="${n(spacing)}"${transform}>${body}</pattern>`);
      hatchPatterns.set(o, id);
    });
    if (defs.length) out.push(`<defs>${defs.join("")}</defs>`);

    let vigN = -1;

    // op 에 붙은 레이어 이름으로 묶는다. 같은 이름이 중간에 다시 나타나더라도
    // Illustrator 레이어 하나만 생기도록 먼저 모은다. 레이어의 첫 등장 순서와
    // 각 레이어 내부의 그리기 순서는 그대로 유지한다.
    let group = null;
    const groupIds = new Map();
    const uniqueGroupId = name => {
      let base = String(name ?? "layer").normalize("NFC")
        .replace(/[^A-Za-z0-9_.\-\u00c0-\uffff]+/g, "_");
      if (!/^[A-Za-z_\u00c0-\uffff]/.test(base)) base = `layer_${base}`;
      const count = (groupIds.get(base) || 0) + 1;
      groupIds.set(base, count);
      return count === 1 ? base : `${base}_${count}`;
    };
    const openGroup = name => {
      if (name === group) return;
      if (group !== null) out.push("</g>");
      group = name;
      if (group !== null) {
        const label = esc(group);
        // SVG 원점은 항상 0,0으로 정규화하고 각 최상위 레이어를 같은 만큼 옮긴다.
        // 비영점 viewBox를 Illustrator가 그라데이션과 다르게 해석하는 문제를 피한다.
        const shift=(c.x||c.y)?` transform="translate(${n(-c.x)} ${n(-c.y)})"`:"";
        const clipId=layerClips.get(group),clip=clipId?` clip-path="url(#${clipId})"`:"";
        out.push(`<g id="${esc(uniqueGroupId(group))}" data-name="${label}" ` +
          `inkscape:groupmode="layer" inkscape:label="${label}"${shift}${clip}>`);
      }
    };

    const layerBins=new Map();
    for(const o of ops){
      const name=o.layer??"기타";
      if(!layerBins.has(name))layerBins.set(name,[]);
      layerBins.get(name).push(o);
    }
    for(const [layerName,layerOps] of layerBins){
      openGroup(layerName);
      for (const o of layerOps) {
      const a = o.opacity ?? 1;
      if (a <= 0) continue;
      const op = a < 1 ? ` opacity="${Math.round(a * 1000) / 1000}"` : "";
      if (o.t === "vignette") {
        vigN++;
        if (o.shape === "rect") {
          // 사각형도 네 변에 실제 선형 그라데이션을 둔다. 단색 compound path는
          // Illustrator에서 구멍이 무시되어 검정 박스로 열리는 경우가 있었다.
          const l=o.cx-o.rx,r=o.cx+o.rx,t=o.cy-o.ry,b=o.cy+o.ry;
          const fx=Math.max(0,o.rx*o.feather),fy=Math.max(0,o.ry*o.feather);
          const rect=(x,y,w0,h0,fill)=>{
            const attrs=String(fill).startsWith("url(")?` fill="${fill}"`:paintAttrs("fill",o.color,o.op);
            if(w0>0&&h0>0)out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w0)}" height="${n(h0)}"${attrs}/>`);
          };
          const x0=c.x,y0=c.y,x1=c.x+c.w,y1=c.y+c.h;
          rect(x0,y0,c.w,Math.max(0,t-y0),"solid");
          rect(x0,Math.max(b,y0),c.w,Math.max(0,y1-Math.max(b,y0)),"solid");
          rect(x0,t,Math.max(0,l-x0),Math.max(0,b-t),"solid");
          rect(Math.max(r,x0),t,Math.max(0,x1-Math.max(r,x0)),Math.max(0,b-t),"solid");
          if(fx>0){rect(l,t,fx,b-t,`url(#vig${vigN}L)`);rect(r-fx,t,fx,b-t,`url(#vig${vigN}R)`);}
          if(fy>0){rect(l,t,r-l,fy,`url(#vig${vigN}T)`);rect(l,b-fy,r-l,fy,`url(#vig${vigN}B)`);}
        } else {
          out.push(`<rect x="${n(c.x)}" y="${n(c.y)}" width="${n(c.w)}" height="${n(c.h)}" ` +
                   `fill="url(#vig${vigN})"/>`);
        }
      } else if (o.t === "shadow") {
        const rings = o.rings || [];
        if (!rings.length) continue;
        const d = rings.map(r => r.map((p, i) =>
          `${i ? "L" : "M"}${n(p[0])} ${n(p[1])}`).join("") + "Z").join("");
        const filterId = shadowFilters.get(o);
        const fx = filterId ? ` filter="url(#${filterId})"` : "";
        const transform = (+o.dx || +o.dy)
          ? ` transform="translate(${n(+o.dx || 0)} ${n(+o.dy || 0)})"` : "";
        out.push(`<path d="${d}"${paintAttrs("fill", o.fill || "rgba(0,0,0,.3)")} ` +
          `fill-rule="${o.fillRule || "nonzero"}"${transform}${fx}${op}/>`);
      } else if (o.t === "roadField") {
        if (!(o.segments || []).length) continue;
        const image = roadFieldImage(o, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)),
          {a:1,b:0,c:0,d:1,e:0,f:0});
        const href = image.toDataURL("image/png");
        out.push(`<image xlink:href="${esc(href)}" x="0" y="0" width="${n(w)}" height="${n(h)}" ` +
          `data-road-field="gaussian"${op} preserveAspectRatio="none"/>`);
      } else if (o.t === "poly" || o.t === "path") {
        const rs = o.rings || (o.pts ? [o.pts] : null);
        if (!rs || !rs[0] || rs[0].length < 2) continue;
        const d = rs.map(r => r.map((p, i) => `${i ? "L" : "M"}${n(p[0])} ${n(p[1])}`).join("")
                + (o.t === "poly" && o.close !== false ? "Z" : "")).join("");
        const f = paintAttrs("fill", o.fill || "none");
        // SVG 로 내보낼 때도 같은 선 종류가 나와야 한다
        const da = (o.dash && o.dash.length)
          ? ` stroke-dasharray="${o.dash.map(v => n(v * o.w)).join(" ")}"` : "";
        const gradientId = strokeGradients.get(o);
        const strokeAttrs = gradientId
          ? ` stroke="url(#${gradientId})"`
          : paintAttrs("stroke", o.stroke);
        const st = (o.stroke && o.w > 0)
          ? `${strokeAttrs} stroke-width="${n(o.w)}"${da}` : "";
        const fx = o.shadow ? ` filter="url(#sh)"` : "";
        const fr = o.rings && o.rings.length > 1
          ? ` fill-rule="${o.fillRule || "evenodd"}"` : "";
        out.push(`<path d="${d}"${f}${fr}${st}${fx}${op}/>`);
      } else if (o.t === "noise") {
        const filterId = noiseFilters.get(o);
        if (!filterId) continue;
        const amount = Math.max(0, Math.min(400, +o.amount || 0));
        const effectOpacity = Math.min(1, amount / 50);
        out.push(`<rect x="${n(o.x || 0)}" y="${n(o.y || 0)}" ` +
          `width="${n(o.w || 0)}" height="${n(o.h || 0)}" fill="#808080" ` +
          `filter="url(#${filterId})" opacity="${n(effectOpacity)}" style="mix-blend-mode:soft-light"/>`);
      } else if (o.t === "hatch") {
        const patternId = hatchPatterns.get(o), rings = o.rings || [];
        if (!patternId || !rings.length) continue;
        for (let at = 0; at < rings.length; at += HATCH_RING_CHUNK) {
          const d = rings.slice(at, at + HATCH_RING_CHUNK).map(ring => ring.map((point, index) =>
            `${index ? "L" : "M"}${n(point[0])} ${n(point[1])}`).join("") + "Z").join("");
          out.push(`<path d="${d}" fill="url(#${patternId})" ` +
            `fill-rule="${o.fillRule || "evenodd"}"${op}/>`);
        }
      } else if (o.t === "image") {
        if (!o.href) continue;              // data: URL 이어야 파일 하나로 완결된다
        out.push(`<image xlink:href="${esc(o.href)}" x="${n(o.x)}" y="${n(o.y)}" ` +
          `width="${n(o.w)}" height="${n(o.h)}"${op} preserveAspectRatio="none"/>`);
      } else if (o.t === "dot") {
        const st = (o.stroke && o.w > 0)
          ? `${paintAttrs("stroke", o.stroke)} stroke-width="${n(o.w)}"` : "";
        out.push(`<circle cx="${n(o.x)}" cy="${n(o.y)}" r="${n(o.r)}" ` +
                 `${paintAttrs("fill", o.fill || "none").trimStart()}${st}${op}/>`);
      } else if (o.t === "text") {
        const an = { left: "start", center: "middle", right: "end" }[o.anchor || "center"];
        out.push(`<text x="${n(o.x)}" y="${n(o.y)}"${paintAttrs("fill", o.fill)} ` +
          `font-family="system-ui, sans-serif" font-size="${o.size || 10}" ` +
          `font-weight="${o.weight || 600}" text-anchor="${an}" ` +
          `dominant-baseline="middle"${op}>${esc(o.s)}</text>`);
      }
      }
    }
    openGroup(null);                    // 마지막 레이어 닫기
    out.push("</svg>");
    return out.join("\n");
  },

  // ── 내보내기 범위(크롭)
  //
  // crop 은 캔버스 CSS 픽셀 기준 {x,y,w,h}. 없으면 화면 전체.
  // 그리기 목록은 이미 화면 좌표라, 옮겨 그리기만 하면 그대로 잘린다.

  /** 화면에 크롭 틀을 그린다. 바깥은 어둡게 덮어 어디가 나갈지 보이게. */
  cropOverlay(crop, w, h, ink) {
    if (!crop) return [];
    const veil = "rgba(20,22,26,.42)";
    const box = (x, y, ww, hh) => ({ t: "poly", fill: veil,
      pts: [[x, y], [x + ww, y], [x + ww, y + hh], [x, y + hh]] });
    const { x, y, w: cw, h: ch } = crop;
    return [
      box(0, 0, w, y), box(0, y + ch, w, h - y - ch),
      box(0, y, x, ch), box(x + cw, y, w - x - cw, ch),
      { t: "poly", pts: [[x, y], [x + cw, y], [x + cw, y + ch], [x, y + ch]],
        stroke: ink, w: 1.2 },
      { t: "text", x: x + cw / 2, y: y - 10, s: `${Math.round(cw)} × ${Math.round(ch)} px`,
        size: 11, fill: ink },
    ];
  },

  /** 목록을 새 캔버스에 그려 준다. crop 이 있으면 그만큼만, scale 배로. */
  renderToCanvas(ops, view) {
    const { w, h, bg, crop, scale = 1 } = view;
    const c = crop || { x: 0, y: 0, w, h };
    const cv = document.createElement("canvas");
    cv.width = Math.round(c.w * scale);
    cv.height = Math.round(c.h * scale);
    const ctx = cv.getContext("2d");
    // bg 가 없으면 칠하지 않는다 — 투명한 PNG 가 되어 그린 것만 남는다
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height); }
    ctx.setTransform(scale, 0, 0, scale, -c.x * scale, -c.y * scale);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    this.paintCanvas(ctx, ops);
    return cv;
  },

  exportPNG(name, ops, view) {
    this.downloadCanvas(name, this.renderToCanvas(ops, view));
  },

  exportSVG(name, ops, view) {
    const { w, h, bg, crop } = view;
    this.download(name, this.toSVG(ops, w, h, bg, crop), "image/svg+xml;charset=utf-8");
  },

  /** 압축하지 않는 표준 ZIP. SVG와 Illustrator 스크립트를 파일 하나로 묶는 데 쓴다. */
  _storeZip(files) {
    const enc=new TextEncoder(),table=new Uint32Array(256);
    for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
    const crc32=data=>{let c=0xffffffff;for(const b of data)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
    const header=(length)=>{const bytes=new Uint8Array(length);return {bytes,view:new DataView(bytes.buffer)};};
    const now=new Date(),dosTime=(now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1);
    const dosDate=((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
    const body=[],central=[];let offset=0;
    for(const file of files){
      const name=enc.encode(file.name),data=file.data instanceof Uint8Array?file.data:enc.encode(file.data);
      const crc=crc32(data),local=header(30+name.length),v=local.view;
      v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);
      v.setUint16(8,0,true);v.setUint16(10,dosTime,true);v.setUint16(12,dosDate,true);
      v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);
      v.setUint16(26,name.length,true);v.setUint16(28,0,true);local.bytes.set(name,30);
      body.push(local.bytes,data);
      const cd=header(46+name.length),d=cd.view;
      d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);
      d.setUint16(10,0,true);d.setUint16(12,dosTime,true);d.setUint16(14,dosDate,true);
      d.setUint32(16,crc,true);d.setUint32(20,data.length,true);d.setUint32(24,data.length,true);
      d.setUint16(28,name.length,true);d.setUint16(30,0,true);d.setUint16(32,0,true);
      d.setUint16(34,0,true);d.setUint16(36,0,true);d.setUint32(38,0,true);d.setUint32(42,offset,true);
      cd.bytes.set(name,46);central.push(cd.bytes);offset+=local.bytes.length+data.length;
    }
    const centralSize=central.reduce((sum,part)=>sum+part.length,0),end=header(22),e=end.view;
    e.setUint32(0,0x06054b50,true);e.setUint16(4,0,true);e.setUint16(6,0,true);
    e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);
    e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);e.setUint16(20,0,true);
    return new Blob([...body,...central,end.bytes],{type:"application/zip"});
  },

  illustratorPackageBlob(svg) {
    const jsx=`#target illustrator\n(function(){\n`+
      `var previous=app.userInteractionLevel;\n`+
      `try{\napp.userInteractionLevel=UserInteractionLevel.DONTDISPLAYALERTS;\n`+
      `var folder=File($.fileName).parent;var sourceFile=File(folder.fsName+"/artwork.svg");\n`+
      `if(!sourceFile.exists)throw new Error("artwork.svg 파일을 같은 폴더에서 찾지 못했습니다.");\n`+
      `var doc=app.open(sourceFile);var source=doc.layers[0],items=[];\n`+
      `for(var i=0;i<source.pageItems.length;i++){var item=source.pageItems[i];`+
      `if(item.parent===source&&item.typename==="GroupItem")items.push(item);}\n`+
      `if(!items.length)throw new Error("SVG 최상위 레이어 그룹을 찾지 못했습니다.");\n`+
      `for(var j=items.length-1;j>=0;j--){var group=items[j],layer=doc.layers.add();`+
      `layer.name=group.name||("Layer "+(j+1));group.move(layer,ElementPlacement.PLACEATBEGINNING);}\n`+
      `if(source.pageItems.length===0&&doc.layers.length>1)source.remove();\n`+
      `app.activeDocument=doc;alert("실제 Illustrator 레이어 "+items.length+"개로 열었습니다.\\n파일 > 다른 이름으로 저장에서 AI로 저장하세요.");\n`+
      `}catch(error){alert("AI 레이어 가져오기 오류: "+error.message);}`+
      `finally{app.userInteractionLevel=previous;}\n})();\n`;
    const readme=`Illustrator 레이어로 여는 방법\r\n\r\n`+
      `1. 이 ZIP을 폴더에 압축 해제합니다.\r\n`+
      `2. Illustrator에서 파일 > 스크립트 > 기타 스크립트를 선택합니다.\r\n`+
      `3. 같은 폴더의 Illustrator_Layers.jsx를 실행합니다.\r\n`+
      `4. 실제 레이어로 열린 문서를 파일 > 다른 이름으로 저장에서 AI로 저장합니다.\r\n\r\n`+
      `artwork.svg를 직접 열면 Illustrator 특성상 레이어 하나 아래 그룹으로 들어갑니다.\r\n`;
    return this._storeZip([{name:"artwork.svg",data:svg},
      {name:"Illustrator_Layers.jsx",data:jsx},{name:"README.txt",data:readme}]);
  },

  exportIllustratorPackage(name, ops, view) {
    const {w,h,bg,crop}=view,svg=this.toSVG(ops,w,h,bg,crop);
    this.downloadBlob(name,this.illustratorPackageBlob(svg));
  },

  download(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    this.downloadBlob(name,blob);
  },

  downloadBlob(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  },

  downloadCanvas(name, canvas) {
    const a = document.createElement("a");
    a.download = name;
    a.href = canvas.toDataURL("image/png");
    a.click();
  },
};

// ── 공통 색상 팔레트
// 레이어 줄은 다시 렌더될 때 input 자체가 교체되므로 개별 바인딩 대신 문서에서 위임한다.
// 자주 쓰는 도면·대지 톤은 한 번에 고르고, 그 밖의 색은 시스템 컬러피커로 이어 간다.
const DRAW_COLORS = [
  "#ffffff", "#000000", "#f6f5f2", "#ece7dc", "#ded9cc", "#b9b3a7", "#8d8a83", "#5f6268", "#262a31",
  "#ead7c5", "#d7b28d", "#bd865d", "#8d5d40", "#5b3b2d", "#e2564a", "#c0392b", "#8b2e2e",
  "#f0df9a", "#c2a86a", "#a68d5e", "#75633f", "#dbe7d5", "#91aa87", "#5f8063", "#36553f",
  "#dce8ee", "#9db4c1", "#668b9c", "#355f74", "#e3e0eb", "#aaa2c2", "#756d93", "#3c4048",
];

(function bindColorPalette(){
  const storageKey="vworld-custom-colors";
  let customColors=[];
  try{customColors=JSON.parse(localStorage.getItem(storageKey)||"[]")
    .filter(color=>/^#[0-9a-f]{6}$/i.test(color)).map(color=>color.toLowerCase()).slice(0,24);}
  catch{customColors=[];}
  const popup=document.createElement("div");
  popup.className="color-palette-pop";popup.hidden=true;popup.setAttribute("role","dialog");
  popup.setAttribute("aria-label","색상 팔레트");
  popup.innerHTML=`<div class="color-palette-title"><span>색상 팔레트</span>
      <span class="color-palette-value"></span></div>
    <div class="color-palette-swatches"></div>
    <form class="color-palette-add"><input type="text" value="#" maxlength="7" spellcheck="false"
      aria-label="팔레트에 추가할 HEX 색상" placeholder="#000000"><button type="submit">팔레트에 추가</button></form>
    <button type="button" class="color-palette-native">사용자 지정…</button>`;
  document.body.appendChild(popup);

  let target=null;
  const nativeRequest=new WeakSet();
  const value=popup.querySelector(".color-palette-value");
  const swatches=popup.querySelector(".color-palette-swatches");
  const renderSwatches=()=>{
    swatches.innerHTML=[...new Set([...DRAW_COLORS,...customColors])].map(color=>
      `<button type="button" class="color-palette-swatch" data-color="${color}"
        style="--swatch:${color}" title="${color}" aria-label="${color}"></button>`).join("");
  };
  renderSwatches();
  const hide=()=>{popup.hidden=true;target=null;};
  const update=()=>{
    if(!target)return;
    const current=target.value.toLowerCase();value.textContent=current;
    popup.querySelectorAll("[data-color]").forEach(button=>
      button.classList.toggle("on",button.dataset.color===current));
  };
  const show=input=>{
    target=input;popup.hidden=false;update();
    const r=input.getBoundingClientRect(),pad=8;
    const width=popup.offsetWidth,height=popup.offsetHeight;
    let left=Math.min(r.left,window.innerWidth-width-pad);
    let top=r.bottom+6;
    if(top+height>window.innerHeight-pad)top=r.top-height-6;
    popup.style.left=Math.max(pad,left)+"px";
    popup.style.top=Math.max(pad,top)+"px";
  };
  const apply=color=>{
    if(!target)return;
    const input=target;input.value=color;
    input.dispatchEvent(new Event("input",{bubbles:true}));
    input.dispatchEvent(new Event("change",{bubbles:true}));
    hide();input.focus();
  };

  swatches.addEventListener("click",event=>{
    const button=event.target.closest("[data-color]");if(button)apply(button.dataset.color);
  });
  popup.querySelector(".color-palette-add").addEventListener("submit",event=>{
    event.preventDefault();const input=event.currentTarget.querySelector("input");
    let color=input.value.trim().toLowerCase();
    if(/^#[0-9a-f]{3}$/i.test(color))color="#"+[...color.slice(1)].map(c=>c+c).join("");
    if(!/^#[0-9a-f]{6}$/i.test(color)){input.setCustomValidity("#RRGGBB 형식으로 입력하세요.");input.reportValidity();return;}
    input.setCustomValidity("");
    customColors=[color,...customColors.filter(item=>item!==color)].slice(0,24);
    try{localStorage.setItem(storageKey,JSON.stringify(customColors));}catch{}
    renderSwatches();apply(color);
  });
  popup.querySelector(".color-palette-native").addEventListener("click",()=>{
    if(!target)return;
    const input=target;hide();
    try{if(typeof input.showPicker==="function"){input.showPicker();return;}}catch{}
    nativeRequest.add(input);input.click();
  });
  document.addEventListener("click",event=>{
    const input=event.target.closest?.('input[type="color"]');
    if(input){
      if(nativeRequest.has(input)){nativeRequest.delete(input);return;}
      event.preventDefault();show(input);return;
    }
    if(!popup.hidden&&!popup.contains(event.target))hide();
  },true);
  document.addEventListener("keydown",event=>{
    if(event.key==="Escape"&&!popup.hidden){event.preventDefault();hide();}
  });
  window.addEventListener("resize",hide);
  window.addEventListener("scroll",hide,true);
})();
