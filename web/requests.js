/* 요청별 인증 헤더와 2D·3D 위성사진의 비동기 수명 관리. */
function withAPIKeys(fetcher, origin, getKeys) {
  return (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input, origin);
    if (url.origin !== origin) return fetcher(input, options);
    const headers = new Headers(options.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of Object.entries(getKeys())) headers.set(name, value);
    return fetcher(input, {...options, headers});
  };
}

function createAerialLoader(opt) {
  const A = opt.state;
  let running = null;
  function snapshot() {
    const scene = opt.scene(), layer = opt.layer();
    if (!scene || !opt.enabled()) return null;
    const key = JSON.stringify([scene.name, scene.radius, scene.origin, scene._fingerprint,
      !!layer.gray, !!layer.base]);
    return {scene, key, gray: !!layer.gray, base: !!layer.base};
  }
  const current = task => {
    const next = snapshot();
    return next?.scene === task.scene && next.key === task.key;
  };
  function clear() { A.key = ""; opt.clear(); }

  async function drain() {
    // 서버 수집은 순서대로 마치고, 그동안 선택이 바뀌면 최신 범위를 이어서 받는다.
    while (true) {
      const task = snapshot();
      if (!task) { clear(); opt.changed(); return; }
      if (A.key === task.key && opt.hasImage()) { opt.apply(); return; }
      clear();
      const jobId = newAerialJobId();
      A.loading = true; A.progress = 0; A.phase = "위성사진 준비 중"; A.jobId = jobId;
      opt.changed();
      const stop = watchAerialProgress(jobId, job => {
        if (!current(task)) return;
        A.progress = +(job.progress || 0); A.phase = job.phase || "위성사진 받는 중";
        opt.changed();
      });
      try {
        const query = new URLSearchParams({radius: task.scene.radius, size: 1400,
          layer: task.base ? "base" : "satellite", gray: task.gray, job_id: jobId});
        const response = await fetch(DRAW.siteURL(task.scene.name, "/aerial", String(query)));
        stop();
        if (current(task)) acceptVWorldKeyFallback(response);
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.detail || "위성사진을 가져오지 못했습니다.");
        }
        if (current(task)) {
          A.progress = 98; A.phase = "위성사진을 화면에 올리는 중"; opt.changed();
        }
        const blob = await response.blob();
        if (current(task)) {
          const href = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error("위성사진을 읽지 못했습니다."));
            reader.onabort = () => reject(new Error("위성사진 읽기가 취소되었습니다."));
            reader.readAsDataURL(blob);
          });
          const image = new Image();
          await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error("위성사진 형식이 올바르지 않습니다."));
            image.src = href;
          });
          if (current(task)) {
            A.radius = +response.headers.get("X-Aerial-Radius") || task.scene.radius;
            opt.accept(image); A.key = task.key;
            A.progress = 100; A.phase = "위성사진 준비 완료"; opt.apply();
          }
        }
      } catch (error) {
        if (current(task)) { clear(); opt.failed(error); }
      } finally {
        stop(); A.loading = false; A.jobId = ""; opt.changed();
      }
      const next = snapshot();
      if (!next || (next.scene === task.scene && next.key === task.key)) return;
    }
  }

  return function load() {
    const task = snapshot();
    if (!task || task.key !== A.key) { clear(); opt.changed(); }
    if (!running) running = Promise.resolve().then(drain).finally(() => { running = null; });
    return running;
  };
}
