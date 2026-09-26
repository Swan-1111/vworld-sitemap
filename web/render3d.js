import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Rhino3dmLoader } from "three/addons/loaders/3DMLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { TilesRenderer } from "3d-tiles-renderer/three";
import { buildGLBScene } from "./glb-export.js";

const RAD = Math.PI / 180;
const VIEW_STYLE_BASE_ZOOM = 1.6;
// VWorld WebGL 3.0의 공식 vworld.json에서 facility_build(LoD4)가 가리키는
// 3D Tiles 타일셋이다. 별도 VWorld 뷰어를 띄우지 않고 현재 Three.js 장면에 넣는다.
const VWORLD_REAL_BUILDINGS = "https://cdn.vworld.kr/TDServer/services/map4/TG9ENA.json";
const DRACO_LOCAL = {js:"/draco_wasm_wrapper.js",wasm:"/draco_decoder.wasm"};
const DRACO_CDN = {
  js:"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js",
  wasm:"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/draco/gltf/draco_decoder.wasm",
};
const KTX2_LOCAL = {js:"/basis_transcoder.js",wasm:"/basis_transcoder.wasm",path:"/"};
const KTX2_CDN = {
  js:"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/basis/basis_transcoder.js",
  wasm:"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/basis/basis_transcoder.wasm",
  path:"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/basis/",
};
const WGS84_A = 6378137.0;
const WGS84_E2 = 6.6943799901413165e-3;

function layerOf(state, id) {
  return (state.layers || []).find(L => L.id === id) || {};
}

// 레이어 목록의 위쪽이 높은 표시 우선순위다. 깊이 판정은 유지하므로 뒤에 있는
// 건물이 지형을 뚫고 나오지는 않고, 겹치거나 투명한 면·선의 그리는 순서만 정돈된다.
function layerRenderOrder(state,id){
  const layers=state.layers||[],index=layers.findIndex(layer=>layer.id===id);
  return index<0?0:(layers.length-index)*100;
}

function assignLayerOrder(object,state,id,offset=0){
  if(!object)return object;
  object.traverse(child=>{
    child.userData.diagramLayerId=id;
    child.userData.diagramLayerOffset=offset;
    child.renderOrder=layerRenderOrder(state,id)+offset;
  });
  return object;
}

function polygonGroups(item) {
  const groups = item?.polygons;
  if (Array.isArray(groups) && groups.some(group => Array.isArray(group) && group.length))
    return groups;
  return (item?.rings || []).map(ring => [ring]);
}

function buildingKey(scene, building, index = 0) {
  const ring = building.rings?.[0] || [];
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  const n = ring.length || 1;
  return `${scene.name}|${building.pnu || "building"}|${(x / n).toFixed(2)},${(y / n).toFixed(2)}|${index}`;
}

function buildingBounds(building) {
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const polygon of polygonGroups(building))for(const ring of polygon||[])for(const p of ring||[]){
    x0=Math.min(x0,p[0]);y0=Math.min(y0,p[1]);x1=Math.max(x1,p[0]);y1=Math.max(y1,p[1]);
  }
  return Number.isFinite(x0)?{x0,y0,x1,y1}:null;
}

function ringAreaCentroid(ring){
  if(!Array.isArray(ring)||ring.length<3)return null;
  let twiceArea=0,xSum=0,ySum=0;
  for(let index=0;index<ring.length;index++){
    const a=ring[index],b=ring[(index+1)%ring.length];
    if(!a||!b||!Number.isFinite(+a[0])||!Number.isFinite(+a[1])||
      !Number.isFinite(+b[0])||!Number.isFinite(+b[1]))continue;
    const cross=(+a[0])*(+b[1])-(+b[0])*(+a[1]);
    twiceArea+=cross;xSum+=(+a[0]+ +b[0])*cross;ySum+=(+a[1]+ +b[1])*cross;
  }
  if(Math.abs(twiceArea)<1e-9)return null;
  return {area:Math.abs(twiceArea)/2,x:xSum/(3*twiceArea),y:ySum/(3*twiceArea)};
}

// 바운딩박스 중앙은 L자형·오목한 건물을 틀어지게 배치한다. 외곽은 더하고
// 구멍은 빼서 실제 건물 바닥 폴리곤의 면적 중심을 구한다.
function buildingFootprintCentroid(building){
  let weight=0,x=0,y=0;
  for(const polygon of polygonGroups(building)){
    for(let ringIndex=0;ringIndex<(polygon||[]).length;ringIndex++){
      const part=ringAreaCentroid(polygon[ringIndex]);if(!part)continue;
      const signed=ringIndex===0?part.area:-part.area;
      weight+=signed;x+=part.x*signed;y+=part.y*signed;
    }
  }
  if(Math.abs(weight)>1e-8)return {x:x/weight,y:y/weight};
  const bounds=buildingBounds(building);
  return bounds?{x:(bounds.x0+bounds.x1)/2,y:(bounds.y0+bounds.y1)/2}:null;
}

function convexHull2D(source){
  const unique=new Map();
  for(const point of source||[]){
    if(!Number.isFinite(point?.[0])||!Number.isFinite(point?.[1]))continue;
    const key=`${Math.round(point[0]*1e6)},${Math.round(point[1]*1e6)}`;
    if(!unique.has(key))unique.set(key,[point[0],point[1]]);
  }
  const points=[...unique.values()].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  if(points.length<=2)return points;
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const lower=[];for(const point of points){while(lower.length>=2&&cross(lower.at(-2),lower.at(-1),point)<=0)lower.pop();lower.push(point);}
  const upper=[];for(let index=points.length-1;index>=0;index--){const point=points[index];while(upper.length>=2&&cross(upper.at(-2),upper.at(-1),point)<=0)upper.pop();upper.push(point);}
  lower.pop();upper.pop();return lower.concat(upper);
}

function visitMeshTriangles(root,visitor){
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
  const instanceMatrix=new THREE.Matrix4();
  root.traverse(object=>{
    if(!object.isMesh||object.visible===false)return;
    const geometry=object.geometry,position=geometry?.getAttribute?.("position");if(!position)return;
    const index=geometry.index,total=index?index.count:position.count;
    const start=Math.max(0,geometry.drawRange?.start||0);
    const end=Math.min(total,Number.isFinite(geometry.drawRange?.count)?start+geometry.drawRange.count:total);
    const matrices=[];
    if(object.isInstancedMesh){
      for(let instance=0;instance<object.count;instance++){
        object.getMatrixAt(instance,instanceMatrix);
        matrices.push(new THREE.Matrix4().multiplyMatrices(object.matrixWorld,instanceMatrix));
      }
    }else matrices.push(object.matrixWorld);
    for(const matrix of matrices)for(let offset=start;offset+2<end;offset+=3){
      const ia=index?index.getX(offset):offset,ib=index?index.getX(offset+1):offset+1,ic=index?index.getX(offset+2):offset+2;
      a.fromBufferAttribute(position,ia).applyMatrix4(matrix);
      b.fromBufferAttribute(position,ib).applyMatrix4(matrix);
      c.fromBufferAttribute(position,ic).applyMatrix4(matrix);
      visitor(a,b,c);
    }
  });
}

// 모델 하부의 수평 삼각면을 면적 가중한다. 작은 기초나 돌출부가 본체의
// 기준면을 망치지 않도록 하부 25% 안에서 첫 유의미한 수평면을 선택한다.
function modelBaseAnchor(root,bounds){
  const size=bounds.getSize(new THREE.Vector3()),height=Math.max(size.z,1e-6);
  const tolerance=Math.max(1e-5,height*.001,Math.max(size.x,size.y)*1e-6);
  const groups=new Map(),lowPoints=[];
  visitMeshTriangles(root,(a,b,c)=>{
    const zMin=Math.min(a.z,b.z,c.z),zMax=Math.max(a.z,b.z,c.z);
    if(zMin<=bounds.min.z+Math.max(tolerance*3,height*.01))lowPoints.push([a.x,a.y],[b.x,b.y],[c.x,c.y]);
    if(zMax-zMin>tolerance*2)return;
    const area=Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))/2;if(area<=1e-10)return;
    const z=(a.z+b.z+c.z)/3,key=Math.round((z-bounds.min.z)/tolerance);
    let group=groups.get(key);if(!group){group={z,area:0,x:0,y:0,points:[]};groups.set(key,group);}
    const cx=(a.x+b.x+c.x)/3,cy=(a.y+b.y+c.y)/3;
    group.z=(group.z*group.area+z*area)/(group.area+area);group.area+=area;
    group.x+=cx*area;group.y+=cy*area;
    if(group.points.length<60000)group.points.push([a.x,a.y],[b.x,b.y],[c.x,c.y]);
  });
  const lowLimit=bounds.min.z+Math.max(tolerance*3,height*.25);
  const candidates=[...groups.values()].filter(group=>group.z<=lowLimit).sort((a,b)=>a.z-b.z);
  if(candidates.length){
    const maxArea=Math.max(...candidates.map(group=>group.area));
    const selected=candidates.find(group=>group.area>=maxArea*.12)||candidates[0];
    const x=selected.x/selected.area,y=selected.y/selected.area;
    return {x,y,z:selected.z,footprint:convexHull2D(selected.points).map(point=>[point[0]-x,point[1]-y]),method:"bottom-face"};
  }
  const hull=convexHull2D(lowPoints);
  let x=0,y=0;const hullCentroid=ringAreaCentroid(hull);
  if(hullCentroid){x=hullCentroid.x;y=hullCentroid.y;}
  else if(hull.length){for(const point of hull){x+=point[0];y+=point[1];}x/=hull.length;y/=hull.length;}
  else{x=(bounds.min.x+bounds.max.x)/2;y=(bounds.min.y+bounds.max.y)/2;}
  return {x,y,z:bounds.min.z,footprint:hull.map(point=>[point[0]-x,point[1]-y]),method:"lowest-points"};
}

function groundAt(scene, x, y) {
  const g = scene.ground;
  if (!g || !g.n) return 0;
  const R = scene.radius;
  const fx = Math.max(0, Math.min(g.n, (x + R) / g.step));
  const fy = Math.max(0, Math.min(g.n, (y + R) / g.step));
  const i = Math.min(g.n - 1, Math.floor(fx));
  const j = Math.min(g.n - 1, Math.floor(fy));
  const tx = fx - i, ty = fy - j;
  return g.z[j][i] * (1 - tx) * (1 - ty) + g.z[j][i + 1] * tx * (1 - ty) +
         g.z[j + 1][i] * (1 - tx) * ty + g.z[j + 1][i + 1] * tx * ty;
}

function terrainSpec(scene) {
  const g=scene.ground;if(!g)return {base:0,step:5,levels:[]};
  if(g._terrainSpec)return g._terrainSpec;
  const source=[...new Set((scene.contours||[]).map(c=>+c.z).filter(Number.isFinite))].sort((a,b)=>a-b);
  const diffs=[];for(let i=1;i<source.length;i++)if(source[i]-source[i-1]>.01)diffs.push(source[i]-source[i-1]);
  const step=diffs.length?Math.min(...diffs):5,anchor=source[0]??0,levels=[];
  let z=anchor+Math.ceil((g.min-anchor)/step-1e-7)*step;
  while(z<=g.min+.01)z+=step;
  for(;z<=g.max+.01;z+=step)levels.push(Math.round(z*100)/100);
  return g._terrainSpec={base:g.min,step,levels};
}

function terrainDisplayZ(scene,state,z) {
  if(state.terrainMode!=="stepped")return z;
  const spec=terrainSpec(scene);let out=spec.base;
  for(const level of spec.levels){if(z+1e-7<level)break;out=level;}
  return out;
}

function clipTerrain(poly,level,above) {
  const out=[],inside=p=>above?p[2]>=level-1e-7:p[2]<=level+1e-7;
  for(let i=0;i<poly.length;i++){
    const a=poly[i],b=poly[(i+1)%poly.length],aIn=inside(a),bIn=inside(b);
    if(aIn)out.push(a);
    if(aIn!==bIn){const t=(level-a[2])/(b[2]-a[2]);out.push([
      a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,level]);}
  }
  return out;
}

function terrainLevelSegment(triangle,level) {
  const clipped=clipTerrain(triangle,level,true),points=[];
  for(const p of clipped)if(Math.abs(p[2]-level)<1e-5&&
    !points.some(q=>Math.hypot(q[0]-p[0],q[1]-p[1])<1e-5))points.push(p);
  if(points.length<2)return null;
  let a=points[0],b=points[1],far=0;
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
    const d=Math.hypot(points[i][0]-points[j][0],points[i][1]-points[j][1]);
    if(d>far){far=d;a=points[i];b=points[j];}
  }
  return far>1e-5?[a,b]:null;
}

function disposeTree(root) {
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      for (const k of Object.keys(m)) if (m[k] && m[k].isTexture) m[k].dispose();
      m.dispose();
    }
  });
}

function setProjectedUV(geometry, radius) {
  const p = geometry.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getX(i) + radius) / (radius * 2);
    uv[i * 2 + 1] = (p.getY(i) + radius) / (radius * 2);
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

function colorFor(mode, id, layer, selected = false) {
  if (selected) return new THREE.Color("#e2564a");
  return new THREE.Color(layer.fill || (id === "ground" ? "#ded9cc" : "#dfe3ea"));
}

function meshMaterial(state, id, selected, texture) {
  const L = layerOf(state, id), mapped = !!texture;
  const material = new THREE.MeshStandardMaterial({
    color: mapped ? 0xffffff : colorFor(state.renderMode, id, L, selected),
    map: mapped ? texture : null,
    roughness: .9,
    metalness: 0,
    side: id === "ground" || id === "designGround" ? THREE.DoubleSide : THREE.FrontSide,
    transparent: (L.op ?? 100) < 100,
    opacity: (L.op ?? 100) / 100,
    depthWrite: (L.op ?? 100) > 70,
  });
  material.name = `${L.name || id}${selected ? " · 선택" : ""}`;
  return material;
}

