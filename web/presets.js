/* 프리셋 — 잡아 놓은 것을 다섯 칸에 담고, 파일로 주고받는다.
 *
 * 사이트 분석·2D 도판·3D 세 군데가 같은 일을 한다. 예전에는 같은 코드를
 * 세 벌 적어 두었고, 그러다 한쪽만 고쳐지는 일이 실제로 있었다.
 * 다른 것은 「무엇을 담고 어떻게 되돌리는가」뿐이라 그 둘만 넘겨받는다.
 *
 *   makePresets({
 *     kind,      // 서버에 저장될 갈래: site | plan2d | diagram3d
 *     chipsId,   // 번호칸 요소 id (제목 옆에 있는 것)
 *     prefix,    // 단추 이름 앞머리. <prefix>-save, <prefix>-export, <prefix>-file
 *     fileKind,  // 주고받는 파일 안에 적히는 이름
 *     fileName,  // 내보낼 파일 이름을 짓는 함수 (담긴 칸 수를 받는다)
 *     capture,   // () => 담을 것
 *     apply,     // (state, slot) => 되돌리기. async 여도 된다
 *     label,     // (state) => 한 줄 설명
 *     say,       // (글) => 화면에 알리기 (없으면 무시)
 *   })
 *
 * 서버에 담는다. 브라우저 저장소는 엣지가 막을 수 있고, 터널로 폰에서
 * 들어와도 같은 프리셋이 보여야 하기 때문이다.
 */

const PRESET_SLOTS = 5;

