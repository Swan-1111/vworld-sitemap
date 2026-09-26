import rhino3dm from "rhino3dm";
import {Earcut} from "three/src/extras/Earcut.js";

let rhinoPromise;

function getRhino() {
  if(!rhinoPromise)rhinoPromise=rhino3dm({
    locateFile:path=>{
      if(!path.endsWith(".wasm"))return path;
      const url=new URL("rhino3dm.wasm",import.meta.url);
      if(typeof window!=="undefined")return url.href;
      return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/,"$1");
    },
  });
  return rhinoPromise;
}

function layerOf(state,id){return (state.layers||[]).find(layer=>layer.id===id)||{};}

function colorOf(value,fallback="#d9d4cb"){
  const hex=/^#?([0-9a-f]{6})$/i.exec(value||fallback)?.[1]||fallback.slice(1);
  return {r:parseInt(hex.slice(0,2),16),g:parseInt(hex.slice(2,4),16),b:parseInt(hex.slice(4,6),16),a:255};
}

function openRing(source,counterClockwise=true){
  const ring=(source||[]).filter(p=>Array.isArray(p)&&Number.isFinite(+p[0])&&Number.isFinite(+p[1]))
    .map(p=>[+p[0],+p[1]]);
  if(ring.length>1&&Math.hypot(ring[0][0]-ring.at(-1)[0],ring[0][1]-ring.at(-1)[1])<1e-7)ring.pop();
  let area=0;
  for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length];area+=a[0]*b[1]-b[0]*a[1];
  }
  // Rhino Extrusion은 프로파일 방향을 그대로 면 방향에 사용한다. 시계방향 외곽선은
  // 닫혀 있어도 안쪽을 앞면으로 갖는 뒤집힌 Brep이 되므로 모두 CCW로 통일한다.
  if((counterClockwise&&area<0)||(!counterClockwise&&area>0))ring.reverse();
  return ring.length>=3?ring:[];
}

function polygonGroups(item){
  return Array.isArray(item?.polygons)&&item.polygons.length
    ? item.polygons:(item?.rings||[]).map(ring=>[ring]);
}

function holedBuildingBrep(rhino,polygon,base,height){
  const rings=polygon.map((source,index)=>openRing(source,index===0)).filter(ring=>ring.length>=3);
  if(!rings.length)return null;
  const holeIndices=[],coordinates=[];let pointOffset=0;
  for(const [index,ring] of rings.entries()){
    if(index>0)holeIndices.push(pointOffset);
    for(const point of ring){coordinates.push(point[0],point[1]);pointOffset++;}
  }
  const indices=Earcut.triangulate(coordinates,holeIndices,2);
  if(!indices.length)return null;
  const mesh=new rhino.Mesh(),vertices=mesh.vertices(),faces=mesh.faces(),flat=rings.flat();
  const bottom=flat.map(p=>vertices.add(p[0],p[1],base));
  const top=flat.map(p=>vertices.add(p[0],p[1],base+height));
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i],b=indices[i+1],c=indices[i+2];
    faces.addTriFace(top[a],top[b],top[c]);
    faces.addTriFace(bottom[c],bottom[b],bottom[a]);
  }
  let offset=0;
  for(const ring of rings){
    for(let i=0;i<ring.length;i++){
      const j=(i+1)%ring.length,a=offset+i,b=offset+j;
      faces.addQuadFace(bottom[a],bottom[b],top[b],top[a]);
    }
    offset+=ring.length;
  }
  mesh.normals().computeNormals();mesh.compact();
  if(!mesh.isClosed){mesh.delete?.();return null;}
  const brep=rhino.Brep.createFromMesh(mesh,false);mesh.delete?.();
  if(brep?.isSolid)return brep;
  brep?.delete?.();return null;
}

function groundAt(scene,x,y){
  const g=scene.ground;if(!g||!g.n)return 0;
  const R=scene.radius,fx=Math.max(0,Math.min(g.n,(x+R)/g.step));
  const fy=Math.max(0,Math.min(g.n,(y+R)/g.step));
  const i=Math.min(g.n-1,Math.floor(fx)),j=Math.min(g.n-1,Math.floor(fy));
  const tx=fx-i,ty=fy-j;
  return g.z[j][i]*(1-tx)*(1-ty)+g.z[j][i+1]*tx*(1-ty)+
    g.z[j+1][i]*(1-tx)*ty+g.z[j+1][i+1]*tx*ty;
}