function lineMaterial(layer, fallback, opacityFactor = 1) {
  const baseWidth = Math.max(.01, Number(layer.w) || 1);
  const material = new LineMaterial({
    color: layer.stroke || fallback,
    // LineBasicMaterial.linewidth 는 대부분의 WebGL 환경에서 항상 1px이다.
    // LineMaterial은 CSS 픽셀 단위 굵기를 실제 셰이더에서 확장한다.
    linewidth: baseWidth,
    worldUnits: false,
    transparent: (layer.op ?? 100) * opacityFactor < 100,
    opacity: Math.min(1, (layer.op ?? 100) / 100 * opacityFactor),
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  // LineMaterial의 굵기는 CSS 픽셀 단위라 카메라 줌만 바꿔서는 함께 변하지 않는다.
  // 원래 레이어 값을 보존해 두고 매 프레임 현재 줌 배율을 적용한다.
  material.userData.diagramBaseLineWidth = baseWidth;
  return material;
}

/** 일반 BufferGeometry 선분을 화면 픽셀 굵기를 지원하는 선으로 바꾼다. */
function thickLineSegments(source, layer, fallback, opacityFactor = 1) {
  const p = source.getAttribute("position"), index = source.getIndex(), positions = [];
  if (!p) { source.dispose(); return null; }
  const append = i => positions.push(p.getX(i), p.getY(i), p.getZ(i));
  if (index) for (let i = 0; i < index.count; i++) append(index.getX(i));
  else for (let i = 0; i < p.count; i++) append(i);
  source.dispose();
  if (positions.length < 6) return null;
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  const line = new LineSegments2(geometry, lineMaterial(layer, fallback, opacityFactor));
  line.userData.diagramWideLine = true;
  return line;
}

function terrainGeometry(scene, state) {
  const g = scene.ground;
  if (!g || !g.n) return null;
  const R = scene.radius, b = scene.context_bounds || [-R, -R, R, R];
  const pos = [], uv = [], idx = [];
  const add = (x, y, z) => {
    pos.push(x, y, z * state.vScale);
    uv.push((x + R) / (2 * R), (y + R) / (2 * R));
    return pos.length / 3 - 1;
  };
  const addTop=(poly,z)=>{
    if(poly.length<3)return;
    const first=add(poly[0][0],poly[0][1],z);
    for(let k=1;k<poly.length-1;k++)idx.push(first,add(poly[k][0],poly[k][1],z),add(poly[k+1][0],poly[k+1][1],z));
  };
  const addWall=(a,b,z0,z1)=>{
    const p=add(a[0],a[1],z0),q=add(b[0],b[1],z0),r=add(b[0],b[1],z1),s=add(a[0],a[1],z1);
    idx.push(p,q,r,p,r,s);
  };
  const addTriangle=triangle=>{
    if(state.terrainMode!=="stepped"){
      const a=add(...triangle[0]),b=add(...triangle[1]),c=add(...triangle[2]);idx.push(a,b,c);return;
    }
    const spec=terrainSpec(scene),cuts=[spec.base,...spec.levels];
    for(let k=0;k<cuts.length;k++){
      let band=clipTerrain(triangle,cuts[k],true);
      if(k+1<cuts.length)band=clipTerrain(band,cuts[k+1],false);
      addTop(band,cuts[k]);
    }
    for(let k=1;k<cuts.length;k++){
      const segment=terrainLevelSegment(triangle,cuts[k]);
      if(segment)addWall(segment[0],segment[1],cuts[k-1],cuts[k]);
    }
  };
  for (let j = 0; j < g.n; j++) {
    const cy0 = Math.max(-R + j * g.step, b[1]);
    const cy1 = Math.min(-R + (j + 1) * g.step, b[3]);
    if (cy1 <= cy0) continue;
    for (let i = 0; i < g.n; i++) {
      const cx0 = Math.max(-R + i * g.step, b[0]);
      const cx1 = Math.min(-R + (i + 1) * g.step, b[2]);
      if (cx1 <= cx0) continue;
      const p00=[cx0,cy0,groundAt(scene,cx0,cy0)],p10=[cx1,cy0,groundAt(scene,cx1,cy0)];
      const p11=[cx1,cy1,groundAt(scene,cx1,cy1)],p01=[cx0,cy1,groundAt(scene,cx0,cy1)];
      if(Math.abs(p00[2]-p11[2])<=Math.abs(p10[2]-p01[2])){
        addTriangle([p00,p10,p11]);addTriangle([p00,p11,p01]);
      }else{
        addTriangle([p00,p10,p01]);addTriangle([p10,p11,p01]);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals();
  geo.name = "CONTEXT 지형";
  return geo;
}

function terrainSlabGeometry(scene,state){
  const g=scene.ground;if(!g||!g.n||state.groundDepth<=0)return null;
  const R=scene.radius,b=scene.context_bounds||[-R,-R,R,R],bottom=g.min*state.vScale-state.groundDepth;
  const pos=[],idx=[],edges=[
    [[b[0],b[1]],[b[2],b[1]]],[[b[2],b[1]],[b[2],b[3]]],
    [[b[2],b[3]],[b[0],b[3]]],[[b[0],b[3]],[b[0],b[1]]],
  ];
  const add=(x,y,z)=>{pos.push(x,y,z);return pos.length/3-1;};
  for(const [p0,p1] of edges){
    const n=Math.max(1,Math.ceil(Math.hypot(p1[0]-p0[0],p1[1]-p0[1])/g.step));
    for(let k=0;k<n;k++){
      const t0=k/n,t1=(k+1)/n,x0=p0[0]+(p1[0]-p0[0])*t0,y0=p0[1]+(p1[1]-p0[1])*t0;
      const x1=p0[0]+(p1[0]-p0[0])*t1,y1=p0[1]+(p1[1]-p0[1])*t1;
      const a=add(x0,y0,bottom),c=add(x1,y1,bottom);
      const d=add(x1,y1,terrainDisplayZ(scene,state,groundAt(scene,x1,y1))*state.vScale);
      const e=add(x0,y0,terrainDisplayZ(scene,state,groundAt(scene,x0,y0))*state.vScale);idx.push(a,d,c,a,e,d);
    }
  }
  const geo=new THREE.BufferGeometry();geo.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
  geo.setIndex(idx);geo.computeVertexNormals();geo.name="대지 절단면";return geo;
}

/** 현재 뷰에서 카메라를 향한 반쪽을 잘라내는 수직 단면 평면. */
export function sectionDefinition(scene,state){
  const section=state.section||{};
  if(!section.on)return null;
  const angle=(Number.isFinite(+section.az)?+section.az:+state.az||0)*RAD;
  // 카메라가 있는 수평 방향. dot(point, normal) > offset 인 앞쪽을 제거한다.
  const nx=-Math.sin(angle),ny=-Math.cos(angle),R=scene.radius||250;
  const offset=Math.max(-R,Math.min(R,(Number(section.position)||0)/100*R));
  return {nx,ny,offset,plane:new THREE.Plane(new THREE.Vector3(nx,ny,0),-offset)};
}

function sectionLineSegment(scene,definition){
  const R=scene.radius||250,b=scene.context_bounds||[-R,-R,R,R];
  const {nx,ny,offset}=definition,tx=-ny,ty=nx;
  // p = normal * offset + tangent * t 를 CONTEXT 사각형에 클립한다.
  const px=nx*offset,py=ny*offset;
  let lo=-Infinity,hi=Infinity;
  for(const [origin,direction,min,max] of [[px,tx,b[0],b[2]],[py,ty,b[1],b[3]]]){
    if(Math.abs(direction)<1e-9){if(origin<min||origin>max)return null;continue;}
    const a=(min-origin)/direction,c=(max-origin)/direction;
    lo=Math.max(lo,Math.min(a,c));hi=Math.min(hi,Math.max(a,c));
  }
  return hi>lo?{a:[px+tx*lo,py+ty*lo],b:[px+tx*hi,py+ty*hi],length:hi-lo}:null;
}

/** 지형 절단선의 실제 높이를 따라 막힌 수직 면을 만든다. */
export function sectionTerrainCapGeometry(scene,state){
  const definition=sectionDefinition(scene,state),segment=definition&&sectionLineSegment(scene,definition);
  if(!segment||!scene.ground?.n)return null;
  const step=Math.max(1,scene.ground.step||8),count=Math.max(1,Math.min(320,Math.ceil(segment.length/step)));
  const bottom=(scene.ground.min||0)*state.vScale-Math.max(0,state.groundDepth||0);
  const positions=[],indices=[];
  const add=(x,y,z)=>{positions.push(x,y,z);return positions.length/3-1;};
  for(let index=0;index<count;index++){
    const t0=index/count,t1=(index+1)/count;
    const x0=segment.a[0]+(segment.b[0]-segment.a[0])*t0;
    const y0=segment.a[1]+(segment.b[1]-segment.a[1])*t0;
    const x1=segment.a[0]+(segment.b[0]-segment.a[0])*t1;
    const y1=segment.a[1]+(segment.b[1]-segment.a[1])*t1;
    const z0=terrainDisplayZ(scene,state,groundAt(scene,x0,y0))*state.vScale;
    const z1=terrainDisplayZ(scene,state,groundAt(scene,x1,y1))*state.vScale;
    const a=add(x0,y0,bottom),b=add(x1,y1,bottom),c=add(x1,y1,z1),d=add(x0,y0,z0);
    indices.push(a,b,c,a,c,d);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  geometry.setIndex(indices);geometry.computeVertexNormals();geometry.name="뷰 단면 절단면";return geometry;
}

function sectionHiddenBuildings(scene,state,selected){
  const definition=sectionDefinition(scene,state),hidden=new Set();
  if(!definition)return hidden;
  const {nx,ny,offset}=definition;
  for(const [index,building] of (scene.buildings||[]).entries()){
    if(selected.has(building.pnu))continue;
    let hasPoint=false,entirelyOnHiddenSide=true;
    for(const polygon of polygonGroups(building))for(const ring of polygon||[])for(const point of ring||[]){
      hasPoint=true;
      if(point[0]*nx+point[1]*ny>offset-.05)entirelyOnHiddenSide=false;
    }
    // 건물 표시 반공간을 지형과 반대로 두되, 경계에 걸린 건물은 자르지 않고 남긴다.
    if(hasPoint&&entirelyOnHiddenSide)hidden.add(buildingKey(scene,building,index));
  }
  return hidden;
}

export function mergedWalls(scene, state, selected, wantSelected, skipped = new Set()) {
  const pos=[],uv=[],idx=[],R=scene.radius;
  const add=(x,y,z)=>{
    pos.push(x,y,z);uv.push((x+R)/(R*2),(y+R)/(R*2));return pos.length/3-1;
  };
  for (const [buildingIndex,b] of (scene.buildings || []).entries()) {
    if(skipped.has(buildingKey(scene,b,buildingIndex)))continue;
    const isSelected = selected.has(b.pnu);
    if (isSelected !== wantSelected) continue;
    const base = terrainDisplayZ(scene,state,b.base||0) * state.vScale;
    const top=base+Math.max(1,b.floors||1)*state.floorH;
    for (const polygon of polygonGroups(b)) for (const [ringIndex, sourceRing] of polygon.entries()) {
      // 원본 GIS마다 외곽선 방향(CW/CCW)이 다르다. 그대로 삼각형을 만들면
      // 일부 건물 벽의 front face와 법선이 안쪽을 향해 웹에서도 반전돼 보인다.
      // 내보내기와 똑같이 Z-up 기준 CCW로 통일한다.
      const ring=openRing(sourceRing, ringIndex === 0);
      if (ring.length < 3) continue;
      for(let i=0;i<ring.length;i++){
        const p0=ring[i],p1=ring[(i+1)%ring.length];
        const a=add(p0[0],p0[1],base),c=add(p1[0],p1[1],base);
        const d=add(p1[0],p1[1],top),e=add(p0[0],p0[1],top);
        idx.push(a,c,d,a,d,e);
      }
    }
  }
  if(!pos.length)return null;
  const geo=new THREE.BufferGeometry();
  geo.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));
  geo.setIndex(idx);geo.computeVertexNormals();geo.name=wantSelected?"선택 건물 벽":"건물 벽";
  return geo;
}

export function mergedRoofs(scene,state,selected,wantSelected,skipped=new Set()){
  const geos=[],R=scene.radius;
  for(const [buildingIndex,b] of (scene.buildings||[]).entries()){
    if(skipped.has(buildingKey(scene,b,buildingIndex)))continue;
    if(selected.has(b.pnu)!==wantSelected)continue;
    const top=terrainDisplayZ(scene,state,b.base||0)*state.vScale+Math.max(1,b.floors||1)*state.floorH+.025;
    for(const polygon of polygonGroups(b)){
      const ring=openRing(polygon[0],true);
      if(ring.length<3)continue;
      const shape=new THREE.Shape();shape.moveTo(ring[0][0],ring[0][1]);
      for(let i=1;i<ring.length;i++)shape.lineTo(ring[i][0],ring[i][1]);
      shape.closePath();
      for(const sourceHole of polygon.slice(1)){
        const hole=openRing(sourceHole,false);if(hole.length<3)continue;
        const path=new THREE.Path();path.moveTo(hole[0][0],hole[0][1]);
        for(let i=1;i<hole.length;i++)path.lineTo(hole[i][0],hole[i][1]);
        path.closePath();shape.holes.push(path);
      }
      const geo=new THREE.ShapeGeometry(shape);geo.translate(0,0,top);setProjectedUV(geo,R);geos.push(geo);
    }
  }
  if(!geos.length)return null;
  const merged=mergeGeometries(geos,false);geos.forEach(g=>g.dispose());
  if(merged){merged.computeVertexNormals();merged.name=wantSelected?"선택 건물 지붕":"건물 지붕";}
  return merged;
}

/** ECEF 좌표인 3D Tiles를 대상지 원점의 동-북-상(ENU) 미터 좌표로 바꾼다. */
function ecefToLocalMatrix(latDeg, lonDeg) {
  const lat=latDeg*RAD,lon=lonDeg*RAD;
  const sinLat=Math.sin(lat),cosLat=Math.cos(lat),sinLon=Math.sin(lon),cosLon=Math.cos(lon);
  const n=WGS84_A/Math.sqrt(1-WGS84_E2*sinLat*sinLat);
  const origin=new THREE.Vector3(n*cosLat*cosLon,n*cosLat*sinLon,n*(1-WGS84_E2)*sinLat);
  const east=new THREE.Vector3(-sinLon,cosLon,0);
  const north=new THREE.Vector3(-sinLat*cosLon,-sinLat*sinLon,cosLat);
  const up=new THREE.Vector3(cosLat*cosLon,cosLat*sinLon,sinLat);
  return new THREE.Matrix4().set(
    east.x,east.y,east.z,-east.dot(origin),
    north.x,north.y,north.z,-north.dot(origin),
    up.x,up.y,up.z,-up.dot(origin),
    0,0,0,1
  );
}

/** Three.js 로컬 clipping plane은 양의 반공간을 자르므로 사각 범위 안쪽만 남긴다. */
function clippingPlanesFor(bounds) {
  const [x0,y0,x1,y1]=bounds;
  return [
    new THREE.Plane(new THREE.Vector3(-1,0,0),-x0),
    new THREE.Plane(new THREE.Vector3(1,0,0),x1),
    new THREE.Plane(new THREE.Vector3(0,-1,0),-y0),
    new THREE.Plane(new THREE.Vector3(0,1,0),y1),
  ];
}

function sectionPoint(world,axis){
  return axis==="x"?[world.y,world.z]:[world.x,world.z];
}

function sectionArea(ring){
  let area=0;
  for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length];area+=a[0]*b[1]-b[0]*a[1];
  }
  return area/2;
}

function sectionContains(ring,point){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if((a[1]>point[1])!==(b[1]>point[1])&&
       point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}

function simplifySectionRing(source,tolerance){
  const ring=[];
  for(const point of source){
    const previous=ring.at(-1);
    if(!previous||Math.hypot(point[0]-previous[0],point[1]-previous[1])>tolerance*.35)ring.push(point);
  }
  if(ring.length>2&&Math.hypot(ring[0][0]-ring.at(-1)[0],ring[0][1]-ring.at(-1)[1])<=tolerance)ring.pop();
  let changed=true;
  while(changed&&ring.length>3){
    changed=false;
    for(let i=0;i<ring.length;i++){
      const a=ring[(i+ring.length-1)%ring.length],b=ring[i],c=ring[(i+1)%ring.length];
      const cross=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
      const span=Math.hypot(c[0]-a[0],c[1]-a[1]);
      if(Math.abs(cross)<=tolerance*Math.max(span,1)){
        ring.splice(i,1);changed=true;break;
      }
    }
  }
  return ring;
}

/** 삼각 메시와 한 CONTEXT 경계면의 교차선을 실제 닫힌 단면으로 바꾼다. */
function crossSectionCapGeometry(sources,spec){
  const tolerance=.025,epsilon=1e-5,segments=[];
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
  const vertices=[a,b,c];
  for(const {object,matrix} of sources){
    const geometry=object.geometry,position=geometry?.getAttribute("position");
    if(!position)continue;
    const hidden=geometry.getAttribute("vworldHide"),index=geometry.getIndex();
    const triangleCount=index?Math.floor(index.count/3):Math.floor(position.count/3);
    for(let triangle=0;triangle<triangleCount;triangle++){
      const ids=[0,1,2].map(offset=>index?index.getX(triangle*3+offset):triangle*3+offset);
      if(hidden&&ids.some(id=>hidden.getX(id)>.5))continue;
      const distances=[];
      for(let i=0;i<3;i++){
        vertices[i].fromBufferAttribute(position,ids[i]).applyMatrix4(matrix);
        distances.push((spec.axis==="x"?vertices[i].x:vertices[i].y)-spec.coordinate);
      }
      if(distances.every(value=>value>epsilon)||distances.every(value=>value<-epsilon)||
         distances.every(value=>Math.abs(value)<=epsilon))continue;
      const hits=[];
      const addHit=point=>{
        const projected=sectionPoint(point,spec.axis);
        if(!hits.some(hit=>Math.hypot(hit[0]-projected[0],hit[1]-projected[1])<epsilon*5))hits.push(projected);
      };
      for(const [i,j] of [[0,1],[1,2],[2,0]]){
        const di=distances[i],dj=distances[j];
        if(Math.abs(di)<=epsilon)addHit(vertices[i]);
        if(di*dj<-epsilon*epsilon){
          const t=di/(di-dj);addHit(vertices[i].clone().lerp(vertices[j],t));
        }
      }
      if(hits.length<2)continue;
      let pair=[hits[0],hits[1]],distance=-1;
      for(let i=0;i<hits.length;i++)for(let j=i+1;j<hits.length;j++){
        const next=Math.hypot(hits[i][0]-hits[j][0],hits[i][1]-hits[j][1]);
        if(next>distance){distance=next;pair=[hits[i],hits[j]];}
      }
      if(distance>tolerance*.2)segments.push(pair);
    }
  }
  if(!segments.length)return {geometry:null,segments:0,loops:0,triangles:0};

  const nodes=new Map(),edges=[];
  const nodeFor=point=>{
    const key=`${Math.round(point[0]/tolerance)}:${Math.round(point[1]/tolerance)}`;
    let node=nodes.get(key);
    if(!node){node={point:[...point],samples:1,edges:[]};nodes.set(key,node);}
    else{
      node.point[0]=(node.point[0]*node.samples+point[0])/(node.samples+1);
      node.point[1]=(node.point[1]*node.samples+point[1])/(node.samples+1);node.samples++;
    }
    return node;
  };
  for(const segment of segments){
    const first=nodeFor(segment[0]),second=nodeFor(segment[1]);if(first===second)continue;
    const edge={first,second,used:false};first.edges.push(edge);second.edges.push(edge);edges.push(edge);
  }
  const loops=[];
  for(const firstEdge of edges){
    if(firstEdge.used)continue;
    const start=firstEdge.first,path=[start.point],walkEdges=[];
    let current=start,previous=null,edge=firstEdge,closed=false;
    for(let guard=0;guard<edges.length+2&&edge;guard++){
      walkEdges.push(edge);edge.used=true;
      const next=edge.first===current?edge.second:edge.first;path.push(next.point);
      if(next===start){closed=true;break;}
      const candidates=next.edges.filter(candidate=>!candidate.used);
      if(!candidates.length)break;
      if(candidates.length===1)edge=candidates[0];
      else{
        const inX=next.point[0]-current.point[0],inY=next.point[1]-current.point[1],inL=Math.hypot(inX,inY)||1;
        edge=candidates.reduce((best,candidate)=>{
          const other=candidate.first===next?candidate.second:candidate.first;
          const outX=other.point[0]-next.point[0],outY=other.point[1]-next.point[1],outL=Math.hypot(outX,outY)||1;
          const score=(inX*outX+inY*outY)/(inL*outL);
          return !best||score>best.score?{edge:candidate,score}:best;
        },null).edge;
      }
      previous=current;current=next;
    }
    if(!closed){for(const walked of walkEdges)walked.used=false;continue;}
    const ring=simplifySectionRing(path.slice(0,-1),tolerance);
    if(ring.length>=3&&Math.abs(sectionArea(ring))>.0025)loops.push(ring);
  }
  if(!loops.length)return {geometry:null,segments:segments.length,loops:0,triangles:0};

  const records=loops.map(ring=>({ring,area:sectionArea(ring),parent:-1,depth:0}));
  for(let i=0;i<records.length;i++){
    const point=records[i].ring[0];let parent=-1,parentArea=Infinity;
    for(let j=0;j<records.length;j++){
      if(i===j)continue;const area=Math.abs(records[j].area);
      if(area>Math.abs(records[i].area)&&area<parentArea&&sectionContains(records[j].ring,point)){
        parent=j;parentArea=area;
      }
    }
    records[i].parent=parent;
  }
  const depthOf=index=>{
    let depth=0,parent=records[index].parent,guard=0;
    while(parent>=0&&guard++<records.length){depth++;parent=records[parent].parent;}
    return depth;
  };
  records.forEach((record,index)=>record.depth=depthOf(index));
  const positions=[],normals=[],indices=[];
  const normal=spec.normal,coordinate=spec.coordinate-spec.outwardSign*.002;
  const point3=(point)=>spec.axis==="x"?[coordinate,point[0],point[1]]:[point[0],coordinate,point[1]];
  for(let outerIndex=0;outerIndex<records.length;outerIndex++){
    const outerRecord=records[outerIndex];if(outerRecord.depth%2)continue;
    const outer=outerRecord.area<0?[...outerRecord.ring].reverse():outerRecord.ring;
    const holes=records.filter(record=>record.parent===outerIndex&&record.depth===outerRecord.depth+1)
      .map(record=>record.area>0?[...record.ring].reverse():record.ring);
    const contour=outer.map(point=>new THREE.Vector2(...point));
    const holeVectors=holes.map(ring=>ring.map(point=>new THREE.Vector2(...point)));
    const triangles=THREE.ShapeUtils.triangulateShape(contour,holeVectors);if(!triangles.length)continue;
    const flat=[outer,...holes].flat(),offset=positions.length/3;
    for(const point of flat){positions.push(...point3(point));normals.push(normal[0],normal[1],normal[2]);}
    for(const triangle of triangles){
      if(spec.outwardSign>0)indices.push(offset+triangle[0],offset+triangle[1],offset+triangle[2]);
      else indices.push(offset+triangle[2],offset+triangle[1],offset+triangle[0]);
    }
  }
  if(!indices.length)return {geometry:null,segments:segments.length,loops:loops.length,triangles:0};
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute("normal",new THREE.Float32BufferAttribute(normals,3));
  geometry.setIndex(indices);geometry.computeBoundingBox();geometry.computeBoundingSphere();
  return {geometry,segments:segments.length,loops:loops.length,triangles:indices.length/3};
}

function openRing(ring, counterClockwise = true) {
  const points=(ring||[]).filter(p=>Array.isArray(p)&&Number.isFinite(+p[0])&&Number.isFinite(+p[1]))
    .map(p=>[+p[0],+p[1]]);
  if(points.length>1&&Math.hypot(points[0][0]-points.at(-1)[0],points[0][1]-points.at(-1)[1])<1e-7)points.pop();
  if(points.length<3)return [];
  let area=0;
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length];area+=a[0]*b[1]-b[0]*a[1];
  }
  // 외곽은 반시계, 구멍은 시계 방향이어야 벽 법선이 솔리드 바깥을 향한다.
  if((counterClockwise&&area<0)||(!counterClockwise&&area>0))points.reverse();
  return points;
}

/**
 * GLB용 건물 하나를 바닥·벽·지붕이 한 인덱스를 공유하는 닫힌 메시로 만든다.
 * 화면에서는 성능을 위해 통합 메시를 계속 쓰고, 내보내기에서만 이 형상을 사용한다.
 */
export function closedBuildingGeometry(scene,state,building) {
  const positions=[],uv=[],capIndices=[],wallIndices=[],R=Math.max(1,scene.radius||1);
  const base=terrainDisplayZ(scene,state,building.base||0)*state.vScale;
  const top=base+Math.max(1,building.floors||1)*state.floorH;
  const add=(x,y,z)=>{
    positions.push(x,y,z);uv.push((x+R)/(R*2),(y+R)/(R*2));return positions.length/3-1;
  };
  for(const polygon of polygonGroups(building)){
    const rings=polygon.map((source,index)=>openRing(source,index===0)).filter(ring=>ring.length>=3);
    if(!rings.length)continue;
    const contour=rings[0].map(p=>new THREE.Vector2(p[0],p[1]));
    const holes=rings.slice(1).map(ring=>ring.map(p=>new THREE.Vector2(p[0],p[1])));
    const triangles=THREE.ShapeUtils.triangulateShape(contour,holes);
    if(!triangles.length)continue;
    const flat=rings.flat();
    const bottom=flat.map(p=>add(p[0],p[1],base));
    const roof=flat.map(p=>add(p[0],p[1],top));
    for(const tri of triangles){
      capIndices.push(roof[tri[0]],roof[tri[1]],roof[tri[2]]);
      capIndices.push(bottom[tri[2]],bottom[tri[1]],bottom[tri[0]]);
    }
    let offset=0;
    for(const ring of rings){
      for(let i=0;i<ring.length;i++){
        const j=(i+1)%ring.length,a=offset+i,b=offset+j;
        wallIndices.push(bottom[a],bottom[b],roof[b],bottom[a],roof[b],roof[a]);
      }
      offset+=ring.length;
    }
  }
  if(!positions.length)return null;
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));
  geometry.setIndex([...capIndices,...wallIndices]);
  // 재질 그룹은 glTF primitive로 갈라진다. Rhino 가져오기가 primitive마다 메시를
  // 나누지 않도록 한 건물은 한 primitive(한 재질)만 유지한다.
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  geometry.name="건물 닫힌 메시";
  return geometry;
}

