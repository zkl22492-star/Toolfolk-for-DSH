import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const palette = {
  cream:'#eee9dd', wall:'#e8e0d1', oak:'#cda97b', oakLight:'#dfc29b', oakDark:'#b68e62',
  sage:'#839580', sageLight:'#b4bf9f', blue:'#7893a9', terra:'#bd8066', charcoal:'#344449',
  screen:'#263f48', white:'#f6f1e6', skin:'#e7b997', hair:'#554034', leaf:'#6b8860',
  leafLight:'#94a977', paper:'#eae5d6', brass:'#b59b65', ink:'#72847b', rug:'#cec6b3'
};
const mats = new Map(), geo = new Map();
function mat(color, glow=false) {
  const value=palette[color]||color, key=value+glow;
  if(!mats.has(key)) mats.set(key,new T.MeshStandardMaterial({name:color,color:value,roughness:.82,metalness:0,...(glow?{emissive:value,emissiveIntensity:.22}:{})}));
  return mats.get(key);
}
function geometry(key,fn){if(!geo.has(key))geo.set(key,fn());return geo.get(key);}
function group(name,parent){const g=new T.Group();g.name=name;if(parent)parent.add(g);return g;}
function mesh(g,name,geometry,material,p=[0,0,0],r=[0,0,0]){const m=new T.Mesh(geometry,mat(material));m.name=name;m.position.set(...p);m.rotation.set(...r);m.castShadow=true;m.receiveShadow=true;g.add(m);return m;}
function box(g,name,size,p,color='oak',radius=.035,r=[0,0,0]){
  radius=Math.min(radius,...size.map(v=>v*.45));
  return mesh(g,name,geometry('b'+size+radius,()=>new RoundedBoxGeometry(...size,1,radius)),color,p,r);
}
function ell(g,name,size,p,color='sage',r=[0,0,0]){const m=mesh(g,name,geometry('sphere',()=>new T.SphereGeometry(1,16,10)),color,p,r);m.scale.set(...size);return m;}
function cyl(g,name,top,bottom,height,p,color='oak',r=[0,0,0],segments=16){return mesh(g,name,geometry('c'+[top,bottom,height,segments],()=>new T.CylinderGeometry(top,bottom,height,segments)),color,p,r);}
function rod(g,name,a,b,r,color){const av=new T.Vector3(...a),bv=new T.Vector3(...b),d=bv.clone().sub(av);const m=cyl(g,name,r,r,d.length(),av.add(bv).multiplyScalar(.5).toArray(),color);m.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),d.normalize());return m;}
function torus(g,name,major,tube,p,color,r=[0,0,0]){return mesh(g,name,geometry('t'+major+tube,()=>new T.TorusGeometry(major,tube,8,24)),color,p,r);}
export function compact(g){
  g.updateMatrixWorld(true);const inverse=g.matrixWorld.clone().invert(),buckets=new Map();
  g.traverse(o=>{if(!o.isMesh)return;const key=o.material.uuid;let a=buckets.get(key);if(!a)buckets.set(key,a={material:o.material,geometries:[]});const q=o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone();q.applyMatrix4(inverse.clone().multiply(o.matrixWorld));a.geometries.push(q);});
  g.clear();for(const {material,geometries} of buckets.values()){const geometry=mergeVertices(mergeGeometries(geometries));const m=new T.Mesh(geometry,material);m.name=g.name+'_'+material.name;m.castShadow=true;m.receiveShadow=true;g.add(m);for(const x of geometries)x.dispose();}return g;
}
export function plant(name='Plant',scale=1){const g=group(name);cyl(g,'Pot',.22,.16,.37,[0,.185,0],'cream');cyl(g,'Soil',.194,.194,.02,[0,.38,0],'hair');
  for(let i=0;i<8;i++){const a=i*2.4,h=.68+(i%3)*.17,rad=.17+(i%2)*.07;const end=[Math.cos(a)*rad,h,Math.sin(a)*rad];rod(g,'Stem',[0,.35,0],end,.012,'leaf');ell(g,'Leaf',[.10,.24,.035],end,i%2?'leaf':'leafLight',[.5*Math.sin(a),-a,.7*Math.cos(a)]);}g.scale.setScalar(scale);return compact(g);}
