import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Box3,AnimationMixer} from 'three';
globalThis.ProgressEvent??=class {constructor(type,init={}){this.type=type;Object.assign(this,init);}};
const version=process.argv.includes('--v1')?'v1':'v2';
const root='assets/3d/'+version+'/';
const manifest=JSON.parse(await fs.readFile(root+'manifest.json','utf8'));
for(const item of manifest.assets){
  const data=await fs.readFile(root+item.file);
  assert.equal(data.toString('ascii',0,4),'glTF');
  assert.equal(data.readUInt32LE(4),2);
  assert.equal(data.readUInt32LE(8),data.length);
  assert.equal(data.length,item.bytes);
  const jsonLength=data.readUInt32LE(12);
  const json=JSON.parse(data.toString('utf8',20,20+jsonLength));
  const bin=data.subarray(28+jsonLength);
  for(const view of json.bufferViews){
    assert.equal(view.buffer,0);
    assert((view.byteOffset||0)+view.byteLength<=bin.length,'bufferView outside GLB');
  }
  for(const image of json.images||[]){
    assert.equal(image.mimeType,'image/png');assert(!image.uri,'GLB must embed images');
    const view=json.bufferViews[image.bufferView];
    assert.equal(bin.subarray(view.byteOffset,view.byteOffset+8).toString('hex'),'89504e470d0a1a0a');
  }
  // Node cannot decode images. Validate PNG structure here and decoded maps in Chromium.
  for(const m of json.materials||[]){delete m.pbrMetallicRoughness?.baseColorTexture;delete m.emissiveTexture;}
  delete json.images;delete json.textures;delete json.samplers;
  json.buffers[0].uri='data:application/octet-stream;base64,'+bin.toString('base64');
  const gltf=await new GLTFLoader().parseAsync(JSON.stringify(json),'');
  if(version==='v2'&&(item.name==='studio'||item.name==='console')){
    const robots=[];gltf.scene.traverse(o=>{if(o.name==='Coordinator')robots.push(o);});
    assert.equal(robots.length,1,item.name+' must retain one Coordinator node for animation and speech bubbles');
    assert(!robots[0].isMesh,'Coordinator must remain a separately movable group');
    assert(!new Box3().setFromObject(robots[0]).isEmpty(),'Coordinator must own visible robot geometry');
  }
  let meshes=0,triangles=0;
  gltf.scene.traverse(o=>{
    if(!o.isMesh)return;
    meshes++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;
    for(const value of o.geometry.attributes.position.array)assert(Number.isFinite(value),item.name+' nonfinite vertex');
  });
  assert.equal(meshes,item.meshes);assert.equal(triangles,item.triangles);
  const bounds=new Box3().setFromObject(gltf.scene);assert(!bounds.isEmpty());
  for(const side of ['min','max'])bounds[side].toArray().forEach((v,i)=>assert(Math.abs(v-item.bounds[side][i])<1e-4));
  assert.deepEqual(gltf.animations.map(c=>c.name),item.animations);
  // 动作**幅度下限**（2026-09-11 用户实测后新增）。
  // 原先只断言"动作确实影响了节点"（阈值 1e-5 ≈ 0.0006°），于是 Working 只有 2° 也能通过——
  // 实机上工位状态明明切成 working，肉眼却完全看不出动作。这里按剪辑名要求最低可见幅度，
  // 单位是四元数分量：0.05 ≈ 5.7°，0.1 ≈ 11.5°。
  const VISIBILITY_FLOOR={Working:.04,Error:.04};
  const amplitudes=[];
  for(const clip of gltf.animations){
    for(const track of clip.tracks)assert(gltf.scene.getObjectByName(track.name.split('.')[0]),'missing animation target');
    const initial=[];gltf.scene.traverse(o=>initial.push(...o.quaternion.toArray()));
    const mixer=new AnimationMixer(gltf.scene);mixer.clipAction(clip).play();
    // 沿整段时长采样取最大偏移，避免只测一个时间点而漏掉动作峰值
    let maxDelta=0;
    for(let step=1;step<=12;step++){
      mixer.setTime(clip.duration*step/12);
      const current=[];gltf.scene.traverse(o=>current.push(...o.quaternion.toArray()));
      for(let i=0;i<current.length;i++)maxDelta=Math.max(maxDelta,Math.abs(current[i]-initial[i]));
    }
    assert(maxDelta>1e-5,clip.name+' did not affect nodes');
    const floor=VISIBILITY_FLOOR[clip.name];
    if(floor!==undefined)assert(maxDelta>=floor,`${clip.name} 幅度过小（${maxDelta.toFixed(4)} < ${floor}）：实机上肉眼看不出来`);
    amplitudes.push(clip.name+'='+maxDelta.toFixed(3));
    mixer.stopAllAction();mixer.uncacheRoot(gltf.scene);
  }
  console.log('PASS '+item.file+' | binary, embedded images, geometry, bounds, animation'+(amplitudes.length?' ['+amplitudes.join(' ')+']':''));
}