function lineGeometry(items, zOf, pathsOf) {
  const pos=[];
  for(const item of items||[]) for(const path of pathsOf(item)||[]){
    for(let i=0;i<path.length-1;i++){
      const z0=zOf(item,path[i]),z1=zOf(item,path[i+1]);
      pos.push(path[i][0],path[i][1],z0,path[i+1][0],path[i+1][1],z1);
    }
  }
  if(!pos.length)return null;
  const geo=new THREE.BufferGeometry();geo.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
  return geo;
}

function cloneModel(source){
  const root=source.clone(true);
  root.traverse(object=>{
    if(object.geometry)object.geometry=object.geometry.clone();
    if(object.material){
      const cloneMaterial=material=>{
        const out=material.clone();
        for(const key of Object.keys(out))if(out[key]?.isTexture)out[key]=out[key].clone();
        return out;
      };
      object.material=Array.isArray(object.material)
        ?object.material.map(cloneMaterial):cloneMaterial(object.material);
    }
    if(object.isMesh){object.castShadow=true;object.receiveShadow=true;}
  });
  return root;
}

function colorMix(a,b,t){
  return new THREE.Color(a).lerp(new THREE.Color(b),Math.max(0,Math.min(1,t))).getStyle();
}

/** 태양 고도에 따라 낮·노을·야간으로 이어지는 하늘 팔레트. */
export function skyPalette(state){
  const sky=layerOf(state,"sky"),alt=Number(state.sunAlt)||0;
  const day=Math.max(0,Math.min(1,(alt+7)/28));
  const twilight=Math.max(0,1-Math.abs(alt-4)/18);
  const zenith=colorMix("#111827",sky.zenith||"#719bc4",day);
  let horizon=colorMix("#26334a",sky.horizon||"#e7edf0",day);
  horizon=colorMix(horizon,"#f0a06b",twilight*.58);
  return {zenith,horizon,day,twilight};
}

function paintSkyCanvas(state,canvas){
  const sky=layerOf(state,"sky"),palette=skyPalette(state);
  const width=768,height=384,ctx=canvas.getContext("2d");canvas.width=width;canvas.height=height;
  const gradient=ctx.createLinearGradient(0,0,0,height);
  gradient.addColorStop(0,palette.zenith);gradient.addColorStop(.72,palette.horizon);
  gradient.addColorStop(1,colorMix(palette.horizon,"#ffffff",palette.day*.18));
  ctx.fillStyle=gradient;ctx.fillRect(0,0,width,height);

  const glow=Math.max(0,Math.min(1,(Number(sky.sunGlow)||0)/100));
  const relative=(Number(state.sunAz)||0)-(Number(state.az)||0);
  const sunX=width*(.5+Math.sin(relative*RAD)*.4);
  const sunY=height*(.76-Math.max(-.12,Math.min(1,(Number(state.sunAlt)||0)/90))*.63);
  if(glow>0&&Number(state.sunAlt)>-10&&Math.cos(relative*RAD)>-.5){
    const radius=height*(.12+glow*.25),radial=ctx.createRadialGradient(sunX,sunY,0,sunX,sunY,radius);
    radial.addColorStop(0,`rgba(255,246,211,${.62*glow})`);
    radial.addColorStop(.18,`rgba(255,211,153,${.3*glow})`);radial.addColorStop(1,"rgba(255,190,120,0)");
    ctx.fillStyle=radial;ctx.fillRect(sunX-radius,sunY-radius,radius*2,radius*2);
    ctx.beginPath();ctx.arc(sunX,sunY,Math.max(2,4+glow*4),0,Math.PI*2);
    ctx.fillStyle=`rgba(255,248,220,${.55+.4*glow})`;ctx.fill();
  }

  const clouds=Math.max(0,Math.min(1,(Number(sky.clouds)||0)/100));
  if(clouds>0){
    const clusters=Math.round(3+clouds*16),shift=((Number(state.az)||0)%360)/360*width;
    ctx.save();ctx.filter=`blur(${4+clouds*7}px)`;
    for(let index=0;index<clusters;index++){
      const x=((index*173+97-shift*.55)%(width+220)+width+220)%(width+220)-110;
      const y=height*(.13+((index*47)%150)/height);
      const size=34+((index*29)%55)+clouds*45;
      const cloud=ctx.createRadialGradient(x,y,2,x,y,size*1.7);
      cloud.addColorStop(0,`rgba(255,255,255,${(.18+.38*palette.day)*clouds})`);
      cloud.addColorStop(.58,`rgba(238,242,247,${(.1+.22*palette.day)*clouds})`);
      cloud.addColorStop(1,"rgba(224,230,238,0)");
      ctx.fillStyle=cloud;ctx.beginPath();ctx.ellipse(x,y,size*2.1,size*.62,0,0,Math.PI*2);ctx.fill();
    }
    ctx.restore();
  }
}