function mug(g,p,color='cream'){const h=group('Mug',g);h.position.set(...p);cyl(h,'Cup',.083,.072,.14,[0,.07,0],color);cyl(h,'Coffee',.066,.066,.005,[0,.142,0],'hair');torus(h,'Handle',.048,.015,[.09,.079,0],color);}
function books(g,p,count=6){for(let i=0;i<count;i++){let h=.29+(i%3)*.035;box(g,'Book',[.09,h,.22],[p[0]+i*.105,p[1]+h/2,p[2]],['sage','cream','blue','terra'][i%4],.006);box(g,'SpineLabel',[.055,.014,.006],[p[0]+i*.105,p[1]+h*.72,p[2]+.113],'paper',.002);}}
export function shelf(name='Bookshelf'){const g=group(name);box(g,'Back',[1.8,1.6,.07],[0,.8,-.2],'oakDark');for(const x of [-.89,.89])box(g,'Side',[.085,1.65,.48],[x,.825,0],'oakLight');for(const y of [.08,.61,1.13,1.64])box(g,'Shelf',[1.8,.08,.48],[0,y,0],'oakLight');books(g,[-.68,.13,.04],6);books(g,[.12,.66,.04],6);books(g,[-.68,1.18,.04],5);box(g,'StorageBox',[.64,.35,.35],[.43,.315,0],'sage');box(g,'Handle',[.16,.045,.016],[.43,.36,.19],'cream');box(g,'StorageBox',[.5,.35,.35],[-.43,.855,0],'cream');return compact(g);}
export function chair(name='Chair'){const g=group(name);cyl(g,'Post',.045,.06,.43,[0,.32,0],'charcoal');
  for(let i=0;i<5;i++){let a=i*Math.PI*.4;let e=[Math.sin(a)*.32,.09,Math.cos(a)*.32];rod(g,'Spoke',[0,.12,0],e,.025,'charcoal');ell(g,'Caster',[.055,.055,.045],e,'charcoal');}
  box(g,'Seat',[.66,.13,.65],[0,.60,0],'sage',.09);box(g,'BackFrame',[.66,.63,.13],[0,.97,.28],'cream',.08);box(g,'BackCushion',[.57,.52,.08],[0,.98,.20],'sage',.065);
  for(const x of [-.37,.37]){rod(g,'ArmSupport',[x,.59,.13],[x,.87,.1],.023,'cream');box(g,'Armrest',[.08,.06,.42],[x,.87,.03],'cream',.03);}return compact(g);}
