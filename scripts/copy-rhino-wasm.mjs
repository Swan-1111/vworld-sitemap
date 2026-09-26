import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = [
  [join(root, "node_modules", "rhino3dm", "rhino3dm.js"), join(root, "web", "rhino3dm.js")],
  [join(root, "node_modules", "rhino3dm", "rhino3dm.wasm"), join(root, "web", "rhino3dm.wasm")],
  ...["draco_decoder.js", "draco_wasm_wrapper.js", "draco_decoder.wasm"].map(name => [
    join(root, "node_modules", "three", "examples", "jsm", "libs", "draco", "gltf", name),
    join(root, "web", name),
  ]),
  ...["basis_transcoder.js", "basis_transcoder.wasm"].map(name => [
    join(root, "node_modules", "three", "examples", "jsm", "libs", "basis", name),
    join(root, "web", name),
  ]),
];

for (const [source, target] of assets) {
  if (!existsSync(source)) throw new Error(`빌드 자산을 찾지 못했습니다: ${source}`);
  copyFileSync(source, target);
  console.log(`copied ${source} -> ${target}`);
}
