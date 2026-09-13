import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {clone as cloneSkeleton} from 'three/addons/utils/SkeletonUtils.js';

const view=document.querySelector('#view'), status=document.querySelector('#status');
const scene=new THREE.Scene(); scene.background=new THREE.Color('#f3eee5');
const camera=new THREE.PerspectiveCamera(38,innerWidth/innerHeight,.1,150);
const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.VSMShadowMap;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.95;
view.appendChild(renderer.domElement);
const pmrem=new THREE.PMREMGenerator(renderer), room=new RoomEnvironment();
const env=pmrem.fromScene(room,.05);scene.environment=env.texture;scene.environmentIntensity=.38;room.dispose();pmrem.dispose();
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.09;controls.minDistance=4;controls.maxDistance=35;controls.maxPolarAngle=Math.PI*.47;
const hemi=new THREE.HemisphereLight('#fff3dd','#b4aa95',1.5);scene.add(hemi);
const sun=new THREE.DirectionalLight('#fff0d6',2.3);sun.position.set(-7,12,5);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-11,right:11,top:11,bottom:-11,near:.5,far:35});sun.shadow.bias=-.0001;sun.shadow.normalBias=.035;sun.shadow.radius=4;sun.shadow.blurSamples=8;scene.add(sun);
const fill=new THREE.DirectionalLight('#d8e5ff',.65);fill.position.set(7,6,-5);scene.add(fill);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:'#ede6d9',roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.y=-.025;ground.receiveShadow=true;scene.add(ground);
const loader=new GLTFLoader(), assets={}, instances=[], lights=[];
let dirty=true, spinning=false, ready=false, mode='day';
const workers=[], seats=[];
let workerMode='Working', animateWorkers=new URLSearchParams(location.search).get('motion')!=='paused', lastFrame=performance.now();
function request(){dirty=true;}
controls.addEventListener('change',request);
function frame(type='reset'){
  controls.target.set(0,.5,0);
  if(type==='close'){camera.position.set(5,5.7,7);controls.target.set(0,.9,0);}
  else if(type==='person'){const p=workers[2]?.group.position||new THREE.Vector3(-4.3,.52,2.7);camera.position.set(p.x+2.5,2.8,p.z+3);controls.target.set(p.x,1.5,p.z);}
  else if(type==='top')camera.position.set(.01,22,3);
  else camera.position.set(-13,13,16);
  controls.update();request();
}
function add(name,width,x,z,angle=0,y=.52){
  const object=assets[name].clone(true);object.updateMatrixWorld(true);
  const box=new THREE.Box3().setFromObject(object), size=box.getSize(new THREE.Vector3()), center=box.getCenter(new THREE.Vector3());
  const scale=width/size.x;object.scale.multiplyScalar(scale);object.position.set(-center.x*scale,-box.min.y*scale,-center.z*scale);
  object.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
  const group=new THREE.Group();group.add(object);group.position.set(x,y,z);group.rotation.y=angle;scene.add(group);
  instances.push({name,group});return group;
}
function rug(radius,x,z){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=512;const ctx=canvas.getContext('2d');
  ctx.fillStyle='#c9b898';ctx.fillRect(0,0,512,512);
  for(let i=0;i<256;i+=2){ctx.strokeStyle=i%4?'#bead8e':'#d8c9ad';ctx.lineWidth=1;ctx.beginPath();ctx.arc(256,256,i,0,Math.PI*2);ctx.stroke();}
  const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;
  const mesh=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,.025,96),new THREE.MeshStandardMaterial({map:tex,roughness:1}));mesh.position.set(x,.54,z);mesh.receiveShadow=true;scene.add(mesh);
}
function lighting(next){mode=next;const night=next==='night';document.body.classList.toggle('night',night);
  scene.background.set(night?'#252f36':'#f3eee5');ground.material.color.set(night?'#303b40':'#ede6d9');
  hemi.intensity=night?.55:1.5;sun.intensity=night?.55:2.3;sun.color.set(night?'#a9c5f3':'#fff0d6');fill.intensity=night?.4:.65;scene.environmentIntensity=night?.2:.38;
  lights.forEach(l=>l.intensity=night?5:1.2);
  document.querySelector('#day').classList.toggle('active',!night);document.querySelector('#night').classList.toggle('active',night);request();
}
async function init(){
  const names={platform:'地台',desk:'工位桌',chair:'座椅',console:'中央台',sofa:'沙发',bookcase:'书柜',lamp:'桌灯',plant:'盆栽'};
  for(const [name,label] of Object.entries(names)){
    status.textContent=`正在载入${label}…`;
    assets[name]=(await loader.loadAsync('/tmp/hunyuan-preview/assets/'+name+'.glb')).scene;
    assets[name].traverse(o=>{if(o.isMesh){const mats=Array.isArray(o.material)?o.material:[o.material];for(const m of mats){if(m.map)m.map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());if(m.normalScale)m.normalScale.setScalar(.45);if(m.specularColor)m.specularColor.setRGB(1,1,1);}}});
  }
  const platform=add('platform',14.5,0,0,0,0);platform.scale.y=.52/(new THREE.Box3().setFromObject(platform).max.y);
  rug(1.9,0,0);
  add('console',2.7,0,0,0);
  for(const x of [-3.3,3.3])for(const z of [-2.7,0,2.7]){
    const angle=x<0?-Math.PI/2:Math.PI/2;
    const offset=(dx,dz)=>[x+dx*Math.cos(angle)+dz*Math.sin(angle),z-dx*Math.sin(angle)+dz*Math.cos(angle)];
    add('desk',2.25,x,z,angle);const cp=offset(0,.68);add('chair',.92,...cp,angle+Math.PI);seats.push({x:cp[0],z:cp[1],angle:angle+Math.PI});
    const lp=offset(-.78,-.03);add('lamp',.38,...lp,angle,1.49);
    const light=new THREE.PointLight('#ffd59b',1.2,2.7,2);light.position.set(lp[0],1.96,lp[1]);scene.add(light);lights.push(light);
  }
  add('sofa',2.8,-3.8,-4.6);add('bookcase',3.1,1.2,-4.8);
  for(const [x,z,w] of [[-6,-4.5,.8],[5.8,-4.6,.9],[5.9,4.4,.9],[-5.9,3.3,.8]])add('plant',w,x,z);
  const rim=new THREE.Mesh(new THREE.TorusGeometry(1.18,.018,6,96),new THREE.MeshBasicMaterial({color:'#ffd58e'}));rim.rotation.x=Math.PI/2;rim.position.set(0,.57,0);scene.add(rim);
  ready=true;window.studioPreview={scene,camera,renderer,instances,assets,lighting,frame,getStats:()=>({ready,mode,triangles:renderer.info.render.triangles,calls:renderer.info.render.calls,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures})};
  status.textContent='八类模型已就位 · 六个工位 · 可拖动查看';frame();
  // Six independent skeletons share the original user's mesh and textures.
  try {
    const gltf=await loader.loadAsync('/tmp/hunyuan-preview/assets/worker-seated.glb');
    assets.worker=gltf.scene;
    for(const [i,seat] of seats.entries()){
      const model=cloneSkeleton(gltf.scene),group=new THREE.Group();model.scale.setScalar(1.85);
      model.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
      group.add(model);group.position.set(seat.x,.52,seat.z);group.rotation.y=seat.angle;scene.add(group);
      const mixer=new THREE.AnimationMixer(model),actions={};for(const clip of gltf.animations)actions[clip.name]=mixer.clipAction(clip);
      if(!actions.Idle||!actions.Working)throw new Error('人物缺少待机或工作动作');
      actions.Working.play();mixer.update(i*.53);workers.push({group,mixer,actions});instances.push({name:'worker',group});
    }
    let bones=0;gltf.scene.traverse(o=>{if(o.isBone)bones++;});
    window.studioPreview.worker={animationNames:gltf.animations.map(a=>a.name),bones,count:workers.length};
    window.studioPreview.workers=workers;
    window.studioPreview.setWorkerMode=next=>{if(!['Idle','Working'].includes(next))return;workerMode=next;workers.forEach((w,i)=>{const old=w.actions[next==='Idle'?'Working':'Idle'],action=w.actions[next];action.reset();action.time=i*.53;action.play();old.crossFadeTo(action,.45,false);});document.querySelectorAll('[data-worker]').forEach(b=>b.classList.toggle('active',b.dataset.worker===next));status.textContent=next==='Working'?'工作中 · 双手轻敲，专注屏幕':'待机 · 停止敲击，轻微呼吸与张望';request();};
    const button=document.createElement('button');button.textContent='人物近景';button.id='person';button.onclick=()=>frame('person');document.querySelector('#top').parentElement.appendChild(button);
    const row=document.createElement('div');row.className='row';for(const [mode,label] of [['Working','工作中'],['Idle','待机']]){const b=document.createElement('button');b.textContent=label;b.dataset.worker=mode;b.classList.toggle('active',mode===workerMode);b.onclick=()=>window.studioPreview.setWorkerMode(mode);row.appendChild(b);}button.parentElement.after(row);
    const pause=document.createElement('button');pause.id='pause-workers';pause.textContent=animateWorkers?'暂停动作':'继续动作';pause.onclick=()=>{animateWorkers=!animateWorkers;pause.textContent=animateWorkers?'暂停动作':'继续动作';request();};row.appendChild(pause);
    document.querySelector('.panel p:last-of-type').textContent='六名固定工位员工 · 动作演示，可切换工作与待机';
    status.textContent='六名员工已入座 · 工作中 / 待机';request();
  } catch(error) {console.warn('人物预览未载入：',error.message);}
}
document.querySelector('#day').onclick=()=>lighting('day');document.querySelector('#night').onclick=()=>lighting('night');
for(const type of ['reset','close','top'])document.querySelector('#'+type).onclick=()=>frame(type);
document.querySelector('#exposure').oninput=e=>{renderer.toneMappingExposure=Number(e.target.value);request();};
document.querySelector('#rotate').onclick=e=>{spinning=!spinning;controls.autoRotate=spinning;controls.autoRotateSpeed=.45;e.target.classList.toggle('active',spinning);request();};
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);request();});
function tick(){requestAnimationFrame(tick);const now=performance.now(),dt=Math.min((now-lastFrame)/1000,.05);lastFrame=now;if(document.hidden)return;
  if(workers.length&&animateWorkers){workers.forEach(w=>w.mixer.update(dt));dirty=true;}
  controls.update();if(dirty||spinning){renderer.render(scene,camera);dirty=false;}}
frame();tick();init().catch(e=>{status.textContent='模型载入失败';document.querySelector('#error').textContent=e.message;console.error(e);});