export function desk(name='Desk',kind='code'){
  const g=group(name);box(g,'Top',[2.45,.13,1.16],[0,1.04,0],'oakLight',.075);
  for(const x of [-1.02,1.02])box(g,'Leg',[.10,.96,.87],[x,.49,0],'oak',.025);
  box(g,'Cabinet',[.57,.79,.82],[-.73,.51,-.05],'cream',.045);
  for(let i=0;i<3;i++){box(g,'Drawer',[.51,.23,.025],[-.73,.29+i*.24,.378],'wall',.014);box(g,'Pull',[.15,.025,.035],[-.73,.32+i*.24,.405],'brass',.01);}
  box(g,'DeskMat',[1.22,.012,.5],[.2,1.112,.22],'sage',.015);
  const monitor=(x,w=.88)=>{box(g,'ScreenBase',[.36,.035,.24],[x,1.13,-.28],'charcoal');cyl(g,'ScreenStem',.027,.027,.21,[x,1.25,-.30],'charcoal');box(g,'Monitor',[w,.59,.065],[x,1.58,-.29],'charcoal',.026);box(g,'Display',[w-.065,.51,.008],[x,1.58,-.252],'screen',.008);
    for(let i=0;i<6;i++){let l=(w-.14)*(.35+((i*3)%5)*.11);box(g,'ScreenLine',[l,.012,.003],[x-(w-.14)/2+l/2,1.77-i*.066,-.246],['sageLight','blue','cream'][i%3],.001);}box(g,'StatusDot',[.018,.014,.006],[x,1.306,-.25],'sageLight',.006);};
  if(kind==='research'){monitor(-.26,.77);monitor(.58,.77);}else monitor(.2,1.08);
  if(kind==='design'){box(g,'Tablet',[.73,.035,.44],[.21,1.145,.2],'charcoal',.025);box(g,'TabletSheet',[.62,.008,.34],[.21,1.168,.2],'blue',.012);for(let i=0;i<3;i++)box(g,'Swatch',[.12,.008,.14],[.02+i*.16,1.176,.21],['terra','cream','sage'][i],.02);rod(g,'Stylus',[.6,1.16,.06],[.76,1.16,.3],.012,'charcoal');}
  else {box(g,'Keyboard',[.7,.035,.23],[.18,1.145,.22],'cream',.018);for(let row=0;row<3;row++)for(let col=0;col<10;col++)box(g,'Key',[.047,.012,.042],[-.10+col*.062,1.167,.15+row*.065],'wall',.004);ell(g,'Mouse',[.065,.032,.10],[.72,1.147,.22],'cream');}
  mug(g,[-.94,1.11,.18]);const p=plant('DeskPlant',.38);p.position.set(.98,1.11,-.34);g.add(p);
  box(g,'Notebook',[.30,.045,.38],[-.60,1.13,-.27],'terra',.014);box(g,'Pages',[.275,.014,.355],[-.60,1.157,-.27],'paper',.006);
  return compact(g);
}
export function worker(name='Worker',color='blue',style=0){
  const g=group(name);g.userData={assetType:'employee',forward:'+Z',rig:'rigid hierarchical pivots; not skinned'};
  const hips=group(name+'_Hips',g);hips.position.y=.74;
  ell(hips,'Trousers',[.24,.17,.2],[0,0,0],'charcoal');
  for(const x of [-.135,.135]){rod(hips,'Thigh',[x,0,0],[x,-.04,.34],.09,'charcoal');ell(hips,'Knee',[.091,.091,.091],[x,-.04,.34],'charcoal');rod(hips,'Shin',[x,-.04,.34],[x,-.59,.38],.075,'charcoal');box(hips,'Shoe',[.17,.11,.29],[x,-.67,.43],'cream',.045);box(hips,'Sole',[.18,.025,.3],[x,-.721,.43],'wall',.014);}
  const body=group(name+'_Body',g);body.position.set(0,.88,0);
  ell(body,'Sweater',[.27,.33,.21],[0,.20,0],color);cyl(body,'Neck',.075,.082,.12,[0,.51,0],'skin');torus(body,'Collar',.086,.022,[0,.495,0],'cream',[Math.PI/2,0,0]);
  const head=group(name+'_Head',body);head.position.set(0,.74,.015);
  ell(head,'Face',[.255,.285,.235],[0,0,0],'skin');ell(head,'HairCap',[.269,.175,.249],[0,.166,-.028],'hair');ell(head,'HairBack',[.25,.24,.12],[0,.05,-.17],'hair');
  for(let i=0;i<5;i++)ell(head,'Fringe',[.086,.085,.06],[-.18+i*.085,.17+Math.sin(i)*.025,.172],'hair',[0,0,-.32]);
  for(const x of [-.253,.253])ell(head,'Ear',[.045,.068,.047],[x,-.01,0],'skin');
  for(const x of [-.085,.085]){ell(head,'Eye',[.019,.026,.012],[x,.014,.226],'charcoal');ell(head,'Blush',[.041,.02,.006],[x*1.6,-.053,.203],'terra');}
  ell(head,'Nose',[.026,.028,.036],[0,-.028,.24],'skin');box(head,'Smile',[.048,.009,.007],[0,-.106,.218],'hair',.004);
  if(style===1){ell(head,'Bun',[.14,.14,.14],[0,.20,-.24],'hair');torus(head,'HairTie',.10,.015,[0,.2,-.27],'terra');}
  if(style===2){ell(head,'Beret',[.29,.105,.25],[.018,.296,0],'terra',[0,0,-.13]);ell(head,'BeretTip',[.025,.045,.026],[.015,.4,0],'terra');}
  if(style===3){for(const x of [-.087,.087])torus(head,'Glasses',.066,.009,[x,.016,.245],'charcoal');rod(head,'Bridge',[-.021,.017,.246],[.021,.017,.246],.008,'charcoal');}
  const arms=[];
  for(const [i,x] of [-.27,.27].entries()){const a=group(name+(i?'_ArmR':'_ArmL'),body);a.position.set(x,.38,0);ell(a,'Shoulder',[.094,.094,.094],[0,0,0],color);rod(a,'Sleeve',[0,0,0],[x*.16,-.20,.16],.09,color);ell(a,'Elbow',[.09,.09,.09],[x*.16,-.20,.16],color);rod(a,'Forearm',[x*.16,-.20,.16],[-x*.2,-.17,.42],.065,color);ell(a,'Hand',[.07,.045,.08],[-x*.2,-.17,.47],'skin');arms.push(a);}
  const q=(x,y=0,z=0)=>new T.Quaternion().setFromEuler(new T.Euler(x,y,z)).toArray();
  const track=(obj,times,values)=>new T.QuaternionKeyframeTrack(obj.name+'.quaternion',times,values.flat());
  const idle=new T.AnimationClip('Idle',4,[track(body,[0,2,4],[q(-.012),q(.018),q(-.012)]),track(head,[0,2,4],[q(0,-.03),q(.025,.03),q(0,-.03)])]);
  const working=new T.AnimationClip('Working',1.2,[track(arms[0],[0,.3,.6,.9,1.2],[q(-.025),q(.09),q(-.025),q(.07),q(-.025)]),track(arms[1],[0,.3,.6,.9,1.2],[q(.08),q(-.02),q(.07),q(-.02),q(.08)]),track(head,[0,.6,1.2],[q(.08),q(.11),q(.08)])]);
  const error=new T.AnimationClip('Error',2.4,[track(head,[0,.6,1.2,1.8,2.4],[q(0),q(-.04,-.12,.08),q(-.04,.12,-.06),q(-.04,-.12,.08),q(0)])]);
  compact(hips);compact(head);arms.forEach(compact);
  const torso=group(name+'_Torso',body);for(const child of [...body.children])if(child.isMesh)torso.attach(child);compact(torso);
  g.animations=[idle,working,error];return g;
}
export function consoleDesk(name='Console'){const g=group(name);box(g,'Body',[2.15,.88,1.18],[0,.46,0],'sage',.15);box(g,'Top',[2.30,.12,1.3],[0,.96,0],'oakLight',.1);for(let i=0;i<9;i++)box(g,'Flute',[.022,.62,.02],[-.88+i*.22,.45,.598],'sageLight',.008);
  const robot=group('Coordinator',g);robot.position.set(0,1.04,0);ell(robot,'Body',[.17,.19,.14],[0,.16,0],'cream');box(robot,'Head',[.48,.34,.29],[0,.44,0],'cream',.095);box(robot,'Face',[.36,.22,.025],[0,.44,.151],'charcoal',.075);for(const x of [-.085,.085])ell(robot,'Eye',[.024,.04,.012],[x,.45,.17],'sageLight');for(const x of [-.18,.18])ell(robot,'Foot',[.075,.05,.11],[x,.03,.045],'cream');const p=plant('ConsolePlant',.58);p.position.set(.72,1.03,-.12);g.add(p);box(g,'Book',[.35,.06,.28],[-.7,1.05,.09],'blue',.01);return compact(g);}