function addLayer(rhino,doc,name,color,visible=true){
  const layer=new rhino.Layer();layer.name=name;layer.color=colorOf(color);layer.visible=visible;
  const index=doc.layers().add(layer);layer.delete?.();return index;
}

function attributes(rhino,name,layerIndex,metadata={}){
  const out=new rhino.ObjectAttributes();out.name=name;out.layerIndex=layerIndex;
  for(const [key,value] of Object.entries(metadata))out.setUserString(key,String(value??""));
  return out;
}

function terrainGrid(scene,state){
  const g=scene.ground;if(!g||!g.n)return null;
  const R=scene.radius,b=scene.context_bounds||[-R,-R,R,R];
  const countU=Math.max(4,Math.min(g.n+1,Math.round((b[2]-b[0])/g.step)+1));
  const countV=Math.max(4,Math.min(g.n+1,Math.round((b[3]-b[1])/g.step)+1));
  const points=[];
  for(let u=0;u<countU;u++){
    const column=[];
    for(let v=0;v<countV;v++){
      const x=b[0]+(b[2]-b[0])*(u/(countU-1));
      const y=b[1]+(b[3]-b[1])*(v/(countV-1));
      column.push([x,y,groundAt(scene,x,y)*(state.vScale||1)]);
    }
    points.push(column);
  }
  return {g,b,countU,countV,points};
}

function addTerrain(rhino,doc,scene,state,layerIndices){
  const grid=terrainGrid(scene,state);if(!grid)return null;
  const {g,countU,countV,points}=grid;
  const orderU=Math.min(4,countU),orderV=Math.min(4,countV);
  const surface=rhino.NurbsSurface.create(3,false,orderU,orderV,countU,countV);
  if(!surface)throw new Error("지형 NURBS 곡면을 만들지 못했습니다.");
  surface.knotsU().createUniformKnots(1);surface.knotsV().createUniformKnots(1);
  const controls=surface.points();
  for(let u=0;u<countU;u++)for(let v=0;v<countV;v++){
    controls.set(u,v,[...points[u][v],1]);
  }
  surface.setUserString("source",scene.terrain_source?.source||"VWorld terrain grid");
  surface.setUserString("representation","degree-3 smooth NURBS control surface");
  const depth=Math.max(0,+state.groundDepth||0);
  const attr=attributes(rhino,"대지 윗면 · 기준 NURBS 곡면",layerIndices.surface,{
    source:scene.terrain_source?.source||"VWorld terrain grid",
    verticalScale:state.vScale||1,
    controlPoints:`${countU} x ${countV}`,
  });
  doc.objects().addSurface(surface,attr);
  attr.delete?.();surface.delete?.();

  if(depth<=0)return {countU,countV,depth:0,solid:false};
  const mesh=new rhino.Mesh(),vertices=mesh.vertices(),faces=mesh.faces();
  const top=Array.from({length:countU},()=>Array(countV));
  const bottom=Array.from({length:countU},()=>Array(countV));
  const bottomZ=g.min*(state.vScale||1)-depth;
  for(let u=0;u<countU;u++)for(let v=0;v<countV;v++){
    const [x,y,z]=points[u][v];top[u][v]=vertices.add(x,y,z);bottom[u][v]=vertices.add(x,y,bottomZ);
  }
  for(let u=0;u<countU-1;u++)for(let v=0;v<countV-1;v++){
    faces.addQuadFace(top[u][v],top[u+1][v],top[u+1][v+1],top[u][v+1]);
    faces.addQuadFace(bottom[u][v],bottom[u][v+1],bottom[u+1][v+1],bottom[u+1][v]);
  }
  const side=(a,b)=>faces.addQuadFace(a[0],a[1],b[1],b[0]);
  // CONTEXT 사각형을 반시계로 돌며 윗점·아랫점 쌍을 이으면 옆면 법선이 바깥을 향한다.
  for(let u=0;u<countU-1;u++)side([top[u][0],bottom[u][0]],[top[u+1][0],bottom[u+1][0]]);
  for(let v=0;v<countV-1;v++)side([top[countU-1][v],bottom[countU-1][v]],[top[countU-1][v+1],bottom[countU-1][v+1]]);
  for(let u=countU-1;u>0;u--)side([top[u][countV-1],bottom[u][countV-1]],[top[u-1][countV-1],bottom[u-1][countV-1]]);
  for(let v=countV-1;v>0;v--)side([top[0][v],bottom[0][v]],[top[0][v-1],bottom[0][v-1]]);
  mesh.normals().computeNormals();mesh.compact();
  if(!mesh.isClosed)throw new Error("두께를 적용한 대지 메시가 닫히지 않았습니다.");
  // 타입 정의에는 인자가 하나 빠져 있지만 OpenNURBS JS 런타임은 (mesh, trimmedTriangles)를 받는다.
  const terrainBrep=rhino.Brep.createFromMesh(mesh,false);
  if(!terrainBrep||!terrainBrep.isSolid)throw new Error("두께를 적용한 대지 Brep이 닫히지 않았습니다.");
  const solidAttr=attributes(rhino,`대지 · 두께 ${depth.toFixed(1)}m · 닫힌 폴리서피스`,layerIndices.solid,{
    source:scene.terrain_source?.source||"VWorld terrain grid",verticalScale:state.vScale||1,
    groundDepth:depth,grid:`${countU} x ${countV}`,
  });
  doc.objects().addBrep(terrainBrep,solidAttr);
  const faceCount=terrainBrep.faces().count;
  solidAttr.delete?.();terrainBrep.delete?.();mesh.delete?.();
  return {countU,countV,depth,solid:true,faceCount};
}

