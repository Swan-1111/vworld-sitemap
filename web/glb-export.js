import * as THREE from "three";
import { clone as cloneSkeletons } from "three/addons/utils/SkeletonUtils.js";

export function excludedFromGLB(object) {
  const data = object.userData;
  return data.diagramWideLine || data.diagramPicker || data.diagramGeneratedBuilding || data.diagramExternalTiles;
}

/** 표시 중인 장면을 움직이지 않고, 내보내기용 노드에만 Z-up → Y-up을 적용한다. */
export function buildGLBScene(source, buildings) {
  function copy(object) {
    if (!object.visible || excludedFromGLB(object)) return null;
    const result = object.clone(false);
    for (const child of object.children) {
      const cloned = copy(child);
      if (cloned) result.add(cloned);
    }
    return result;
  }
  const filtered = copy(source);
  if (!filtered) throw new Error("내보낼 장면이 없습니다.");
  // 복제된 SkinnedMesh가 화면에 있는 원본 뼈대를 참조하지 않도록 재연결한다.
  const model = cloneSkeletons(filtered);
  const root = new THREE.Group();
  root.name = "사이트 모델 · Y-up";
  root.rotation.x = -Math.PI / 2;
  root.add(...[...model.children]);
  if (buildings) root.add(buildings);
  const output = new THREE.Scene();
  output.add(root);
  output.updateMatrixWorld(true);
  return output;
}