export function lounge(name='Lounge'){const g=group(name);box(g,'Base',[1.9,.30,.83],[0,.30,0],'sage',.12);box(g,'Back',[1.9,.72,.22],[0,.73,-.34],'sage',.11);for(const x of [-.9,.9])box(g,'Arm',[.22,.55,.87],[x,.59,0],'sage',.10);for(const x of [-.42,.42])box(g,'Cushion',[.79,.18,.65],[x,.51,.03],'sageLight',.08);box(g,'Pillow',[.38,.37,.13],[.5,.82,-.10],'terra',.075,[.1,0,-.15]);return compact(g);}
export function room(name='Room'){
  const g=group(name);box(g,'Foundation',[12.4,.30,9.8],[0,-.17,0],'cream',.13);box(g,'Floor',[12.12,.05,9.5],[0,.005,0],'oakLight',.02);
  for(let i=0;i<32;i++){const z=-4.58+i*.295;box(g,'FloorJoint',[12.0,.001,.009],[0,.032,z],'oak',.001);for(let j=0;j<4;j++)box(g,'PlankEnd',[.008,.001,.285],[-4.8+j*3.1+(i%3)*.62,.033,z+.143],'oak',.001);}
  // Rear window opening is built from wall pieces; no opaque wall behind the glazing.
  box(g,'RearSillWall',[12.2,.83,.18],[0,.415,-4.7],'wall',.055);box(g,'RearLintel',[12.2,.35,.18],[0,3.04,-4.7],'wall',.055);
  for(const [x,w] of [[-5.85,.5],[.9,.5],[3.50,5.10]])box(g,'RearPier',[w,2.2,.18],[x,1.85,-4.7],'wall',.04);
  box(g,'WindowSky',[6.25,1.95,.03],[-2.5,1.85,-4.73],'#c2d4ce',.01);
  for(const x of [-5.68,-3.55,-1.45,.67])box(g,'WindowMullion',[.09,2.05,.18],[x,1.85,-4.59],'cream',.018);
  for(const y of [.83,2.86])box(g,'WindowFrame',[6.5,.10,.24],[-2.5,y,-4.60],'cream',.025);
  box(g,'WindowSill',[6.7,.10,.47],[-2.5,.82,-4.48],'oakLight',.03);
  box(g,'LeftWall',[.18,3.2,9.5],[-6.05,1.59,0],'wall',.07);
  box(g,'RearSkirting',[12.0,.12,.055],[0,.095,-4.57],'cream',.015);box(g,'LeftSkirting',[.055,.12,9.45],[-5.94,.095,0],'cream',.015);
  for(const [x,col] of [[3.2,'blue'],[4.55,'sage']]){box(g,'PictureFrame',[.92,1.0,.06],[x,2.25,-4.54],'oak',.018);box(g,'PicturePaper',[.80,.88,.015],[x,2.25,-4.50],'paper',.01);ell(g,'PictureCircle',[.23,.23,.012],[x,2.35,-4.48],col);box(g,'PictureShape',[.55,.22,.012],[x,1.99,-4.465],'terra',.035);}
  return compact(g);
}
export function studio(){const g=group('Studio');g.add(room());const clips=[];const labels=[];
  const positions=[[-3.8,-2.85,0,'research','cream',1,'研究员'],[0,-2.85,0,'code','blue',0,'工程师'],[3.8,-2.85,0,'design','terra',2,'设计师'],[-3.8,2.40,Math.PI,'document','sage',3,'档案员'],[3.8,2.40,Math.PI,'code','blue',0,'助理']];
  positions.forEach(([x,z,r,kind,color,style,label],i)=>{const station=group('Station_'+i,g);station.position.set(x,0,z);station.rotation.y=r;station.add(desk('Desk_'+i,kind));const c=chair('Chair_'+i);c.position.z=.82;station.add(c);const w=worker('Employee_'+i,color,style);w.position.set(0,.035,.82);w.rotation.y=Math.PI;station.add(w);clips.push(...w.animations);labels.push({name:label,anchor:[x,2.27,z],station:i});});
  const rug=cyl(g,'CentralRug',1,1,.018,[0,.044,.65],'rug',[0,0,0],48);rug.scale.set(1.8,1,1.3);g.add(consoleDesk());g.children.at(-1).position.z=.6;
  const s=shelf();s.rotation.y=Math.PI/2;s.position.set(-5.68,0,.10);g.add(s);
  const l=lounge();l.rotation.y=Math.PI/2;l.position.set(-5.45,0,3.45);g.add(l);
  for(const [x,z,scale] of [[5.45,-4.02,1.55],[-5.3,-4.1,.75],[5.45,4.04,1.5],[-5.42,-1.40,1.1]]){const p=plant('FloorPlant',scale);p.position.set(x,0,z);g.add(p);}
  for(const x of [-4.5,-1.1]){const p=plant('SillPlant',.55);p.position.set(x,.88,-4.45);g.add(p);}
  g.userData={units:'meters',upAxis:'Y',forward:'+Z',visualReference:'docs/assets/studio-visual-reference-v1.png',labels,description:'Procedural first-pass asset kit; five stations chosen for readable spacing.'};
  return {scene:g,animations:['Idle','Working','Error'].map(name=>{const matches=clips.filter(c=>c.name===name);return new T.AnimationClip(name,matches[0].duration,matches.flatMap(c=>c.tracks));})};
}

export const assets={room:()=>({scene:room()}),desk:()=>({scene:desk()}),chair:()=>({scene:chair()}),employee:()=>{const s=worker();return {scene:s,animations:s.animations};},plant:()=>({scene:plant()}),bookshelf:()=>({scene:shelf()}),console:()=>({scene:consoleDesk()}),sofa:()=>({scene:lounge()}),studio};