function addBuildings(rhino,doc,scene,state,selected,layerIndices){
  let solidCount=0,failedCount=0,partCount=0,holedCount=0;
  for(const [buildingIndex,building] of (scene.buildings||[]).entries()){
    const chosen=selected.has(building.pnu),layerId=chosen?"designBldg":"bldg",L=layerOf(state,layerId);
    if(!L.on||!L.fillOn)continue;
    const id=building.pnu||String(buildingIndex+1).padStart(4,"0");
    const name=`${chosen?"DESIGN AREA":"CONTEXT"} 건물 · ${id}`;
    const polygons=polygonGroups(building).filter(polygon=>polygon?.[0]?.length>=3);
    let groupIndex=-1;
    if(polygons.length>1){
      groupIndex=doc.groups().count;
      const group=new rhino.Group();group.name=name;doc.groups().add(group);group.delete?.();
    }
    for(const [partIndex,polygon] of polygons.entries()){
      const base=(+building.base||0)*(state.vScale||1);
      const height=Math.max(1,+building.floors||1)*(state.floorH||3.3);
      let curve=null,extrusion=null,brep=null;
      if(polygon.length>1){
        brep=holedBuildingBrep(rhino,polygon,base,height);
      }else{
        const ring=openRing(polygon[0]);
        const points=ring.map(p=>[p[0],p[1],base]);points.push([...points[0]]);
        curve=new rhino.PolylineCurve(points);
        extrusion=rhino.Extrusion.create(curve,height,true);
        brep=extrusion?.toBrep(true);
      }
      if(!brep||!brep.isSolid){failedCount++;curve?.delete?.();extrusion?.delete?.();brep?.delete?.();continue;}
      const attr=attributes(rhino,polygons.length>1?`${name} · ${partIndex+1}`:name,layerIndices[layerId],{
        source:"VWorld LT_C_SPBD",pnu:building.pnu||"",floors:Math.max(1,+building.floors||1),
        usage:building.purps||"",structure:building.strct||"",approvalYear:building.year||"",
        interiorRings:Math.max(0,polygon.length-1),
      });
      if(groupIndex>=0)attr.addToGroup(groupIndex);
      doc.objects().addBrep(brep,attr);solidCount++;partCount++;
      if(polygon.length>1)holedCount++;
      attr.delete?.();brep.delete?.();extrusion?.delete?.();curve?.delete?.();
    }
  }
  return {solidCount,failedCount,partCount,holedCount};
}