export class SiteRenderer {
  constructor(canvas) {
    this.canvas=canvas;
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true,preserveDrawingBuffer:true});
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.AgXToneMapping;
    this.renderer.toneMappingExposure=1.05;
    this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled=true;
    this.scene=new THREE.Scene();
    this.root=new THREE.Group();this.root.name="사이트 모델";this.scene.add(this.root);
    this.camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10000);
    this.hemi=new THREE.HemisphereLight(0xf8fbff,0x7c7467,1);this.scene.add(this.hemi);
    this.sun=new THREE.DirectionalLight(0xffffff,2);this.sun.name="태양";this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this._signature="";this._textureVersion="";this._textures=[];
    this._modelLoader=new GLTFLoader();
    this._rhinoLoader=new Rhino3dmLoader().setLibraryPath("/").setWorkerLimit(2);
    this._buildingModels=new Map();this._buildingModelInstances=new Map();this._modelVersion=0;
    this._pickers=[];this._raycaster=new THREE.Raycaster();this.ready=true;
    this._massTiles=null;this._massSceneKey="";this._massClipKey="";this._massAppearanceKey="";this._massSectionKey="";this._massClipPlanes=[];
    this._massLoadCamera=new THREE.OrthographicCamera(-1,1,1,-1,.1,50000);
    this._massLoadCameras=[this._massLoadCamera];
    this._massFrozen=false;this._massLocked=false;this._massLoadBoundsKey="";this._massFreezeTimer=0;
    this._massStartedAt=0;this._massStableSince=0;this._massStableSignature="";
    this._massDraco=null;this._massKtx2=null;
    this._massDecoderPaths=null;this._massKtx2Path=null;this._massDecoderPromise=null;
    this._massMaskTexture=null;this._massMaskPixels=null;this._massMaskKey="";
    this._massMaskBounds=new THREE.Vector4(-1,-1,1,1);
    this._massMaskStats={selectedParcels:0,size:0};
    this._massCapGroup=null;this._massCapKey="";
    this._massModelRevision=0;this._massCapBuiltAt=-Infinity;
    this._massCapStats={planes:0,stencilMeshes:0,sources:0,crossingSources:0,
      models:0,meshes:0,positionMeshes:0,instancedMeshes:0,skinnedMeshes:0};
    this._massMapping=true;this._massLoading=false;this._massFrame=0;this._massProgress=-1;
    this._massStatus={message:"필요할 때 지정 범위의 VWorld 실물 매스를 불러옵니다.",kind:""};
    this._massStatusListener=null;this._lastRenderArgs=null;
    this._skyTexture=null;this._skyKey="";
  }

  setMassStatusListener(listener){
    this._massStatusListener=typeof listener==="function"?listener:null;
    if(this._massStatusListener)this._massStatusListener({...this._massStatus});
  }

  massStatus(){return {...this._massStatus};}

  _setMassStatus(message,kind=""){
    if(this._massStatus.message===message&&this._massStatus.kind===kind)return;
    this._massStatus={message,kind};
    this._massStatusListener?.({...this._massStatus});
  }

  _scheduleMassRender(){
    if(this._massFrame||!this._lastRenderArgs)return;
    this._massFrame=requestAnimationFrame(()=>{
      this._massFrame=0;
      if(!this._lastRenderArgs)return;
      this.render(...this._lastRenderArgs);
      if(this._massLoading)this._scheduleMassRender();
    });
  }

  _disposeMassTiles(){
    if(this._massFrame)cancelAnimationFrame(this._massFrame);
    if(this._massFreezeTimer)clearTimeout(this._massFreezeTimer);
    this._massFreezeTimer=0;
    this._massFrame=0;this._massLoading=false;this._massProgress=-1;
    this._disposeMassCaps();
    if(this._massTiles){
      this.scene.remove(this._massTiles.group);
      this._massTiles.dispose();
    }
    this._massDraco?.dispose();this._massDraco=null;
    this._massKtx2?.dispose();this._massKtx2=null;
    this._massTiles=null;this._massSceneKey="";this._massClipKey="";this._massAppearanceKey="";this._massSectionKey="";this._massClipPlanes=[];
    this._massFrozen=false;this._massLocked=false;this._massLoadBoundsKey="";
    this._massLoadCameras=[];this._massStartedAt=0;this._massStableSince=0;this._massStableSignature="";
    this._massModelRevision=0;this._massCapBuiltAt=-Infinity;
  }

  _disposeMassCaps(){
    const group=this._massCapGroup;if(!group)return;
    this.scene.remove(group);
    const materials=new Set(),geometries=new Set();
    group.traverse(object=>{
      const list=Array.isArray(object.material)?object.material:[object.material];
      for(const material of list)if(material)materials.add(material);
      if(object.userData.diagramOwnedCapGeometry&&object.geometry)geometries.add(object.geometry);
    });
    for(const material of materials)material.dispose();
    for(const geometry of geometries)geometry.dispose();
    this._massCapGroup=null;this._massCapKey="";
    this._massCapStats={planes:0,stencilMeshes:0,sources:0,crossingSources:0,
      models:0,meshes:0,positionMeshes:0,instancedMeshes:0,skinnedMeshes:0};
  }

  _massMaterial(original){
    const source=Array.isArray(original)?original[0]:original;
    const material=new THREE.MeshStandardMaterial({
      color:"#d9dde2",roughness:.9,metalness:0,
      side:source?.side??THREE.FrontSide,
      transparent:!!source?.transparent,opacity:source?.opacity??1,
      alphaTest:source?.alphaTest??0,
    });
    material.name="VWorld 실물 매스 단색";
    material.clippingPlanes=this._massClipPlanes;material.clipShadows=true;
    return material;
  }

  _massMappedMaterial(original){
    const convert=source=>{
      if(!source)return this._massMaterial(source);
      // glTF의 PBR 재질은 원래부터 조명과 그림자를 받는다.
      if(source.isMeshStandardMaterial||source.isMeshPhysicalMaterial||source.isMeshPhongMaterial||
        source.isMeshLambertMaterial||source.isMeshToonMaterial)return source;
      // VWorld 일부 타일은 구운 텍스처를 MeshBasicMaterial로 연다. Basic 재질은
      // receiveShadow=true여도 그림자 셰이더가 없어 건물 위 그림자가 전혀 보이지 않는다.
      // 텍스처와 투명 속성은 유지하고, 그림자를 받을 수 있는 PBR 재질로 감싼다.
      const material=new THREE.MeshStandardMaterial({
        color:source.color?.clone?.()||new THREE.Color(0xffffff),
        map:source.map||null,alphaMap:source.alphaMap||null,
        aoMap:source.aoMap||null,lightMap:source.lightMap||null,
        normalMap:source.normalMap||null,bumpMap:source.bumpMap||null,
        roughness:.92,metalness:0,side:source.side??THREE.FrontSide,
        transparent:!!source.transparent,opacity:source.opacity??1,alphaTest:source.alphaTest??0,
        depthTest:source.depthTest!==false,depthWrite:source.depthWrite!==false,
        vertexColors:!!source.vertexColors,
      });
      material.name=`${source.name||"VWorld 실물 매핑"} · 그림자 수신`;
      material.toneMapped=source.toneMapped!==false;
      material.userData.diagramVWorldShadowReceiver=true;
      return material;
    };
    return Array.isArray(original)?original.map(convert):convert(original);
  }

  _massDepthMaterial(){
    const material=new THREE.MeshDepthMaterial({
      depthPacking:THREE.RGBADepthPacking,side:THREE.DoubleSide,
    });
    material.name="VWorld 실물 매스 그림자 · 건물 단위 제외";
    this._applyMassMaterial(material);
    return material;
  }

  _installMassMask(material){
    if(!material||material.userData.diagramVWorldDesignMask)return;
    const previous=material.onBeforeCompile?.bind(material);
    const previousKey=material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile=(shader,renderer)=>{
      previous?.(shader,renderer);
      shader.vertexShader=shader.vertexShader
        .replace("#include <common>",`#include <common>
          attribute float vworldHide;
          varying float vVWorldHide;`)
        .replace("#include <begin_vertex>",`#include <begin_vertex>
          vVWorldHide = vworldHide;`);
      shader.fragmentShader=shader.fragmentShader
        .replace("#include <common>",`#include <common>
          varying float vVWorldHide;`)
        .replace("#include <clipping_planes_fragment>",`#include <clipping_planes_fragment>
          if ( vVWorldHide > 0.5 ) discard;`);
      material.userData.vworldDesignMaskShader=shader;
    };
    material.customProgramCacheKey=()=>`${previousKey?.()||""}|vworld-design-whole-feature-v2`;
    material.userData.diagramVWorldDesignMask=true;
  }

  _applyMassMaterial(material){
    const list=Array.isArray(material)?material:[material];
    for(const item of list){
      if(!item)continue;
      this._installMassMask(item);
      item.clippingPlanes=this._massClipPlanes;item.clipShadows=true;item.needsUpdate=true;
    }
  }

  _applyMassOpacity(material,percent){
    const value=Number(percent),factor=Math.max(0,Math.min(1,(Number.isFinite(value)?value:100)/100));
    const list=Array.isArray(material)?material:[material];
    for(const item of list){
      if(!item)continue;
      if(item.userData.diagramVWorldBaseOpacity===undefined){
        item.userData.diagramVWorldBaseOpacity=Number.isFinite(+item.opacity)?+item.opacity:1;
        item.userData.diagramVWorldBaseTransparent=!!item.transparent;
        item.userData.diagramVWorldBaseDepthWrite=item.depthWrite!==false;
      }
      item.opacity=item.userData.diagramVWorldBaseOpacity*factor;
      item.transparent=item.userData.diagramVWorldBaseTransparent||item.opacity<.999;
      item.depthWrite=item.userData.diagramVWorldBaseDepthWrite&&item.opacity>=.999;
      item.needsUpdate=true;
    }
  }

  _massCapMaterial(planes,state){
    const value=Number(layerOf(state,"renderMass").op);
    const opacity=Math.max(0,Math.min(1,(Number.isFinite(value)?value:100)/100));
    const material=new THREE.MeshStandardMaterial({
      color:"#c9ced2",roughness:.94,metalness:0,side:THREE.DoubleSide,
      clippingPlanes:planes,depthTest:true,depthWrite:opacity>=.999,
      transparent:opacity<.999,opacity,
      polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1,
    });
    material.name="VWorld CONTEXT 절단면";
    material.userData.diagramVWorldCap=true;
    return material;
  }

  _massCapsKey(bounds,state){
    const layer=layerOf(state,"renderMass");
    const section=state.section?.on
      ?`${(+state.section.az||0).toFixed(2)}|${(+state.section.position||0).toFixed(2)}`:"off";
    return `${this._massSceneKey}|${bounds.map(value=>value.toFixed(3)).join("|")}|`+
      `${this._massMaskKey}|${state.renderMode}|${layer.op??100}|${layerRenderOrder(state,"renderMass")}|${section}|${this._massModelRevision}`;
  }

  _rebuildMassCaps(tiles,bounds,state){
    this._massCapBuiltAt=performance.now();
    this._disposeMassCaps();
    if(!tiles||!tiles.group.visible)return;
    tiles.group.updateWorldMatrix(true,true);
    const sources=[],diagnostics={models:0,meshes:0,positionMeshes:0,instancedMeshes:0,skinnedMeshes:0};
    tiles.forEachLoadedModel(model=>{
      diagnostics.models++;
      model.updateWorldMatrix(true,true);
      model.traverse(object=>{
        if(!object.isMesh)return;
        diagnostics.meshes++;
        // 단면으로 숨긴 실물 건물의 본체와 절단면 채움을 함께 제거한다.
        if(object.userData.diagramSectionHidden)return;
        if(object.isInstancedMesh)diagnostics.instancedMeshes++;
        if(object.isSkinnedMesh){diagnostics.skinnedMeshes++;return;}
        if(!object.geometry?.attributes?.position)return;
        diagnostics.positionMeshes++;
        if(!object.geometry.boundingBox)object.geometry.computeBoundingBox();
        const sourceBox=object.geometry.boundingBox;if(!sourceBox)return;
        if(object.isInstancedMesh){
          const instance=new THREE.Matrix4(),world=new THREE.Matrix4();
          for(let index=0;index<object.count;index++){
            object.getMatrixAt(index,instance);world.multiplyMatrices(object.matrixWorld,instance);
            const box=sourceBox.clone().applyMatrix4(world);
            if(!box.isEmpty())sources.push({object,box,matrix:world.clone()});
          }
        }else{
          const box=sourceBox.clone().applyMatrix4(object.matrixWorld);
          if(!box.isEmpty())sources.push({object,box,matrix:object.matrixWorld.clone()});
        }
      });
    });
    if(!sources.length){
      this._massCapStats={planes:0,stencilMeshes:0,sources:0,crossingSources:0,...diagnostics};
      return;
    }
    const [x0,y0,x1,y1]=bounds,planes=this._massClipPlanes;
    const specs=[
      {axis:"x",coordinate:x0,plane:planes[0],normal:[-1,0,0],outwardSign:-1},
      {axis:"x",coordinate:x1,plane:planes[1],normal:[1,0,0],outwardSign:1},
      {axis:"y",coordinate:y0,plane:planes[2],normal:[0,-1,0],outwardSign:-1},
      {axis:"y",coordinate:y1,plane:planes[3],normal:[0,1,0],outwardSign:1},
    ];
    const group=new THREE.Group();group.name="VWorld CONTEXT 절단면 채움";
    group.userData.diagramExternalTiles=true;group.userData.diagramVWorldCaps=true;
    const baseOrder=layerRenderOrder(state,"renderMass")+20;
    let planeCount=0,stencilMeshes=0,crossingSources=0,segmentCount=0,loopCount=0,triangleCount=0;
    specs.forEach((spec,index)=>{
      const crossing=sources.filter(({box})=>{
        const min=spec.axis==="x"?box.min.x:box.min.y;
        const max=spec.axis==="x"?box.max.x:box.max.y;
        return min<spec.coordinate-.01&&max>spec.coordinate+.01;
      });
      if(!crossing.length)return;
      crossingSources+=crossing.length;
      const planeGroup=new THREE.Group();planeGroup.name=`CONTEXT 절단면 ${index+1}`;
      const section=crossSectionCapGeometry(crossing,spec),geometry=section.geometry;
      segmentCount+=section.segments;loopCount+=section.loops;triangleCount+=section.triangles;
      if(!geometry)return;
      const cap=new THREE.Mesh(geometry,this._massCapMaterial(planes.filter(plane=>plane!==spec.plane),state));
      cap.name=`VWorld CONTEXT 절단면 ${index+1}`;cap.renderOrder=baseOrder+index*4+2;
      const shadow=layerOf(state,"shadow");
      cap.receiveShadow=!!shadow.on&&!!shadow.fillOn;
      cap.userData.diagramVWorldCap=true;cap.userData.diagramOwnedCapGeometry=true;
      planeGroup.add(cap);group.add(planeGroup);planeCount++;
    });
    if(!planeCount){
      group.traverse(object=>{
        const list=Array.isArray(object.material)?object.material:[object.material];
        for(const material of list)material?.dispose?.();
        if(object.userData.diagramOwnedCapGeometry)object.geometry?.dispose?.();
      });
      this._massCapStats={planes:0,stencilMeshes,sources:sources.length,crossingSources,
        segments:segmentCount,loops:loopCount,triangles:triangleCount,...diagnostics};
      return;
    }
    this._massCapGroup=group;this._massCapKey=this._massCapsKey(bounds,state);
    this._massCapStats={planes:planeCount,stencilMeshes,sources:sources.length,crossingSources,
      segments:segmentCount,loops:loopCount,triangles:triangleCount,...diagnostics};
    this.scene.add(group);
  }

  _ensureMassCaps(tiles,bounds,state){
    const layer=layerOf(state,"renderMass"),on=layer.on&&layer.caps!==false;
    Object.assign(this._massCapStats,{
      ensureCalls:(this._massCapStats.ensureCalls||0)+1,
      lastOn:!!on,lastLayerOn:!!layer.on,lastCaps:layer.caps,
      lastProgress:this._massProgress,lastKeyMatch:this._massCapsKey(bounds,state)===this._massCapKey,
    });
    if(this._massCapGroup)this._massCapGroup.visible=!!on;
    if(!on)return;
    const key=this._massCapsKey(bounds,state);
    if(key===this._massCapKey)return;
    // 단면 위치·각도가 바뀌면 직전 건물의 채움이 한 프레임이라도 남지 않게 한다.
    if(this._massCapGroup)this._massCapGroup.visible=false;
    // 전체 타일 다운로드가 오래 걸리더라도 이미 도착한 경계 모델부터 단면을
    // 마감한다. 로딩 중에는 최대 2초에 한 번만 다시 만들어 프레임 저하를 막고,
    // 최종 고정 시에는 revision이 달라졌다면 즉시 완성본으로 교체한다.
    const interval=this._massProgress===100||state.section?.on?0:2000;
    if(performance.now()-this._massCapBuiltAt<interval)return;
    this._rebuildMassCaps(tiles,bounds,state);
  }

  _updateMassFeatureMask(model){
    if(!model)return {hiddenFeatures:0,batchMeshes:0,unclassifiedMeshes:0,maskedUnclassifiedMeshes:0};
    model.updateWorldMatrix(true,true);
    const pixels=this._massMaskPixels,image=this._massMaskTexture?.image;
    const [x0,y0,x1,y1]=this._massMaskBounds.toArray();
    const spanX=Math.max(.001,x1-x0),spanY=Math.max(.001,y1-y0);
    const active=!!pixels&&!!image&&this._massMaskStats.selectedParcels>0;
    const sample=(x,y)=>{
      if(!active||x<x0||x>x1||y<y0||y>y1)return false;
      const px=Math.max(0,Math.min(image.width-1,Math.round((x-x0)/spanX*(image.width-1))));
      const py=Math.max(0,Math.min(image.height-1,Math.round((y1-y)/spanY*(image.height-1))));
      return pixels[(py*image.width+px)*4]>128;
    };
    const hidden=new Set(),meshes=[],point=new THREE.Vector3();
    let unclassifiedMeshes=0,maskedUnclassifiedMeshes=0;
    model.traverse(object=>{
      if(!object.isMesh)return;
      const geometry=object.geometry,position=geometry?.getAttribute("position");
      if(!geometry||!position)return;
      let hide=geometry.getAttribute("vworldHide");
      if(!hide||hide.count!==position.count){
        hide=new THREE.BufferAttribute(new Float32Array(position.count),1);
        geometry.setAttribute("vworldHide",hide);
      }
      const batch=geometry.getAttribute("_batchid")||geometry.getAttribute("batchid");
      if(!batch){
        // 처음 도착하는 저해상도 타일은 건물 ID가 없는 경우가 있다. 이 상태를
        // 그대로 보이면 DESIGN AREA 건물이 잠깐 나타난다. 상세 타일의 건물 단위
        // 제외가 준비될 때까지만, 해당 공간에 걸친 초기 삼각면을 선제적으로 숨긴다.
        unclassifiedMeshes++;const values=hide.array;values.fill(0);
        if(active){
          const worldX=new Float64Array(position.count),worldY=new Float64Array(position.count);
          for(let index=0;index<position.count;index++){
            point.fromBufferAttribute(position,index).applyMatrix4(object.matrixWorld);
            worldX[index]=point.x;worldY[index]=point.y;
            if(sample(point.x,point.y))values[index]=1;
          }
          const indices=geometry.index,cornerCount=indices?indices.count:position.count;
          for(let offset=0;offset+2<cornerCount;offset+=3){
            const a=indices?indices.getX(offset):offset,b=indices?indices.getX(offset+1):offset+1,
              c=indices?indices.getX(offset+2):offset+2;
            if(sample((worldX[a]+worldX[b]+worldX[c])/3,(worldY[a]+worldY[b]+worldY[c])/3))
              values[a]=values[b]=values[c]=1;
          }
          if(values.some(value=>value>.5))maskedUnclassifiedMeshes++;
        }
        hide.needsUpdate=true;return;
      }
      object.userData.vworldBatchAttribute=batch.name||"_batchid";
      if(active){
        const worldX=new Float64Array(position.count),worldY=new Float64Array(position.count);
        for(let index=0;index<position.count;index++){
          point.fromBufferAttribute(position,index).applyMatrix4(object.matrixWorld);
          worldX[index]=point.x;worldY[index]=point.y;
          if(sample(point.x,point.y))hidden.add(Math.round(batch.getX(index)));
        }
        // 지붕의 큰 삼각형 안에 DESIGN AREA가 들어가 꼭짓점 표본만으로 놓치는
        // 경우를 막기 위해 각 삼각면의 중심도 함께 검사한다.
        const indices=geometry.index,cornerCount=indices?indices.count:position.count;
        for(let offset=0;offset+2<cornerCount;offset+=3){
          const a=indices?indices.getX(offset):offset;
          const b=indices?indices.getX(offset+1):offset+1;
          const c=indices?indices.getX(offset+2):offset+2;
          const id=Math.round(batch.getX(a));
          if(hidden.has(id))continue;
          if(sample((worldX[a]+worldX[b]+worldX[c])/3,(worldY[a]+worldY[b]+worldY[c])/3))hidden.add(id);
        }
      }
      meshes.push({geometry,batch,hide});
    });
    for(const {batch,hide} of meshes){
      const values=hide.array;
      for(let index=0;index<hide.count;index++)values[index]=hidden.has(Math.round(batch.getX(index)))?1:0;
      hide.needsUpdate=true;
    }
    const stats={hiddenFeatures:hidden.size,batchMeshes:meshes.length,
      unclassifiedMeshes,maskedUnclassifiedMeshes};
    model.userData.vworldFeatureMaskStats=stats;
    return stats;
  }

  _updateMassDesignMask(data,selected,bounds){
    const ids=new Set([...(selected||[])].map(String));
    const chosen=(data.parcels||[]).filter(parcel=>ids.has(String(parcel.pnu||"")));
    const key=`${data.name}|${data._fingerprint||""}|${bounds.join("|")}|${[...ids].sort().join(",")}`;
    if(key===this._massMaskKey)return;
    this._massMaskKey=key;
    const size=1024,canvas=document.createElement("canvas");canvas.width=canvas.height=size;
    const ctx=canvas.getContext("2d"),[x0,y0,x1,y1]=bounds;
    const spanX=Math.max(.001,x1-x0),spanY=Math.max(.001,y1-y0);
    ctx.fillStyle="#000";ctx.fillRect(0,0,size,size);
    ctx.setTransform(size/spanX,0,0,-size/spanY,-x0*size/spanX,y1*size/spanY);
    ctx.fillStyle="#fff";ctx.strokeStyle="#fff";ctx.lineWidth=1.5;
    ctx.lineJoin="round";ctx.lineCap="round";
    const pathRing=ring=>{
      if(!ring?.length)return;
      ctx.moveTo(ring[0][0],ring[0][1]);
      for(let i=1;i<ring.length;i++)ctx.lineTo(ring[i][0],ring[i][1]);
      ctx.closePath();
    };
    for(const parcel of chosen)for(const polygon of polygonGroups(parcel)){
      ctx.beginPath();for(const ring of polygon)pathRing(ring);
      ctx.fill("evenodd");ctx.stroke();
    }
    ctx.setTransform(1,0,0,1,0,0);
    const texture=new THREE.CanvasTexture(canvas);
    texture.colorSpace=THREE.NoColorSpace;texture.wrapS=texture.wrapT=THREE.ClampToEdgeWrapping;
    texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=false;
    texture.name="DESIGN AREA 실물 매스 제외 마스크";
    this._massMaskTexture?.dispose();this._massMaskTexture=texture;
    this._massMaskPixels=ctx.getImageData(0,0,size,size).data;
    this._massMaskBounds.set(x0,y0,x1,y1);
    this._massMaskStats={selectedParcels:chosen.length,size,hiddenFeatures:0,batchMeshes:0,
      unclassifiedMeshes:0,maskedUnclassifiedMeshes:0};
    this._massTiles?.forEachLoadedModel(model=>{
      const stats=this._updateMassFeatureMask(model);
      this._massMaskStats.hiddenFeatures+=stats.hiddenFeatures;
      this._massMaskStats.batchMeshes+=stats.batchMeshes;
      this._massMaskStats.unclassifiedMeshes+=stats.unclassifiedMeshes;
      this._massMaskStats.maskedUnclassifiedMeshes+=stats.maskedUnclassifiedMeshes;
      model.traverse(object=>{
        if(!object.isMesh)return;
        this._applyMassMaterial(object.userData.vworldMappedMaterial||object.material);
        this._applyMassMaterial(object.userData.vworldPlainMaterial);
      });
    });
  }

  _prepareMassModel(model,state){
    const shadow=layerOf(state,"shadow"),mass=layerOf(state,"renderMass");
    const massShadows=!!shadow.on&&!!shadow.fillOn;
    const massOpacityValue=Number(mass.op);
    const massOpacity=Math.max(0,Math.min(1,(Number.isFinite(massOpacityValue)?massOpacityValue:100)/100));
    const featureStats=this._updateMassFeatureMask(model);
    this._massMaskStats.hiddenFeatures=(this._massMaskStats.hiddenFeatures||0)+featureStats.hiddenFeatures;
    this._massMaskStats.batchMeshes=(this._massMaskStats.batchMeshes||0)+featureStats.batchMeshes;
    this._massMaskStats.unclassifiedMeshes=(this._massMaskStats.unclassifiedMeshes||0)+featureStats.unclassifiedMeshes;
    this._massMaskStats.maskedUnclassifiedMeshes=(this._massMaskStats.maskedUnclassifiedMeshes||0)+featureStats.maskedUnclassifiedMeshes;
    model.traverse(object=>{
      if(!object.isMesh)return;
      if(!object.userData.vworldMappedMaterial){
        object.userData.vworldSourceMaterial=object.material;
        object.userData.vworldMappedMaterial=this._massMappedMaterial(object.material);
        object.userData.vworldPlainMaterial=this._massMaterial(object.material);
        object.userData.vworldDepthMaterial=this._massDepthMaterial();
      }
      this._applyMassMaterial(object.userData.vworldMappedMaterial);
      this._applyMassMaterial(object.userData.vworldPlainMaterial);
      this._applyMassOpacity(object.userData.vworldMappedMaterial,mass.op??100);
      this._applyMassOpacity(object.userData.vworldPlainMaterial,mass.op??100);
      object.material=this._massMapping
        ?object.userData.vworldMappedMaterial:object.userData.vworldPlainMaterial;
      object.customDepthMaterial=massShadows?object.userData.vworldDepthMaterial:null;
      object.castShadow=massShadows&&massOpacity>.001;
      object.receiveShadow=massShadows;
      object.userData.diagramVWorldMass=true;
      object.userData.diagramLayerId="renderMass";
      object.userData.diagramLayerOffset=0;
      object.renderOrder=layerRenderOrder(state,"renderMass");
    });
  }

  _disposeMassModel(model){
    model.traverse(object=>{
      if(!object.isMesh)return;
      const source=object.userData.vworldSourceMaterial;
      const mapped=object.userData.vworldMappedMaterial;
      if(source)object.material=source;
      object.userData.vworldPlainMaterial?.dispose?.();
      object.userData.vworldDepthMaterial?.dispose?.();
      if(mapped&&mapped!==source){
        const list=Array.isArray(mapped)?mapped:[mapped];
        for(const material of list)if(!Array.isArray(source)||!source.includes(material))material?.dispose?.();
      }
      delete object.userData.vworldSourceMaterial;
      delete object.userData.vworldPlainMaterial;
      delete object.userData.vworldDepthMaterial;
      delete object.userData.vworldMappedMaterial;
      if(object.userData.diagramSectionBaseVisible!==undefined)
        object.visible=object.userData.diagramSectionBaseVisible;
      delete object.userData.diagramSectionBaseVisible;
      delete object.userData.diagramSectionHidden;
      object.customDepthMaterial=null;
    });
  }

  _ensureMassDecoder(){
    if(this._massDecoderPaths&&this._massKtx2Path)return true;
    if(!this._massDecoderPromise){
      const local=[...Object.values(DRACO_LOCAL),KTX2_LOCAL.js,KTX2_LOCAL.wasm];
      this._massDecoderPromise=Promise.all(local.map(url=>
        fetch(url,{cache:"no-store"}).then(response=>{
          if(!response.ok)throw new Error(`${url}: ${response.status}`);
          return response.arrayBuffer();
        })
      )).then(()=>({draco:DRACO_LOCAL,ktx2:KTX2_LOCAL.path}))
        .catch(()=>({draco:DRACO_CDN,ktx2:KTX2_CDN.path})).then(decoders=>{
        this._massDecoderPaths=decoders.draco;this._massKtx2Path=decoders.ktx2;
        this._massDecoderPromise=null;
        this._scheduleMassRender();
      });
    }
    this._setMassStatus("VWorld 실물 매스 형상·텍스처 압축 해제기를 준비하는 중…");
    return false;
  }

  _configureMassLoadCameras(bounds){
    const [x0,y0,x1,y1]=bounds,cx=(x0+x1)/2,cy=(y0+y1)/2;
    const spanX=Math.max(2,x1-x0),spanY=Math.max(2,y1-y0);
    // 한 장의 큰 정사영 카메라는 화면오차가 CONTEXT 전체 폭으로 계산되어,
    // 외곽 구역의 세부 건물 타일이 선택되지 않는 경우가 있다. 약 450 m 단위로
    // 나눈 고정 카메라들의 합집합을 사용해 모든 구역을 같은 정밀도로 수집한다.
    const cols=Math.max(1,Math.min(4,Math.ceil(spanX/600)));
    const rows=Math.max(1,Math.min(4,Math.ceil(spanY/600)));
    const cellX=spanX/cols,cellY=spanY/rows;
    const overlap=Math.max(10,Math.min(cellX,cellY)*.08),cameras=[];
    for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
      const px=x0+(col+.5)*cellX,py=y0+(row+.5)*cellY;
      const camera=new THREE.OrthographicCamera(
        -cellX/2-overlap,cellX/2+overlap,cellY/2+overlap,-cellY/2-overlap,.1,50000);
      camera.position.set(px,py,10000);camera.up.set(0,1,0);camera.lookAt(px,py,0);
      camera.updateProjectionMatrix();camera.updateMatrixWorld(true);cameras.push(camera);
    }
    this._massLoadCameras=cameras;
    this._massLoadCamera=cameras[Math.floor(cameras.length/2)]||new THREE.OrthographicCamera(-1,1,1,-1,.1,50000);
    this._massLoadBoundsKey=bounds.map(value=>Number(value).toFixed(3)).join("|");
  }

  _massLoadSnapshot(tiles){
    let models=0;tiles.forEachLoadedModel(()=>models++);
    const stats=tiles.stats||{};
    const pending=(stats.queued||0)+(stats.downloading||0)+(stats.parsing||0)+
      (tiles.queuedTiles?.length||0)+(tiles.loadingTiles?.size||0);
    const running=!!(tiles.downloadQueue?.running||tiles.parseQueue?.running||tiles.processNodeQueue?.running);
    const cached=tiles.lruCache?.itemSet?.size||0;
    // traversed / inFrustum / visible 통계는 같은 고정 카메라에서도 REPLACE 타일의
    // 표시 전환 때문에 흔들릴 수 있다. 실제 데이터 구조 변화만 완료 판정에 쓴다.
    const signature=[models,this._massModelRevision,cached,stats.failed||0,
      pending,running?1:0,tiles.rootTileset?1:0].join("|");
    return {models,cached,pending,running,signature,visible:stats.visible||tiles.visibleTiles?.size||0};
  }

  _massMeshCount(tiles){
    let meshes=0;tiles.forEachLoadedModel(model=>model.traverse(object=>{if(object.isMesh)meshes++;}));
    return meshes;
  }

  _trackMassCompletion(tiles,bounds,state){
    if(this._massLocked)return;
    const now=performance.now(),snapshot=this._massLoadSnapshot(tiles);
    const idle=!!tiles.rootTileset&&snapshot.models>0&&snapshot.pending===0&&!snapshot.running;
    if(snapshot.signature!==this._massStableSignature||!idle){
      this._massStableSignature=snapshot.signature;this._massStableSince=now;
    }
    // 외부 tileset JSON이 잠깐 쉬었다가 다음 묶음을 여는 경우가 있으므로 큐가 빈
    // 순간이 아니라, 구조·모델·가시 타일이 6초 동안 모두 그대로일 때만 고정한다.
    const stableFor=idle?now-this._massStableSince:0;
    if(idle&&now-this._massStartedAt>=6500&&stableFor>=6000){
      this._massFrozen=true;this._massLocked=true;this._massLoading=false;this._massProgress=100;
      this._ensureMassCaps(tiles,bounds,state);
      const excluded=this._massMaskStats.selectedParcels,meshes=this._massMeshCount(tiles);
      this._setMassStatus(`CONTEXT 전체 로드 완료 · 모델 ${snapshot.models.toLocaleString()}개 · 메시 ${meshes.toLocaleString()}개 · 고정 카메라 ${this._massLoadCameras.length}개${excluded?` · DESIGN AREA ${excluded}필지 제외`:""}`);
      return;
    }
    this._massLoading=true;
    const queueProgress=Math.max(0,Math.min(1,tiles.loadProgress||0));
    const timeProgress=Math.min(1,Math.max(0,stableFor/6000));
    this._massProgress=Math.max(this._massProgress,1,
      Math.min(99,Math.floor((queueProgress*.75+timeProgress*.24)*100)));
    const phase=idle?"누락 타일 확인 중":"타일 수집 중";
    this._setMassStatus(`CONTEXT 전체 ${phase}… ${this._massProgress}% · 모델 ${snapshot.models.toLocaleString()}개 · 카메라 ${this._massLoadCameras.length}개`);
  }

  _ensureMassTiles(data,state,bounds,selected){
    const center=data.center||[];
    const lat=+center[0],lon=+center[1];
    if(!Number.isFinite(lat)||!Number.isFinite(lon)){
      this._setMassStatus("대상지 중심 좌표가 없어 VWorld 실물 매스를 맞출 수 없습니다.","error");
      return null;
    }
    if(!this._ensureMassDecoder())return null;
    const boundsKey=bounds.map(value=>Number(value).toFixed(3)).join("|");
    const sceneKey=`${data.name}|${lat.toFixed(8)}|${lon.toFixed(8)}|${boundsKey}`;
    if(this._massTiles&&this._massSceneKey===sceneKey)return this._massTiles;
    this._disposeMassTiles();
    // 첫 타일이 장면에 붙기 전에 DESIGN AREA 마스크부터 확정한다. 이전에는
    // 타일셋을 먼저 추가해 초기 저해상도 건물이 한 프레임 보일 수 있었다.
    this._updateMassDesignMask(data,selected,bounds);
    const tiles=new TilesRenderer(VWORLD_REAL_BUILDINGS);
    // VWorld b3dm 안의 형상은 Draco, 외벽·지붕 텍스처는 KTX2(Basis)로
    // 압축되어 있다. 두 디코더가 같은 GLTFLoader에 연결되어야 실물 매핑까지 열린다.
    const draco=new DRACOLoader(tiles.manager);draco.setDecoderPath(this._massDecoderPaths);
    const ktx2=new KTX2Loader(tiles.manager).setTranscoderPath(this._massKtx2Path);
    ktx2.detectSupport(this.renderer);
    const gltf=new GLTFLoader(tiles.manager);gltf.setDRACOLoader(draco);gltf.setKTX2Loader(ktx2);
    tiles.manager.addHandler(/\.(?:gltf|glb)$/i,gltf);
    tiles.manager.addHandler(/\.drc$/i,draco);
    tiles.manager.addHandler(/\.ktx2$/i,ktx2);
    this._massDraco=draco;this._massKtx2=ktx2;
    tiles.group.name="VWorld 실물 매스 · 지정 범위";
    tiles.group.userData.diagramExternalTiles=true;
    tiles.group.visible=false;
    tiles.group.matrix.copy(ecefToLocalMatrix(lat,lon));
    tiles.group.matrixAutoUpdate=false;tiles.group.updateMatrixWorld(true);
    this._configureMassLoadCameras(bounds);
    for(const camera of this._massLoadCameras)tiles.setCamera(camera);
    // 고정 CONTEXT를 모으는 동안 카메라별로 읽은 타일이 LRU 한도 때문에 서로
    // 밀어내지 않도록 한다. 잠근 뒤에는 update 자체를 멈춰 네트워크와 메모리가 고정된다.
    tiles.lruCache.maxSize=Infinity;tiles.lruCache.maxBytesSize=Infinity;
    tiles.downloadQueue.maxJobsPerOrigin=Math.max(32,tiles.downloadQueue.maxJobsPerOrigin||0);
    tiles.parseQueue.maxJobs=Math.max(8,tiles.parseQueue.maxJobs||0);
    tiles.processNodeQueue.maxJobs=Math.max(64,tiles.processNodeQueue.maxJobs||0);
    tiles.maxTilesProcessed=800;
    tiles.fetchOptions={mode:"cors",credentials:"omit"};
    tiles.addEventListener("load-model",event=>{
      this._massModelRevision++;
      // TilesRenderer가 모델을 장면에 연결한 상태로 이벤트를 보내므로, 제외 속성·
      // 그림자 재질을 모두 붙이기 전에는 해당 모델을 렌더하지 않는다.
      const visible=event.scene.visible;event.scene.visible=false;
      this._prepareMassModel(event.scene,state);
      event.scene.userData.diagramVWorldPrepared=true;
      event.scene.visible=visible;
      this._scheduleMassRender();
    });
    tiles.addEventListener("dispose-model",event=>{
      this._massModelRevision++;
      this._disposeMassModel(event.scene);
      this._scheduleMassRender();
    });
    tiles.addEventListener("tiles-load-start",()=>{
      if(!tiles.group.visible)return;
      if(this._massLocked)return;
      this._massFrozen=false;this._massLoading=true;this._massProgress=Math.max(0,this._massProgress);
      this._setMassStatus("CONTEXT 전체의 VWorld 실물 매스를 고정 수집하는 중…");
      this._scheduleMassRender();
    });
    tiles.addEventListener("tiles-load-end",()=>{
      // load-end 하나만으로 완료 처리하지 않는다. 외부 타일셋 사이의 짧은 유휴도
      // 같은 이벤트를 내므로 매 프레임 전체 큐와 모델 구조를 함께 안정화한다.
      this._massLoading=true;
      this._scheduleMassRender();
    });
    tiles.addEventListener("needs-update",()=>this._scheduleMassRender());
    tiles.addEventListener("load-error",event=>{
      console.error("VWorld 3D Tiles:",event.error||event);
      this._massLoading=false;
      if(!tiles.group.visible)return;
      const detail=event.error?.message||String(event.error||"");
      const url=String(event.url||"").replace(/^https?:\/\/[^/]+/i,"");
      const suffix=[detail,url].filter(Boolean).join(" · ");
      this._setMassStatus(`VWorld 실물 매스를 불러오지 못했습니다.${suffix?` ${suffix}`:""}`,"error");
      this._scheduleMassRender();
    });
    this._massTiles=tiles;this._massSceneKey=sceneKey;
    this._massStartedAt=performance.now();this._massStableSince=this._massStartedAt;
    this._massStableSignature="";this._massLoading=true;this._massProgress=0;
    this.scene.add(tiles.group);
    this._setMassStatus("VWorld 실물 매스 타일셋에 연결하는 중…");
    return tiles;
  }

  _applyMassSectionVisibility(tiles,data,state){
    const definition=sectionDefinition(data,state);
    const key=definition
      ?`${this._massSceneKey}|${definition.nx.toFixed(5)}|${definition.ny.toFixed(5)}|${definition.offset.toFixed(3)}|${this._massModelRevision}`
      :`off|${this._massModelRevision}`;
    if(key===this._massSectionKey)return;
    this._massSectionKey=key;tiles.group.updateWorldMatrix(true,true);
    const box=new THREE.Box3();
    tiles.forEachLoadedModel(model=>{
      model.updateWorldMatrix(true,true);
      model.traverse(object=>{
        if(!object.isMesh)return;
        if(object.userData.diagramSectionBaseVisible===undefined)
          object.userData.diagramSectionBaseVisible=object.visible!==false;
        const baseVisible=object.userData.diagramSectionBaseVisible;
        object.userData.diagramSectionHidden=false;object.visible=baseVisible;
        if(!definition||!baseVisible)return;
        box.makeEmpty().setFromObject(object,true);
        if(box.isEmpty())return;
        const {nx,ny,offset}=definition;
        const maxProjection=Math.max(
          box.min.x*nx+box.min.y*ny,box.min.x*nx+box.max.y*ny,
          box.max.x*nx+box.min.y*ny,box.max.x*nx+box.max.y*ny);
        // 실물 매스도 반대쪽을 표시한다. 경계에 걸린 메시 자체는 자르지 않는다.
        object.userData.diagramSectionHidden=maxProjection<=offset-.05;
        object.visible=!object.userData.diagramSectionHidden;
      });
    });
  }

  _updateMassTiles(data,state,w,h,selected){
    const layer=layerOf(state,"renderMass");
    if(!layer.on){
      this._massLoading=false;
      if(this._massTiles)this._massTiles.group.visible=false;
      if(this._massCapGroup)this._massCapGroup.visible=false;
      this._setMassStatus("필요할 때 지정 범위의 VWorld 실물 매스를 불러옵니다.");
      return;
    }
    const bounds=(data.context_bounds||[-data.radius,-data.radius,data.radius,data.radius]).map(Number);
    const tiles=this._ensureMassTiles(data,state,bounds,selected);if(!tiles)return;
    this._massMapping=layer.mapping!==false;
    const clipKey=bounds.map(value=>value.toFixed(3)).join("|");
    if(clipKey!==this._massClipKey){
      this._massClipKey=clipKey;this._massClipPlanes=clippingPlanesFor(bounds);
    }
    this._updateMassDesignMask(data,selected,bounds);
    // 마스크와 현재 표시 재질이 준비된 뒤에만 타일셋을 공개한다.
    tiles.group.visible=true;
    const shadow=layerOf(state,"shadow"),massShadows=!!shadow.on&&!!shadow.fillOn;
    const appearanceKey=`${clipKey}|${this._massMapping}|${massShadows}|${layer.op??100}|${layerRenderOrder(state,"renderMass")}`;
    if(appearanceKey!==this._massAppearanceKey){
      this._massAppearanceKey=appearanceKey;
      tiles.forEachLoadedModel(model=>this._prepareMassModel(model,state));
    }
    this._applyMassSectionVisibility(tiles,data,state);
    this._ensureMassCaps(tiles,bounds,state);
    // 구역별 카메라의 합산 픽셀 밀도를 기존 품질과 맞춘다. 영역을 나눴다는 이유로
    // 필요 없는 초고해상도 LOD까지 수천 장 요청하지 않게 한다.
    tiles.errorTarget={standard:28,high:12,final:5}[state.renderQuality]||12;
    const resolution={standard:512,high:768,final:1024}[state.renderQuality]||768;
    // 100% 이후에는 네트워크 선택뿐 아니라 LRU의 모델 unload도 멈춘다.
    // 그래야 같은 CONTEXT라도 시점 회전 뒤 보이는 건물 수가 미세하게 바뀌지 않는다.
    if(!this._massLocked){
      if(this._massLoadBoundsKey!==clipKey)this._configureMassLoadCameras(bounds);
      for(const camera of this._massLoadCameras){
        tiles.setResolution(camera,resolution,resolution);camera.updateMatrixWorld(true);
      }
      tiles.group.updateMatrixWorld(true);
      tiles.update();
      this._trackMassCompletion(tiles,bounds,state);
    }
  }

  async _parseBuildingModel(file,buffer){
    const name=file?.name||"사용자 모델.glb",isRhino=/\.3dm$/i.test(name);
    let source;
    if(isRhino){
      source=await new Promise((resolve,reject)=>this._rhinoLoader.parse(buffer.slice(0),resolve,reject));
    }else{
      const gltf=await this._modelLoader.parseAsync(buffer,"");source=gltf.scene;
    }
    if(!source)throw new Error(`${isRhino?"3DM":"GLB"} 장면을 읽지 못했습니다.`);
    const oriented=new THREE.Group();oriented.name=`가져온 ${isRhino?"3DM":"GLB"}`;oriented.add(source);
    // glTF는 Y-up, Rhino는 Z-up이다. 내부 장면은 Z-up으로 통일한다.
    if(!isRhino)source.rotation.x+=Math.PI/2;
    oriented.updateMatrixWorld(true);
    let meshCount=0;oriented.traverse(object=>{if(object.isMesh){meshCount++;object.castShadow=true;object.receiveShadow=true;}});
    if(!meshCount)throw new Error(isRhino
      ?"3DM에 표시할 렌더 메시가 없습니다. Rhino에서 Shaded 또는 Rendered 화면으로 한 번 연 뒤 저장해 주세요."
      :"GLB 안에 표시할 메시가 없습니다.");
    const bounds=new THREE.Box3().setFromObject(oriented);
    if(bounds.isEmpty())throw new Error(`${isRhino?"3DM":"GLB"}의 모델 범위를 계산하지 못했습니다.`);
    const size=bounds.getSize(new THREE.Vector3()),baseAnchor=modelBaseAnchor(oriented,bounds);
    // 배치 위치는 바깥 그룹에, 원본 기준점 보정은 안쪽 그룹에 둔다. 한 그룹의
    // position에 둘 다 기록하면 _applyBuildingPlacement의 position.set()이
    // -baseAnchor 이동을 덮어써 실제 모델만 원점만큼 어긋난다.
    oriented.position.sub(new THREE.Vector3(baseAnchor.x,baseAnchor.y,baseAnchor.z));oriented.updateMatrixWorld(true);
    const normalized=new THREE.Group();normalized.name=`바닥 중심 정규화 · ${isRhino?"3DM":"GLB"}`;
    normalized.add(oriented);normalized.updateMatrixWorld(true);
    return {scene:normalized,name,format:isRhino?"3DM":"GLB",sourceSize:[size.x,size.y,size.z],meshCount,
      sourceAnchor:[baseAnchor.x,baseAnchor.y,baseAnchor.z],sourceAnchorMethod:baseAnchor.method,
      sourceFootprint:baseAnchor.footprint};
  }

  _buildingTarget(key,context={}){
    const data=context.data||this._lastRenderArgs?.[0],state=context.state||this._lastRenderArgs?.[1];
    if(!data||!state)return null;
    let building=context.building||null,index=Number.isInteger(context.index)?context.index:-1;
    if(!building){
      index=(data.buildings||[]).findIndex((candidate,candidateIndex)=>buildingKey(data,candidate,candidateIndex)===key);
      building=index>=0?data.buildings[index]:null;
    }
    const bounds=building&&buildingBounds(building);if(!building||!bounds)return null;
    const base=terrainDisplayZ(data,state,building.base||0)*state.vScale;
    return {building,index,bounds,centroid:buildingFootprintCentroid(building),base,
      height:Math.max(1,building.floors||1)*state.floorH};
  }

  async loadBuildingModel(key,file,context={}){
    if(!key)throw new Error("모델 저장 위치를 정하지 못했습니다.");
    const buffer=file instanceof ArrayBuffer?file:await file.arrayBuffer();
    const entry=await this._parseBuildingModel(file,buffer),target=this._buildingTarget(key,context);
    const size=entry.sourceSize,bounds=target?.bounds,footprint=entry.sourceFootprint||[];
    let footprintWidth=size[0],footprintDepth=size[1];
    if(footprint.length){
      const xs=footprint.map(point=>point[0]),ys=footprint.map(point=>point[1]);
      footprintWidth=Math.max(.001,Math.max(...xs)-Math.min(...xs));
      footprintDepth=Math.max(.001,Math.max(...ys)-Math.min(...ys));
    }
    const width=bounds?Math.max(.25,bounds.x1-bounds.x0):Math.max(.25,size[0]);
    const depth=bounds?Math.max(.25,bounds.y1-bounds.y0):Math.max(.25,size[1]);
    const fit=context.fitToTarget===false?1:
      Math.max(.0001,Math.min(1e4,Math.min(width/footprintWidth,depth/footprintDepth)));
    const initial=context.placement||{};
    entry.placement={
      x:Number.isFinite(+initial.x)?+initial.x:(target?.centroid?.x??(bounds?(bounds.x0+bounds.x1)/2:0)),
      y:Number.isFinite(+initial.y)?+initial.y:(target?.centroid?.y??(bounds?(bounds.y0+bounds.y1)/2:0)),
      z:Number.isFinite(+initial.z)?+initial.z:(target?.base||0),
      zOffset:Number.isFinite(+initial.zOffset)?+initial.zOffset:0,
      rotation:Number.isFinite(+initial.rotation)?+initial.rotation:0,
      scale:Number.isFinite(+initial.scale)?Math.max(.0001,+initial.scale):fit,
    };
    const previous=this._buildingModels.get(key)||null;
    this._buildingModels.set(key,entry);this._modelVersion++;this._signature="";
    return {name:entry.name,format:entry.format,size:[...size],meshCount:entry.meshCount,
      placement:{...entry.placement},initialPlacement:{...entry.placement},_entry:entry,_previous:previous,key};
  }

  _applyBuildingPlacement(object,entry){
    const placement=entry?.placement||{};
    object.position.set(+placement.x||0,+placement.y||0,(+placement.z||0)+(+placement.zOffset||0));
    object.rotation.set(0,0,(+placement.rotation||0)*RAD);
    const scale=Math.max(.0001,+placement.scale||1);object.scale.setScalar(scale);
    object.updateMatrixWorld(true);
  }

  setBuildingModelPlacement(key,patch={}){
    const entry=this._buildingModels.get(key);if(!entry)return null;
    for(const field of ["x","y","zOffset","rotation","scale"]){
      if(Number.isFinite(+patch[field]))entry.placement[field]=field==="scale"?Math.max(.0001,+patch[field]):+patch[field];
    }
    const instance=this._buildingModelInstances.get(key);if(instance)this._applyBuildingPlacement(instance,entry);
    return {...entry.placement};
  }

  buildingModelInfo(key){
    const entry=this._buildingModels.get(key);return entry?{
      name:entry.name,format:entry.format,size:[...entry.sourceSize],meshCount:entry.meshCount,
      sourceAnchor:[...(entry.sourceAnchor||[0,0,0])],anchorMethod:entry.sourceAnchorMethod||"bounds",
      footprint:(entry.sourceFootprint||[]).map(point=>[...point]),
      placement:{...entry.placement},
    }:null;
  }

  commitBuildingModelLoad(transaction){
    if(!transaction?._entry||this._buildingModels.get(transaction.key)!==transaction._entry)return false;
    if(transaction._previous&&transaction._previous!==transaction._entry)disposeTree(transaction._previous.scene);
    transaction._previous=null;return true;
  }

  cancelBuildingModelLoad(transaction){
    if(!transaction?._entry||this._buildingModels.get(transaction.key)!==transaction._entry)return false;
    disposeTree(transaction._entry.scene);
    if(transaction._previous)this._buildingModels.set(transaction.key,transaction._previous);
    else this._buildingModels.delete(transaction.key);
    this._modelVersion++;this._signature="";return true;
  }

  removeBuildingModel(key){
    const model=this._buildingModels.get(key);if(!model)return false;
    disposeTree(model.scene);this._buildingModels.delete(key);this._buildingModelInstances.delete(key);
    this._modelVersion++;this._signature="";return true;
  }

  hasBuildingModel(key){return !!key&&this._buildingModels.has(key);}

  clearBuildingModels(){
    for(const model of this._buildingModels.values())disposeTree(model.scene);
    this._buildingModels.clear();this._buildingModelInstances.clear();this._modelVersion++;this._signature="";
  }

  pickBuilding(x,y){
    if(!this._pickers.length)return null;
    const rect=this.canvas.getBoundingClientRect();
    this._raycaster.setFromCamera(new THREE.Vector2(x/rect.width*2-1,-(y/rect.height)*2+1),this.camera);
    const hit=this._raycaster.intersectObjects(this._pickers,false)[0];
    return hit?{...hit.object.userData.buildingPick}:null;
  }

  _chosenParcels(data,selected){
    const ids=new Set([...(selected||[])].map(String));
    return (data?.parcels||[]).filter(parcel=>ids.has(String(parcel.pnu||"")));
  }

  _paintWorldPolygons(ctx,parcels,radius,width,height){
    if(!parcels?.length||!radius)return;
    ctx.save();ctx.setTransform(width/(2*radius),0,0,-height/(2*radius),width/2,height/2);
    const pathRing=ring=>{
      if(!ring?.length)return;
      ctx.moveTo(ring[0][0],ring[0][1]);
      for(let index=1;index<ring.length;index++)ctx.lineTo(ring[index][0],ring[index][1]);
      ctx.closePath();
    };
    for(const parcel of parcels)for(const polygon of polygonGroups(parcel)){
      ctx.beginPath();for(const ring of polygon)pathRing(ring);ctx.fill("evenodd");
    }
    ctx.restore();
  }

  makeDesignGroundMask(data,selected,size=1024){
    const parcels=this._chosenParcels(data,selected);if(!parcels.length)return null;
    const canvas=document.createElement("canvas");canvas.width=canvas.height=size;
    const ctx=canvas.getContext("2d");ctx.fillStyle="#000";ctx.fillRect(0,0,size,size);
    ctx.fillStyle="#fff";this._paintWorldPolygons(ctx,parcels,data.radius,size,size);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.NoColorSpace;
    texture.wrapS=texture.wrapT=THREE.ClampToEdgeWrapping;
    texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=false;
    texture.name="DESIGN AREA 지형면 마스크";return texture;
  }

  makeTexture(image, strength, baseColor, exclude=null) {
    if (!image) return null;
    // 위성사진 레이어의 '투명'은 메시 자체를 비치는 값이 아니라 매핑 강도다.
    // 바탕 재질과 사진을 먼저 섞어 두면 2D 벡터 미리보기와 같은 결과가 난다.
    const cv=document.createElement("canvas");
    const t=new THREE.CanvasTexture(cv);t.userData.diagramBlend={strength,baseColor,exclude};
    this.paintTexture(t,image);t.colorSpace=THREE.SRGBColorSpace;
    t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;t.minFilter=THREE.LinearMipmapLinearFilter;
    t.anisotropy=Math.min(8,this.renderer.capabilities.getMaxAnisotropy());
    t.name="위성사진";return t;
  }

  /** 레벨 드래그는 메시를 다시 만들지 않고 기존 재질의 캔버스 텍스처만 바꾼다. */
  paintTexture(texture,image){
    const meta=texture.userData.diagramBlend,cv=texture.image;
    if(!meta)return;
    const w=image.naturalWidth||image.width,h=image.naturalHeight||image.height;
    if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h;}
    const ctx=cv.getContext("2d");ctx.globalAlpha=1;ctx.fillStyle=meta.baseColor;
    ctx.fillRect(0,0,w,h);ctx.globalAlpha=Math.max(0,Math.min(1,meta.strength));
    ctx.drawImage(image,0,0,w,h);ctx.globalAlpha=1;
    if(meta.exclude?.parcels?.length){
      ctx.fillStyle=meta.baseColor;
      this._paintWorldPolygons(ctx,meta.exclude.parcels,meta.exclude.radius,w,h);
    }
    texture.needsUpdate=true;
  }

  refreshTextures(image){
    if(!image)return;
    for(const texture of this._textures)this.paintTexture(texture,image);
  }

  signature(data,state,image,selected){
    const style=(state.layers||[]).filter(L=>["renderMass","ground","designGround","bldg","designBldg","parcel","contour"].includes(L.id))
      .map(L=>{
        if(L.id!=="ground")return L;
        // 톤 값은 텍스처만 바꾼다. 형상 재생성 서명에서는 제외한다.
        const {gamma,contrast,black,white,...stable}=L;return stable;
      });
    const section=state.section?.on?{
      on:true,az:Math.round((+state.section.az||0)*10)/10,
      position:Math.round((+state.section.position||0)*10)/10,color:state.section.color,
    }:{on:false};
    return JSON.stringify([data.name,data._fingerprint,data.radius,state.floorH,state.vScale,state.groundDepth,state.terrainMode,
      state.renderMode,state.outline,(state.layers||[]).map(layer=>layer.id),style,image&&image.src,[...selected].sort(),
      [...(state.selectedBuildings||[])].sort(),[...(state.removedBuildings||[])].sort(),section,this._modelVersion]);
  }

  rebuild(data,state,image,selected) {
    disposeTree(this.root);this.scene.remove(this.root);this.root=new THREE.Group();
    this.root.name="사이트 모델";this.scene.add(this.root);
    for(const t of this._textures)t.dispose();this._textures=[];
    // 렌더 프리셋이 위성 모드여도 레이어의 끄기 상태가 최종 권한을 가진다.
    this._pickers=[];this._buildingModelInstances.clear();
    const groundL=layerOf(state,"ground"),designGroundL=layerOf(state,"designGround");
    const bldgL=layerOf(state,"bldg"),designL=layerOf(state,"designBldg");
    const groundMapped=!!(groundL.on&&groundL.aerialMap!==false&&image);
    const strength=(groundL.mapOpacity??85)/100;
    const designParcels=this._chosenParcels(data,selected);
    const textureFor=(id,mapStrength=strength,enabled=true,exclude=null)=>{
      if(!enabled||!image)return null;
      const L=layerOf(state,id),base=colorFor(state.renderMode,id,L,false).getStyle();
      const t=this.makeTexture(image,mapStrength,base,exclude);this._textures.push(t);return t;
    };
    const groundAerial=textureFor("ground",strength,groundMapped,
      {parcels:designParcels,radius:data.radius});

    if(groundL.on){
      const geo=terrainGeometry(data,state);
      if(geo){
        if(groundL.fillOn||groundAerial){
          const mesh=new THREE.Mesh(geo,meshMaterial(state,"ground",false,groundAerial));
          mesh.name="지형 · 대지";mesh.receiveShadow=true;
          mesh.userData.diagramSectionClip=true;
          assignLayerOrder(mesh,state,"ground");this.root.add(mesh);
        }
        if(state.outline&&groundL.strokeOn!==false&&groundL.w>0){
          const wire=thickLineSegments(new THREE.WireframeGeometry(geo),groundL,"#aaa292",.45);
          if(wire){wire.name="지형 삼각망 선";wire.userData.diagramSectionClip=true;
            assignLayerOrder(wire,state,"ground",2);this.root.add(wire);}
        }
        const slabGeo=terrainSlabGeometry(data,state);
        if(slabGeo&&groundL.fillOn){
          const slab=new THREE.Mesh(slabGeo,meshMaterial(state,"ground",false,null));
          slab.name="대지 절단면";slab.receiveShadow=true;
          slab.userData.diagramSectionClip=true;
          assignLayerOrder(slab,state,"ground");this.root.add(slab);
        }
      }
    }

    const selectedBuildings=state.selectedBuildings instanceof Set?state.selectedBuildings:
      new Set(state.selectedBuildings||[]);
    const replaced=new Set(),removed=state.removedBuildings instanceof Set
      ?state.removedBuildings:new Set(state.removedBuildings||[]);
    for(const [buildingIndex,building] of (data.buildings||[]).entries()){
      const key=buildingKey(data,building,buildingIndex);
      if(selected.has(building.pnu)&&(this._buildingModels.has(key)||removed.has(key)))replaced.add(key);
    }
    const sectionHidden=sectionHiddenBuildings(data,state,selected);
    for(const chosen of [false,true]){
        const L=chosen?designL:bldgL,layerId=chosen?"designBldg":"bldg";
        if(!L.on)continue;
        const skipped=chosen?replaced:new Set([...replaced,...sectionHidden]);
        const wallGeo=mergedWalls(data,state,selected,chosen,skipped);
        const roofGeo=mergedRoofs(data,state,selected,chosen,skipped);
        if(!wallGeo&&!roofGeo)continue;
        if(wallGeo){
          const wallMat=meshMaterial(state,layerId,false,null);
          wallMat.side=THREE.DoubleSide;
          if(!L.fillOn){wallMat.colorWrite=false;wallMat.depthWrite=false;}
          const wall=new THREE.Mesh(wallGeo,wallMat);
          wall.userData.diagramGeneratedBuilding=true;
          wall.userData.diagramBuildingLayer=layerId;
          wall.userData.diagramBuildingSurface="wall";
          wall.name=chosen?"DESIGN AREA 건물 벽":"건물 벽";
          wall.castShadow=true;wall.receiveShadow=true;
          assignLayerOrder(wall,state,layerId);this.root.add(wall);
        }
        if(roofGeo){
          const roofMat=meshMaterial(state,layerId,false,null);
          if(!L.fillOn){roofMat.colorWrite=false;roofMat.depthWrite=false;}
          const roof=new THREE.Mesh(roofGeo,roofMat);
          roof.userData.diagramGeneratedBuilding=true;
          roof.userData.diagramBuildingLayer=layerId;
          roof.userData.diagramBuildingSurface="roof";
          roof.name=chosen?"DESIGN AREA 건물 지붕":"건물 지붕";
          roof.castShadow=true;roof.receiveShadow=true;
          assignLayerOrder(roof,state,layerId);this.root.add(roof);
        }
        if(state.outline&&L.strokeOn!==false&&L.w>0){
          for(const [geo,name] of [[wallGeo,"벽"],[roofGeo,"지붕"]])if(geo){
            const edge=thickLineSegments(new THREE.EdgesGeometry(geo,25),L,"#3c4048");
            if(edge){edge.name=(chosen?"DESIGN AREA ":"")+`건물 ${name} 외곽선`;
              assignLayerOrder(edge,state,layerId,3);this.root.add(edge);}
          }
        }
    }

    // DESIGN AREA 건물은 개별 선택용 박스를 따로 둔다. 렌더에는 보이지 않지만
    // raycaster에는 잡히므로 통합 메시를 유지하면서도 건물 하나를 고를 수 있다.
    for(const [index,building] of (data.buildings||[]).entries()){
      if(!selected.has(building.pnu))continue;
      const bounds=buildingBounds(building);if(!bounds)continue;
      const key=buildingKey(data,building,index),base=terrainDisplayZ(data,state,building.base||0)*state.vScale;
      const height=Math.max(1,building.floors||1)*state.floorH;
      const width=Math.max(.25,bounds.x1-bounds.x0),depth=Math.max(.25,bounds.y1-bounds.y0);
      const pickerGeometry=new THREE.BoxGeometry(width,depth,height);
      const pickerMaterial=new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false,colorWrite:false});
      const picker=new THREE.Mesh(pickerGeometry,pickerMaterial);
      picker.position.set((bounds.x0+bounds.x1)/2,(bounds.y0+bounds.y1)/2,base+height/2);
      picker.userData.diagramPicker=true;
      picker.userData.buildingPick={key,pnu:building.pnu,index,
        model:this._buildingModels.get(key)?.name||"",removed:removed.has(key)};
      picker.name="DESIGN AREA 건물 선택 영역";
      assignLayerOrder(picker,state,"designBldg",1);this.root.add(picker);this._pickers.push(picker);

      const stored=this._buildingModels.get(key);
      if(stored&&designL.on){
        const model=cloneModel(stored.scene);this._applyBuildingPlacement(model,stored);
        model.name=`DESIGN AREA 사용자 모델 · ${stored.name}`;model.userData.buildingKey=key;
        assignLayerOrder(model,state,"designBldg");this.root.add(model);this._buildingModelInstances.set(key,model);
      }

      if(selectedBuildings.has(key)){
        const outline=thickLineSegments(new THREE.EdgesGeometry(pickerGeometry),
          {stroke:"#e2564a",w:Math.max(1.5,designL.w||0),op:100},"#e2564a");
        if(outline){outline.position.copy(picker.position);outline.name="선택 건물 표시";
          assignLayerOrder(outline,state,"designBldg",20);this.root.add(outline);}
      }
    }

    if(designGroundL.on&&designParcels.length){
      if(designGroundL.fillOn){
        const designGeo=terrainGeometry(data,state),mask=this.makeDesignGroundMask(data,selected);
        if(designGeo&&mask){
          this._textures.push(mask);
          const material=meshMaterial(state,"designGround",false,null);
          material.alphaMap=mask;material.alphaTest=.08;material.transparent=true;
          material.polygonOffset=true;material.polygonOffsetFactor=-1;material.polygonOffsetUnits=-1;
          const mesh=new THREE.Mesh(designGeo,material);mesh.name="DESIGN AREA 지형면";
          mesh.receiveShadow=true;mesh.userData.diagramSectionClip=true;
          assignLayerOrder(mesh,state,"designGround");this.root.add(mesh);
        }else designGeo?.dispose();
      }
      if(state.outline&&designGroundL.strokeOn!==false&&designGroundL.w>0){
        const boundaryGeo=lineGeometry(designParcels,
          (_parcel,point)=>terrainDisplayZ(data,state,groundAt(data,point[0],point[1]))*state.vScale+.08,
          parcel=>polygonGroups(parcel).flat());
        if(boundaryGeo){
          const boundary=thickLineSegments(boundaryGeo,designGroundL,"#b35b52");
          if(boundary){boundary.name="DESIGN AREA 지형면 경계선";
            boundary.userData.diagramSectionClip=true;
            assignLayerOrder(boundary,state,"designGround",3);this.root.add(boundary);}
        }
      }
    }

    // 가져온 설계 모델은 특정 기존 건물의 대체물이 아니다. DESIGN AREA 부모
    // 레이어에 독립 객체로 올려 기존 건물 선택·제거와 별개로 배치한다.
    const designModel=this._buildingModels.get("__design_area_model__");
    if(designModel&&designL.on){
      const model=cloneModel(designModel.scene);this._applyBuildingPlacement(model,designModel);
      model.name=`DESIGN AREA 사용자 모델 · ${designModel.name}`;
      model.userData.buildingKey="__design_area_model__";
      assignLayerOrder(model,state,"designBldg");this.root.add(model);
      this._buildingModelInstances.set("__design_area_model__",model);
    }

    const parcel=layerOf(state,"parcel");
    if(parcel.on&&parcel.strokeOn!==false&&parcel.w>0){
      const geo=lineGeometry(data.parcels,p=>terrainDisplayZ(data,state,p.base||0)*state.vScale+.12,p=>p.rings);
      if(geo){const lines=thickLineSegments(geo,parcel,"#747d8c");if(lines){lines.name="필지";
        lines.userData.diagramSectionClip=true;
        assignLayerOrder(lines,state,"parcel",4);this.root.add(lines);}}
    }
    const contour=layerOf(state,"contour");
    if(contour.on&&contour.strokeOn!==false&&contour.w>0){
      const geo=lineGeometry(data.contours,(c,p)=>(state.terrainMode==="stepped"
        ?terrainDisplayZ(data,state,c.z):groundAt(data,p[0],p[1]))*state.vScale+.16,c=>[c.pts]);
      if(geo){const lines=thickLineSegments(geo,contour,"#a68d5e");if(lines){lines.name="등고선";
        lines.userData.diagramSectionClip=true;
        assignLayerOrder(lines,state,"contour",4);this.root.add(lines);}}
    }

    const sectionGeometry=groundL.on&&groundL.fillOn?sectionTerrainCapGeometry(data,state):null;
    if(sectionGeometry){
      const material=new THREE.MeshStandardMaterial({color:state.section.color||"#b96d45",roughness:.9,
        metalness:0,side:THREE.DoubleSide});
      const cap=new THREE.Mesh(sectionGeometry,material);cap.name="현재 뷰 단면 채움";
      cap.receiveShadow=true;assignLayerOrder(cap,state,"ground",8);this.root.add(cap);
    }
  }

  updateCamera(data,state,w,h){
    const R=data.radius,scale=state.zoom*Math.min(w,h)/(R*2);
    this.camera.left=-w/(2*scale);this.camera.right=w/(2*scale);
    this.camera.top=h/(2*scale);this.camera.bottom=-h/(2*scale);
    this.camera.near=.1;this.camera.far=Math.max(5000,R*12);this.camera.updateProjectionMatrix();
    const a=state.az*RAD,e=state.el*RAD,sa=Math.sin(a),ca=Math.cos(a),se=Math.sin(e),ce=Math.cos(e);
    const right=new THREE.Vector3(ca,-sa,0),up=new THREE.Vector3(sa*se,ca*se,ce);
    let avg=0,n=0;for(const row of data.ground.z||[])for(const z of row){avg+=terrainDisplayZ(data,state,z);n++;}
    const target=new THREE.Vector3(0,0,(n?avg/n:0)*state.vScale)
      .addScaledVector(right,-state.panX/scale).addScaledVector(up,state.panY/scale);
    const view=new THREE.Vector3(-sa*ce,-ca*ce,se);
    this.camera.position.copy(target).addScaledVector(view,Math.max(1000,R*5));
    this.camera.up.copy(up);this.camera.lookAt(target);this.camera.updateMatrixWorld();
  }

  updateLineWidths(state){
    const scale=Math.max(.01,(Number(state.zoom)||VIEW_STYLE_BASE_ZOOM)/VIEW_STYLE_BASE_ZOOM);
    this.root.traverse(object=>{
      if(!object.userData.diagramWideLine)return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials){
        const base=material?.userData?.diagramBaseLineWidth;
        if(Number.isFinite(base))material.linewidth=base*scale;
      }
    });
  }

  updateSection(data,state){
    const definition=sectionDefinition(data,state),planes=definition?[definition.plane]:[];
    this.root.traverse(object=>{
      if(!object.userData.diagramSectionClip||!object.material)return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials){material.clippingPlanes=planes;material.clipShadows=true;}
    });
  }

  updateLight(data,state){
    const sh=layerOf(state,"shadow"),strength=(sh.op??45)/100;
    const sky=layerOf(state,"sky");
    const cloudFactor=sky.on
      ?1-Math.max(0,Math.min(100,Number(sky.clouds)||0))/100*.55:1;
    const daylight=state.sunAlt>0;
    const shadowable=state.sunAlt>=5; // 지평선 부근의 사실상 무한한 그림자는 화면을 덮으므로 생략
    this.renderer.shadowMap.enabled=!!sh.on&&!!sh.fillOn&&shadowable;
    this.sun.castShadow=!!sh.on&&!!sh.fillOn&&shadowable;
    this.sun.intensity=daylight?(1.65+strength*.8)*cloudFactor:0;
    this.hemi.intensity=daylight?1.15-strength*.62+(.18*(1-cloudFactor)):.72;
    const a=state.sunAz*RAD,e=state.sunAlt*RAD,R=data.radius;
    const targetZ=((data.ground.min+data.ground.max)/2)*state.vScale;
    this.sun.target.position.set(0,0,targetZ);
    this.sun.position.set(Math.sin(a)*Math.cos(e)*R*3,Math.cos(a)*Math.cos(e)*R*3,
                          targetZ+Math.sin(e)*R*3);
    const q={standard:512,high:2048,final:4096}[state.renderQuality]||2048;
    if(this.sun.shadow.mapSize.width!==q){
      this.sun.shadow.map?.dispose();this.sun.shadow.map=null;
      this.sun.shadow.mapSize.set(q,q);this.sun.shadow.needsUpdate=true;
      this.renderer.shadowMap.needsUpdate=true;
    }
    const extent=R*1.55,cam=this.sun.shadow.camera;
    cam.left=-extent;cam.right=extent;cam.top=extent;cam.bottom=-extent;cam.near=.1;cam.far=R*8;
    cam.updateProjectionMatrix();this.sun.shadow.bias=-0.00035;this.sun.shadow.normalBias=.08;
    // PCF 반경은 shadow-map 픽셀 단위라 0~8을 그대로 넣으면 고해상도에서 거의 안 보인다.
    // 0은 실제로 선명하게, 이후 값은 체감 가능한 필터 반경으로 넓힌다.
    this.sun.shadow.radius=1+Math.max(0,state.shadowSoftness??2.5)*3;
  }

  setBackground(state){
    const bg=layerOf(state,"background"),sky=layerOf(state,"sky");
    if(!sky.on){
      this.scene.background=null;
      if(bg.on)this.renderer.setClearColor(new THREE.Color(bg.fill),1);
      else this.renderer.setClearColor(0x000000,0);
      return;
    }
    const key=JSON.stringify([sky.zenith,sky.horizon,+sky.clouds||0,+sky.sunGlow||0,
      Math.round((+state.sunAz||0)*2)/2,Math.round((+state.sunAlt||0)*2)/2,
      Math.round((+state.az||0)*2)/2]);
    if(key!==this._skyKey){
      this._skyTexture?.dispose();
      const canvas=document.createElement("canvas");paintSkyCanvas(state,canvas);
      this._skyTexture=new THREE.CanvasTexture(canvas);this._skyTexture.colorSpace=THREE.SRGBColorSpace;
      this._skyTexture.minFilter=THREE.LinearFilter;this._skyTexture.magFilter=THREE.LinearFilter;
      this._skyTexture.name="태양 연동 하늘 배경";this._skyKey=key;
    }
    this.scene.background=this._skyTexture;this.renderer.setClearColor(0x000000,1);
  }

  render(data,state,image,selected=new Set()){
    if(!data)return;
    this._lastRenderArgs=[data,state,image,selected];
    const w=Math.max(2,this.canvas.clientWidth),h=Math.max(2,this.canvas.clientHeight);
    const nativeDpr=window.devicePixelRatio||1;
    // 품질 선택이 그림자 맵만 바꾸면 작은 미리보기에서는 차이가 거의 안 보인다.
    // 빠르게는 실제 픽셀을 줄이고, 최종은 화면과 무관하게 2배로 렌더한다.
    const dpr=state.renderQuality==="standard"?.75:
              state.renderQuality==="final"?2:Math.min(nativeDpr,1.5);
    this.renderer.setPixelRatio(dpr);this.renderer.setSize(w,h,false);
    const sig=this.signature(data,state,image,selected);
    const textureVersion=image?(image._toneVersion??image.src??""):"";
    if(sig!==this._signature){
      this.rebuild(data,state,image,selected);this._signature=sig;this._textureVersion=textureVersion;
    }else if(textureVersion!==this._textureVersion){
      this.refreshTextures(image);this._textureVersion=textureVersion;
    }
    this.setBackground(state);this.updateCamera(data,state,w,h);this.updateLineWidths(state);this.updateSection(data,state);this.updateLight(data,state);
    this._updateMassTiles(data,state,w,h,selected);
    this.renderer.render(this.scene,this.camera);
  }

  async exportPNG(data,state,image,selected,crop,scale,name){
    const w=Math.max(2,this.canvas.clientWidth),h=Math.max(2,this.canvas.clientHeight);
    const oldSig=this._signature;this.renderer.setPixelRatio(scale);this.renderer.setSize(w,h,false);
    const sig=this.signature(data,state,image,selected);
    const textureVersion=image?(image._toneVersion??image.src??""):"";
    if(sig!==this._signature){
      this.rebuild(data,state,image,selected);this._signature=sig;this._textureVersion=textureVersion;
    }else if(textureVersion!==this._textureVersion){
      this.refreshTextures(image);this._textureVersion=textureVersion;
    }
    this.setBackground(state);this.updateCamera(data,state,w,h);this.updateLineWidths(state);this.updateSection(data,state);this.updateLight(data,state);
    this._updateMassTiles(data,state,w,h,selected);
    this.renderer.render(this.scene,this.camera);
    const c=crop||{x:0,y:0,w,h},out=document.createElement("canvas");
    out.width=Math.round(c.w*scale);out.height=Math.round(c.h*scale);
    out.getContext("2d").drawImage(this.canvas,c.x*scale,c.y*scale,c.w*scale,c.h*scale,0,0,out.width,out.height);
    await new Promise(ok=>out.toBlob(blob=>{
      const a=document.createElement("a");a.download=name;a.href=URL.createObjectURL(blob);a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href),4000);ok();
    },"image/png"));
    this._signature=oldSig;this.render(data,state,image,selected);
  }

  async exportGLB(data,state,image,selected,name){
    this.render(data,state,image,selected);
    // GLTF의 선은 화면 픽셀 굵기를 보존할 수 없다. LineSegments2의 화면용 쿼드가
    // 실제 모델 면으로 잘못 들어가지 않도록 복제본에서 제외한다.
    const materials=new Map();
    this.scene.traverseVisible(object=>{
      if(!object.userData.diagramGeneratedBuilding)return;
      materials.set(`${object.userData.diagramBuildingLayer}:${object.userData.diagramBuildingSurface}`,object.material);
    });
    const exportBuildings=new THREE.Group();exportBuildings.name="건물 · 객체별 닫힌 메시";
    const removed=state.removedBuildings instanceof Set?state.removedBuildings:
      new Set(state.removedBuildings||[]);
    for(const [buildingIndex,building] of (data.buildings||[]).entries()){
      const key=buildingKey(data,building,buildingIndex);
      if(selected.has(building.pnu)&&(this._buildingModels.has(key)||removed.has(key)))continue;
      const chosen=selected.has(building.pnu),layerId=chosen?"designBldg":"bldg",L=layerOf(state,layerId);
      if(!L.on||!L.fillOn)continue;
      const geometry=closedBuildingGeometry(data,state,building);if(!geometry)continue;
      const material=materials.get(`${layerId}:roof`)||materials.get(`${layerId}:wall`);
      if(!material){geometry.dispose();continue;}
      const mesh=new THREE.Mesh(geometry,material);
      const identity=building.pnu||String(buildingIndex+1).padStart(4,"0");
      mesh.name=`${chosen?"DESIGN AREA":"CONTEXT"} 건물 · ${identity}`;
      mesh.userData={source:"VWorld LT_C_SPBD",pnu:building.pnu||"",floors:Math.max(1,building.floors||1),closedMesh:true};
      exportBuildings.add(mesh);
    }
    let buffer;
    try {
      const output = buildGLBScene(this.scene, exportBuildings);
      buffer = await new GLTFExporter().parseAsync(output,
        {binary:true, onlyVisible:true, maxTextureSize:2048});
    } finally {
      exportBuildings.traverse(object => object.geometry?.dispose());
    }
    const blob=new Blob([buffer],{type:"model/gltf-binary"}),a=document.createElement("a");
    a.download=name;a.href=URL.createObjectURL(blob);a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  }
}
