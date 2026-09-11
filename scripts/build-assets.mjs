import fs from 'node:fs/promises';
import path from 'node:path';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Box3,Vector3 } from 'three';
const version=process.argv.includes('--v1')?'v1':'v2';
const {assets,palette}=await import(version==='v1'?'./asset-kit.mjs':'./asset-kit-v2.mjs');

globalThis.FileReader=class {
  readAsArrayBuffer(blob){blob.arrayBuffer().then(v=>{this.result=v;this.onloadend?.();});}
  readAsDataURL(blob){blob.arrayBuffer().then(v=>{this.result=`data:${blob.type};base64,${Buffer.from(v).toString('base64')}`;this.onloadend?.();});}
};
const dir=path.resolve('assets/3d/'+version);await fs.mkdir(dir,{recursive:true});
const manifest={version:Number(version.slice(1)),units:'meters',upAxis:'Y',palette,assets:[]};
// GLTFExporter is run in Node. Append PNG sources directly to the standard GLB
// image bufferViews to keep runtime assets self-contained without a canvas shim.
async function embedTextures(buffer){
  const src=Buffer.from(buffer),jsonLength=src.readUInt32LE(12),json=JSON.parse(src.toString('utf8',20,20+jsonLength));
  const binHeader=20+jsonLength;let parts=[src.subarray(binHeader+8,binHeader+8+src.readUInt32LE(binHeader))],offset=parts[0].length;
  const keys=new Map();json.images=[];json.textures=[];json.samplers=[];
  for(const m of json.materials||[]){const key=m.extras?.textureKey;if(!key)continue;
    if(!keys.has(key)){const png=await fs.readFile(path.join(dir,'textures','gltf',key+'.png'));const pad=(4-offset%4)%4;if(pad){parts.push(Buffer.alloc(pad));offset+=pad;}const view=json.bufferViews.length;json.bufferViews.push({buffer:0,byteOffset:offset,byteLength:png.length});parts.push(png);offset+=png.length;const image=json.images.length;json.images.push({name:key,mimeType:'image/png',bufferView:view});const sampler=json.samplers.length;const repeat=key==='oak'||key==='fabric';json.samplers.push({magFilter:9729,minFilter:9987,wrapS:repeat?10497:33071,wrapT:repeat?10497:33071});const texture=json.textures.length;json.textures.push({sampler,source:image});keys.set(key,texture);}
    m.pbrMetallicRoughness.baseColorTexture={index:keys.get(key)};
    if(key==='window'){m.extensions={...m.extensions,KHR_materials_unlit:{}};json.extensionsUsed=[...new Set([...(json.extensionsUsed||[]),'KHR_materials_unlit'])];}
    if(key.startsWith('screen-')){m.emissiveFactor=[.20,.20,.20];m.emissiveTexture={index:keys.get(key)};}
  }
  json.buffers[0].byteLength=offset;const padding=(4-offset%4)%4;if(padding)parts.push(Buffer.alloc(padding));const bin=Buffer.concat(parts);let txt=Buffer.from(JSON.stringify(json));txt=Buffer.concat([txt,Buffer.alloc((4-txt.length%4)%4,32)]);const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+txt.length+bin.length,8);header.writeUInt32LE(txt.length,12);header.writeUInt32LE(0x4e4f534a,16);const bh=Buffer.alloc(8);bh.writeUInt32LE(bin.length);bh.writeUInt32LE(0x004e4942,4);return Buffer.concat([header,txt,bh,bin]);
}
for(const [name,create] of Object.entries(assets)){
  const {scene,animations=[]}=create();scene.updateMatrixWorld(true);
  let triangles=0,meshes=0;scene.traverse(o=>{if(o.isMesh){meshes++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;}});
  let binary=await new GLTFExporter().parseAsync(scene,{binary:true,animations,trs:true});
  if(version==='v2')binary=await embedTextures(binary);
  const filename=name+'.glb';await fs.writeFile(path.join(dir,filename),Buffer.from(binary));
  const bounds=new Box3().setFromObject(scene);const info={name,file:filename,bytes:binary.byteLength,triangles,meshes,bounds:{min:bounds.min.toArray(),max:bounds.max.toArray(),size:bounds.getSize(new Vector3()).toArray()},animations:animations.map(x=>x.name)};
  manifest.assets.push(info);console.log(`${name}: ${triangles} tris, ${meshes} meshes, ${(binary.byteLength/1024).toFixed(0)} KiB`);
}
await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
