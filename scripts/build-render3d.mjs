import {build} from "esbuild";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["web/render3d.js"],
  bundle: true, format: "esm", minify: true, legalComments: "eof",
  outfile: "web/render3d.bundle.js", write: !check, logLevel: "info",
});
if (check) {
  const expected = Buffer.from(result.outputFiles[0].contents);
  const actual = readFileSync(new URL("../web/render3d.bundle.js", import.meta.url));
  if (!expected.equals(actual)) {
    console.error("3D 소스와 번들이 다릅니다. npm run build:render3d를 실행하세요.");
    process.exitCode = 1;
  } else console.log("3D 소스와 번들이 일치합니다.");
}
