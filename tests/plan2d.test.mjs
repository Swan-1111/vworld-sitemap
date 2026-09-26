import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import vm from "node:vm";

test("부모 레이어 0%에서도 하위 건물·필지·용도지역의 불투명도가 독립 적용된다", () => {
  const source = readFileSync(new URL("../web/plan2d.js", import.meta.url), "utf8");
  const context = vm.createContext({
    createAerialLoader: () => () => {}, makePresets: () => ({}),
    document: {querySelector: () => ({clientWidth: 800, clientHeight: 600})},
    DRAW: {rgb: () => [0, 0, 0], _rgba: () => "#000000", cropOverlay: () => []},
  });
  vm.runInContext(source, context);
  const result = vm.runInContext(`(() => {
    const rings = [[[0,0],[10,0],[10,10],[0,10],[0,0]]];
    P2.scene = {name:'test', radius:250, buildings:[{pnu:'A',strct:'목구조',rings}],
      parcels:[{pnu:'A',jimok:'대',rings}], zones:[{name:'주거',rings}], roads:[],spots:[]};
    P2.layers = ['bldg','parcel','zone'].map(id => ({id,name:id,on:true,op:0,
      fillOn:true,fill:'#ffffff',strokeOn:false,w:0}));
    P2.rules = P2.layers.map(layer => ({id:layer.id,layer:layer.id,name:'child',on:true,
      region:'all',op:65,fillOn:true,fill:'#ff0000',strokeOn:false,w:0}));
    return plan2List().filter(op=>op.ruled).map(op=>({layer:op.layer,opacity:op.opacity}));
  })()`, context);
  assert.equal(result.length, 3);
  assert.ok(result.every(op => op.opacity === .65));
});
