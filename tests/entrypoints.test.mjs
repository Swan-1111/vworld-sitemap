import assert from "node:assert/strict";
import {readFileSync, existsSync} from "node:fs";
import {test} from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
test("HTML의 인라인 스크립트와 로컬 진입 스크립트가 유효하다", () => {
  let inline = 0;
  const chunks = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const src = /\bsrc="([^"?]+)(?:[^"]*)"/.exec(match[1])?.[1];
    if (src?.startsWith("/") && !src.startsWith("//")) {
      const path = new URL("../web" + src, import.meta.url);
      assert.ok(existsSync(path), src);
      const source = readFileSync(path, "utf8");
      new vm.Script(source, {filename: src}); chunks.push(source);
    } else if (!src) { new vm.Script(match[2]); chunks.push(match[2]); inline++; }
  }
  assert.ok(inline > 0);
  new vm.Script(chunks.join("\n;\n")); // 여러 classic script 사이의 전역 이름 충돌도 검증
});

test("정적 화면 요소의 ID가 중복되지 않는다", () => {
  const markup = html.split("<script")[0];
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.ok(ids.length > 100);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
});