/** Rhino에서 편집 가능한 3DM 바이트와 검증 통계를 만든다. */
export async function buildRhino3DM(scene,state,selectedInput=new Set()){
  if(!scene)throw new Error("내보낼 3D 대지가 없습니다.");
  const selected=selectedInput instanceof Set?selectedInput:new Set(selectedInput||[]);
  const rhino=await getRhino(),doc=new rhino.File3dm();
  doc.applicationName="VWorld Site Model";
  doc.applicationUrl="http://127.0.0.1:8000";
  doc.applicationDetails="VWorld 3D diagram · Rhino editable export";
  doc.startSectionComments="건물과 대지는 바깥 방향의 닫힌 Brep(폴리서피스)입니다. 지형 기준 NURBS 곡면도 숨김 레이어에 포함됩니다. 모델 단위: m";
  const settings=doc.settings();settings.modelUnitSystem=rhino.UnitSystem.Meters;
  settings.modelAbsoluteTolerance=.001;settings.modelAngleToleranceDegrees=1;
  const groundLayer=layerOf(state,"ground"),buildingLayer=layerOf(state,"bldg"),designLayer=layerOf(state,"designBldg");
  const layerIndices={
    groundSolid:addLayer(rhino,doc,"지형 · 두께 포함 닫힌 폴리서피스",groundLayer.fill||"#ded9cc"),
    groundSurface:addLayer(rhino,doc,"지형 · 기준 NURBS 곡면 (숨김)",groundLayer.fill||"#ded9cc",false),
    bldg:addLayer(rhino,doc,"CONTEXT 건물 · 닫힌 폴리서피스",buildingLayer.fill||"#dfe3ea"),
    designBldg:addLayer(rhino,doc,"DESIGN AREA 건물 · 닫힌 폴리서피스",designLayer.fill||"#e2564a"),
  };
  const terrain=groundLayer.on&&groundLayer.fillOn?addTerrain(rhino,doc,scene,state,{
    solid:layerIndices.groundSolid,surface:layerIndices.groundSurface,
  }):null;
  const buildings=addBuildings(rhino,doc,scene,state,selected,layerIndices);
  const bytes=doc.toByteArray();doc.destroy();
  if(!bytes?.length)throw new Error("3DM 파일이 비어 있습니다.");
  return {bytes,stats:{terrain,buildings}};
}

export async function inspectRhino3DM(bytes){
  const rhino=await getRhino(),doc=rhino.File3dm.fromByteArray(bytes);
  if(!doc)throw new Error("생성한 3DM 파일을 다시 열지 못했습니다.");
  const result={objects:doc.objects().count,breps:0,solidBreps:0,nurbsSurfaces:0,
    buildingBreps:0,outwardBuildingBreps:0,names:[]};
  for(let i=0;i<doc.objects().count;i++){
    const object=doc.objects().get(i),geometry=object.geometry(),attr=object.attributes();
    result.names.push(attr.name||"");
    if(geometry.constructor.name==="Brep"){
      result.breps++;if(geometry.isSolid)result.solidBreps++;
      if((attr.name||"").includes("건물")){
        result.buildingBreps++;
        let topZ=-Infinity,topNormalZ=-Infinity;
        const faces=geometry.faces();
        for(let f=0;f<faces.count;f++){
          const face=faces.get(f),du=face.domain(0),dv=face.domain(1);
          const u=(du[0]+du[1])/2,v=(dv[0]+dv[1])/2;
          const point=face.pointAt(u,v),normal=face.normalAt(u,v);
          const actualZ=(face.orientationIsReversed?-1:1)*(normal?.[2]||0);
          if((point?.[2]??-Infinity)>topZ){topZ=point[2];topNormalZ=actualZ;}
          face.delete?.();
        }
        if(topNormalZ>.5)result.outwardBuildingBreps++;
        faces.delete?.();
      }
    }else if(geometry.constructor.name==="NurbsSurface")result.nurbsSurfaces++;
    geometry.delete?.();attr.delete?.();object.delete?.();
  }
  doc.destroy();return result;
}

export async function exportRhino3DM(scene,state,selected,name){
  const {bytes,stats}=await buildRhino3DM(scene,state,selected);
  const blob=new Blob([bytes],{type:"application/vnd.rhino"}),url=URL.createObjectURL(blob);
  const anchor=document.createElement("a");anchor.download=name;anchor.href=url;anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),4000);
  return stats;
}
