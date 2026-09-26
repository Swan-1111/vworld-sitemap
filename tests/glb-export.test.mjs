import assert from "node:assert/strict";
import {test} from "node:test";
import * as THREE from "three";
import {GLTFExporter} from "three/addons/exporters/GLTFExporter.js";
import {buildGLBScene} from "../web/glb-export.js";

// GLTFExporter의 Blob 변환만 제공한다. DOM·WebGL·외부 서비스는 필요하지 않다.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(buffer => {
      this.result = buffer;
      this.onloadend?.();
    });
  }
};

test("GLB는 Y-up이며, 비동기 내보내기 전후에 원본의 방향과 표시 상태를 바꾸지 않는다", async () => {
  const scene = new THREE.Scene(), root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(100, 80, 10), new THREE.MeshStandardMaterial());
  mesh.position.set(0, 0, 5); mesh.name = "대지";
  root.add(mesh); scene.add(root); scene.updateMatrixWorld(true);
  const hidden = mesh.clone(); hidden.visible = false; root.add(hidden);
  const picker = mesh.clone(); picker.userData.diagramPicker = true; root.add(picker);
  const tiles = mesh.clone(); tiles.userData.diagramExternalTiles = true; root.add(tiles);
  const before = root.matrix.toArray(), position = mesh.position.toArray();
  const output = buildGLBScene(scene);
  assert.deepEqual(root.matrix.toArray(), before);
  const size = new THREE.Box3().setFromObject(output).getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 100) < 1e-8);
  assert.ok(Math.abs(size.y - 10) < 1e-8);
  assert.ok(Math.abs(size.z - 80) < 1e-8);
  const binary = await new GLTFExporter().parseAsync(output, {binary: true});
  const view = new DataView(binary);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 20, view.getUint32(12, true))));
  assert.equal(gltf.meshes.length, 1);
  assert.deepEqual(root.matrix.toArray(), before);
  assert.deepEqual(mesh.position.toArray(), position);
  assert.equal(hidden.visible, false);
  assert.equal(picker.visible, true);
  mesh.geometry.dispose(); mesh.material.dispose();
});