function makePresets(opt) {
  const $ = s => document.querySelector(s);
  const chips = () => $("#" + opt.chipsId);      // 번호칸 (제목 옆)
  const slots = () => $("#" + opt.prefix + "-slots");
  const say = t => { if (opt.say) opt.say(t); };
  const api = n => `/api/presets${n ? "/" + n : ""}?kind=${opt.kind}`;

  let list = [];

  const empty = () =>
    Array.from({ length: PRESET_SLOTS }, (_, i) => ({ n: i + 1, label: "", state: null }));

  async function load() {
    try {
      const r = await fetch(api());
      if (!r.ok) throw new Error("프리셋 목록을 불러오지 못했습니다.");
      list = (await r.json()).slots || empty();
    } catch (e) {
      if (!list.length) list = empty();
      say("!! 프리셋 목록을 불러오지 못했습니다: " + (e.message || e));
    }
    renderChips();
    return list;
  }

  function renderChips() {
    const box = chips();
    if (!box) return;
    box.innerHTML = list.map(s => {
      const has = !!s.state;
      const tip = has ? `${s.label}\n${s.saved_at || ""} — 눌러서 되돌리기` : "비어 있음";
      return `<button type="button" data-n="${s.n}" class="${has ? "has" : ""}"
                title="${DRAW.esc(tip)}">${s.n}</button>`;
    }).join("");
    box.querySelectorAll("button").forEach(b => b.onclick = () => {
      const s = list.find(x => x.n === +b.dataset.n);
      if (s && s.state) restore(s);
    });
  }

  async function restore(slot) {
    try {
      await opt.apply(structuredClone(slot.state || {}), slot);
      chips()?.querySelectorAll("button")
        .forEach(b => b.classList.toggle("on", +b.dataset.n === slot.n));
      say(`프리셋 ${slot.n} 되돌렸습니다 — ${slot.label}`);
    } catch (e) {
      say("!! 프리셋을 되돌리지 못했습니다: " + (e.message || e));
    }
  }

  async function save(n) {
    const state = opt.capture();
    const label = opt.label(state);
    try {
      const r = await fetch(api(n), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, state }),
      });
      if (!r.ok) throw new Error(r.statusText);
      if (slots()) slots().style.display = "none";
      await load();
      say(`프리셋 ${n} 에 담았습니다 — ${label}`);
    } catch (e) {
      say("!! 프리셋을 담지 못했습니다: " + (e.message || e));
    }
  }

  async function remove(n) {
    const slot = list.find(s => s.n === n);
    if (!slot || !slot.state) return;
    const detail = slot.label ? `\n${slot.label}` : "";
    if (!confirm(`프리셋 ${n}을 삭제할까요?${detail}`)) return;
    try {
      const r = await fetch(api(n), { method: "DELETE" });
      if (!r.ok) throw new Error(r.statusText);
      if (slots()) slots().style.display = "none";
      await load();
      say(`프리셋 ${n}을 삭제했습니다.`);
    } catch (e) {
      say("!! 프리셋을 삭제하지 못했습니다: " + (e.message || e));
    }
  }

  /** 어느 칸에 담을지 고르기. 덮어쓰기 전에 무엇이 들었는지 보인다. */
  function picker() {
    const box = slots();
    if (!box) return;
    box.innerHTML = `<div>어느 칸에 담을까요 — 이미 든 칸을 고르면 덮어씁니다.</div>
      <div class="ps-pick">` + list.map(s =>
        `<button type="button" data-n="${s.n}"><b>${s.n}</b>
          <span>${s.state ? "사용 중" : "빈 칸"}</span></button>`).join("") + `</div>`;
    box.style.display = "block";
    box.querySelectorAll("button").forEach(b => b.onclick = () => save(+b.dataset.n));
  }

  /** 비어 있지 않은 칸 가운데 삭제할 프리셋을 고른다. */
  function deletePicker() {
    const box = slots();
    if (!box) return;
    if (!list.some(s => s.state)) {
      box.style.display = "none";
      say("삭제할 프리셋이 없습니다.");
      return;
    }
    box.innerHTML = `<div>삭제할 프리셋을 고르세요.</div>
      <div class="ps-pick">` + list.map(s =>
        `<button type="button" data-n="${s.n}"${s.state ? "" : " disabled"}><b>${s.n}</b>
          <span>${s.state ? "삭제" : "빈 칸"}</span></button>`).join("") + `</div>`;
    box.style.display = "block";
    box.querySelectorAll("button:not(:disabled)")
      .forEach(b => b.onclick = () => remove(+b.dataset.n));
  }

  function exportFile() {
    const filled = list.filter(s => s.state);
    if (!filled.length) return alert("담아 둔 프리셋이 없습니다.");
    const doc = {
      kind: opt.fileKind, version: 1,
      made: new Date().toISOString().slice(0, 16).replace("T", " "),
      slots: filled.map(s => ({ n: s.n, label: s.label, state: s.state })),
    };
    DRAW.download(opt.fileName(filled.length), JSON.stringify(doc, null, 1),
                  "application/json");
    say(`프리셋 ${filled.length}개를 파일로 내보냈습니다.`);
  }

  async function importFile(file) {
    let doc;
    try { doc = JSON.parse(await file.text()); }
    catch (e) { return alert("프리셋 파일이 아닙니다 — 읽지 못했습니다."); }
    if (doc.kind !== opt.fileKind || !Array.isArray(doc.slots))
      return alert("이 자리에 맞는 프리셋 파일이 아닙니다.");

    // 담긴 칸을 덮어쓰기 전에 물어본다. 남의 것으로 내 것을 지우면 되돌릴 수 없다.
    const clash = doc.slots
      .filter(s => (list.find(x => x.n === s.n) || {}).state).map(s => s.n);
    if (clash.length && !confirm(`${clash.join(", ")}번 칸에 이미 담긴 것이 있습니다. 덮어쓸까요?`))
      return;

    let ok = 0;
    for (const s of doc.slots) {
      if (!(1 <= s.n && s.n <= PRESET_SLOTS)) continue;
      try {
        const r = await fetch(api(s.n), {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: s.label || opt.label(s.state || {}), state: s.state }),
        });
        if (r.ok) ok++;
      } catch (e) { /* 한 칸이 실패해도 나머지는 담는다 */ }
    }
    await load();
    say(`프리셋 ${ok}개를 가져왔습니다.`);
    if (opt.afterImport) opt.afterImport(doc);
  }

  /** 담기·주고받기 단추를 붙인다. 이름 규칙만 지키면 알아서 찾는다. */
  function bind() {
    const on = (suffix, fn) => { const el = $("#" + opt.prefix + suffix); if (el) el.onclick = fn; };
    on("-save", picker);
    on("-delete", deletePicker);
    on("-export", exportFile);
    on("-import", () => { const f = $("#" + opt.prefix + "-file"); if (f) f.click(); });
    const file = $("#" + opt.prefix + "-file");
    if (file) file.onchange = e => {
      const f = e.target.files[0];
      if (f) importFile(f);
      e.target.value = "";            // 같은 파일을 다시 골라도 열리게
    };
    load();
  }

  return { load, save, remove, picker, deletePicker, exportFile, importFile, bind,
           get slots() { return list; } };
}
