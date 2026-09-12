import * as T from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {mergeGeometries,mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';

export const palette={cream:'#f0eade',wall:'#e7dccd',oak:'#dbc09c',oakDark:'#b89b73',sage:'#84937b',sageLight:'#a2ae94',blue:'#7897ad',terra:'#b9795d',charcoal:'#35434a',screen:'#ffffff',skin:'#e8b899',hair:'#47362d',hairLight:'#554033',leaf:'#52744a',leafLight:'#7f965e',paper:'#f6f0df',brass:'#bbaa87',rug:'#cbc2b2',white:'#faf5e9'};
const materials=new Map(),geometries=new Map();
function material(color,texture){const c=palette[color]||color;const key=c+texture;
  if(!materials.has(key)){let m=new T.MeshStandardMaterial({name:texture||color,color:c,roughness:color==='charcoal'?.58:.83});if(texture){m.userData.textureKey=texture;}materials.set(key,m);}return materials.get(key);}
const group=(name,p)=>{const g=new T.Group();g.name=name;p?.add(g);return g;};
function geo(key,fn){if(!geometries.has(key))geometries.set(key,fn());return geometries.get(key);}
function mesh(p,name,g,c,pos=[0,0,0],rot=[0,0,0],texture){let o=new T.Mesh(g,material(c,texture));o.name=name;o.position.set(...pos);o.rotation.set(...rot);o.castShadow=true;o.receiveShadow=true;p.add(o);return o;}
function box(p,n,s,pos,c='cream',r=.025,rot=[0,0,0],tex){r=Math.min(r,...s.map(v=>v*.47));return mesh(p,n,geo('b'+s+r,()=>new RoundedBoxGeometry(...s,Math.max(...s)<.20||Math.min(...s)<.018?1:2,r)),c,pos,rot,tex);}
function ell(p,n,s,pos,c='cream',rot=[0,0,0]){const o=mesh(p,n,geo('sphere',()=>new T.SphereGeometry(1,24,16)),c,pos,rot);o.scale.set(...s);return o;}
function cyl(p,n,r1,r2,h,pos,c='cream',rot=[0,0,0],tex){return mesh(p,n,geo('c'+[r1,r2,h],()=>new T.CylinderGeometry(r1,r2,h,24)),c,pos,rot,tex);}
function torus(p,n,r,t,pos,c,rot=[0,0,0]){return mesh(p,n,geo('tor'+r+t,()=>new T.TorusGeometry(r,t,8,32)),c,pos,rot);}
function roundedShape(w,d,r){const s=new T.Shape(),x=-w/2,y=-d/2; s.moveTo(x+r,y);s.lineTo(x+w-r,y);s.quadraticCurveTo(x+w,y,x+w,y+r);s.lineTo(x+w,y+d-r);s.quadraticCurveTo(x+w,y+d,x+w-r,y+d);s.lineTo(x+r,y+d);s.quadraticCurveTo(x,y+d,x,y+d-r);s.lineTo(x,y+r);s.quadraticCurveTo(x,y,x+r,y);return s;}
// Independent plan radius: thin tabletops and floor slabs keep generous rounded corners.
function slab(p,n,w,d,h,r,pos,c='cream',tex){const g=geo('slab'+[w,d,h,r],()=>{const q=new T.ExtrudeGeometry(roundedShape(w,d,r),{depth:h,bevelEnabled:true,bevelSize:Math.min(.025,h*.2),bevelThickness:Math.min(.025,h*.2),bevelSegments:2,curveSegments:10,steps:1});q.translate(0,0,-h/2);q.rotateX(-Math.PI/2);return q;});return mesh(p,n,g,c,pos,[0,0,0],tex);}
function tube(p,n,points,radii,c,tex,segments=18){
  const curve=new T.CatmullRomCurve3(points.map(a=>new T.Vector3(...a))),frames=curve.computeFrenetFrames(segments,false),pos=[],uv=[],indices=[];const sides=12;
  for(let i=0;i<=segments;i++){const t=i/segments,v=curve.getPointAt(t),u=t*(radii.length-1),j=Math.min(Math.floor(u),radii.length-2),r=T.MathUtils.lerp(radii[j],radii[j+1],u-j);
    for(let k=0;k<=sides;k++){const a=k/sides*Math.PI*2,offset=frames.normals[i].clone().multiplyScalar(Math.cos(a)*r).addScaledVector(frames.binormals[i],Math.sin(a)*r);pos.push(v.x+offset.x,v.y+offset.y,v.z+offset.z);uv.push(k/sides,t);if(i<segments&&k<sides){let a=i*(sides+1)+k,b=a+sides+1;indices.push(a,a+1,b,b,a+1,b+1);}}}
  const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();return mesh(p,n,g,c,[0,0,0],[0,0,0],tex);
}
function line(p,n,a,b,r,c){return tube(p,n,[a,b],[r,r],c,undefined,1);}
function picture(p,n,w,h,pos,key,rot=[0,0,0]){const q=group(n,p);q.position.set(...pos);q.rotation.set(...rot);box(q,'Frame',[w+.10,h+.10,.08],[0,0,0],'oak',.018);box(q,'Inset',[w+.025,h+.025,.012],[0,0,.045],'cream',.004);mesh(q,'Print',new T.PlaneGeometry(w,h),'white',[0,0,.054],[0,0,0],key);return q;}
export function compact(p){p.updateMatrixWorld(true);let inv=p.matrixWorld.clone().invert(),buckets=new Map();p.traverse(o=>{if(!o.isMesh)return;let arr=buckets.get(o.material);if(!arr)buckets.set(o.material,arr=[]);let g=o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone();g.applyMatrix4(inv.clone().multiply(o.matrixWorld));arr.push(g);});p.clear();for(const [m,arr] of buckets){const merged=mergeGeometries(arr),g=mergeVertices(merged);merged.dispose();const o=new T.Mesh(g,m);o.name=p.name+'_'+m.name;o.castShadow=true;o.receiveShadow=true;p.add(o);arr.forEach(g=>g.dispose());}return p;}
function grainBox(p,n,s,pos,color='white',rot=[0,0,0]){return box(p,n,s,pos,color,.022,rot,'oak');}
function book(p,pos,size=[.32,.065,.40],c='sage',angle=0){const g=group('Book',p);g.position.set(...pos);g.rotation.y=angle;box(g,'Paper',[size[0]-.02,size[1]*.65,size[2]-.014],[0,0,0],'paper',.004);for(const y of [-size[1]/2,size[1]/2])box(g,'Cover',[size[0],.009,size[2]],[0,y,0],c,.006);box(g,'Spine',[.015,size[1],size[2]],[size[0]/2,0,0],c,.006);}
function standingBooks(p,pos,count=6){for(let i=0;i<count;i++){const h=.31+(i%3)*.035,w=.075+(i%2)*.014,x=pos[0]+i*.10;const c=['sage','cream','blue','terra','paper'][i%5];box(p,'Binder',[w,h,.24],[x,pos[1]+h/2,pos[2]],c,.006);box(p,'BinderLabel',[w*.62,.10,.003],[x,pos[1]+h*.7,pos[2]+.123],'paper',.002);for(const y of [.025,.045])box(p,'SpineStripe',[w*.68,.004,.004],[x,pos[1]+y,pos[2]+.124],'brass',.001);}}
function mug(p,pos,c='cream'){const g=group('Mug',p);g.position.set(...pos);cyl(g,'Ceramic',.080,.07,.15,[0,.076,0],c);torus(g,'Rim',.074,.009,[0,.153,0],c,[Math.PI/2,0,0]);cyl(g,'Coffee',.065,.065,.003,[0,.146,0],'hair');torus(g,'Handle',.048,.013,[.095,.086,0],c);return g;}
function pot(p,pos,r=.23,c='cream'){const g=group('Pot',p);g.position.set(...pos);cyl(g,'Ceramic',r,r*.76,r*1.5,[0,r*.75,0],c);torus(g,'Lip',r*.98,r*.055,[0,r*1.51,0],c,[Math.PI/2,0,0]);cyl(g,'Earth',r*.91,r*.91,.013,[0,r*1.5,0],'hair');return g;}
function leaf(p,n,start,end,width,color='leaf',split=false){const a=new T.Vector3(...start),b=new T.Vector3(...end),direction=b.clone().sub(a),len=direction.length();const vertices=[],uv=[],idx=[],rows=12,cols=8;
  for(let i=0;i<=rows;i++){const t=i/rows;for(let j=0;j<=cols;j++){const u=j/cols*2-1;let w=Math.pow(Math.sin(Math.PI*t),.72)*width; if(split)w*=1-.21*Math.pow(Math.sin(t*Math.PI*5),4);vertices.push(u*w,len*t,.11*len*Math.sin(Math.PI*t)+.13*len*u*u*Math.sin(Math.PI*t));uv.push(j/cols,t);if(i<rows&&j<cols){let v=i*(cols+1)+j;idx.push(v,v+1,v+cols+1,v+1,v+cols+2,v+cols+1);}}}
  const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(vertices,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();const o=mesh(p,n,g,color,start);o.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),direction.normalize());o.material.side=T.DoubleSide;line(p,'LeafVein',start,end,.004,'leafLight');return o;
}
export function plant(name='Plant',scale=1,type='broad'){const g=group(name);pot(g,[0,0,0],.23,type==='trailing'?'sage':'cream');
  if(type==='trailing'){for(let branch=0;branch<4;branch++){const a=branch*1.8;const pts=[[0,.37,0],[Math.cos(a)*.23,.44,Math.sin(a)*.23],[Math.cos(a)*.35,.05,Math.sin(a)*.35],[Math.cos(a)*.41,-.48,Math.sin(a)*.41]];tube(g,'Vine',pts,[.012,.012,.008,.003],'leaf',undefined,12);for(let i=0;i<6;i++){const t=i/5,base=[Math.cos(a)*(.22+t*.20),.38-t*.80,Math.sin(a)*(.22+t*.20)],end=[base[0]+Math.sin(a)*(i%2?.18:-.18),base[1]-.12,base[2]+Math.cos(a)*.13];leaf(g,'Pothos',base,end,.12,i%2?'leafLight':'leaf');}}}
  else{const count=type==='tall'?11:10;for(let i=0;i<count;i++){const a=i*2.399,h=(type==='tall'?1.22:.65)+(i%4)*.16,rad=.23+(i%3)*.1;const stem=[Math.cos(a)*rad*.7,h*.72,Math.sin(a)*rad*.7],end=[Math.cos(a)*rad*1.7,h,Math.sin(a)*rad*1.7];tube(g,'Stem',[[0,.32,0],[Math.cos(a)*.06,h*.5,Math.sin(a)*.06],stem],[.012,.009,.005],'leaf',undefined,8);leaf(g,'Leaf',stem,end,type==='tall'?.16:.16,i%3?'leaf':'leafLight',type==='tall');}}
  g.scale.setScalar(scale);return compact(g);}

export function chair(name='Chair'){
  const g=group(name);cyl(g,'Lift',.035,.045,.41,[0,.31,0],'charcoal');
  for(let i=0;i<5;i++){const a=i*Math.PI*.4,x=Math.sin(a)*.34,z=Math.cos(a)*.34;tube(g,'StarFoot',[[0,.18,0],[x*.6,.13,z*.6],[x,.10,z]],[.027,.023,.02],'charcoal',undefined,6);cyl(g,'Caster',.050,.050,.054,[x,.065,z],'charcoal',[0,0,Math.PI/2]);}
  slab(g,'SeatShell',.70,.67,.07,.15,[0,.575,0],'cream');slab(g,'SeatPad',.64,.61,.11,.14,[0,.64,-.012],'sage','fabric');
  const back=group('Back',g);back.position.set(0,1.02,.27);back.rotation.x=.10;const shell=slab(back,'BackShell',.71,.67,.07,.15,[0,0,0],'cream');shell.rotation.x=Math.PI/2;const cushion=slab(back,'BackCushion',.62,.57,.05,.12,[0,0,-.053],'sage','fabric');cushion.rotation.x=Math.PI/2;
  for(const x of [-.36,.36]){tube(g,'Arm',[[x,.59,.17],[x,.85,.19],[x,.86,-.22]],[.022,.023,.025],'cream',undefined,10);box(g,'ArmPad',[.085,.045,.37],[x,.878,-.04],'cream',.02);}
  return compact(g);
}
function monitor(g,x,z,w,key,angle=0){const q=group('Monitor',g);q.position.set(x,1.115,z);q.rotation.y=angle;slab(q,'Foot',.39,.27,.026,.07,[0,.016,0],'charcoal');box(q,'Stem',[.065,.18,.055],[0,.105,-.05],'charcoal',.016);box(q,'DisplayCase',[w,.61,.048],[0,.46,-.025],'charcoal',.022);mesh(q,'DisplayImage',new T.PlaneGeometry(w-.045,.558),'white',[0,.467,.001],[0,0,0],'screen-'+key);box(q,'PowerLED',[.017,.008,.006],[.36,.173,.004],'sageLight',.002);}
function keyboard(g,pos){const q=group('Keyboard',g);q.position.set(...pos);slab(q,'Case',.69,.24,.025,.035,[0,0,0],'cream');for(let y=0;y<3;y++)for(let x=0;x<10;x++)box(q,'Key',[.049,.010,.048],[-.284+x*.063,.02,-.075+y*.064],x===9?'sageLight':'white',.008);box(q,'Space',[.24,.010,.035],[0,.02,.1],'white',.008);}
export function desk(name='Desk',kind='code'){
  const g=group(name);slab(g,'OakTop',2.48,1.20,.11,.15,[0,1.047,0],'white','oak');
  for(const x of [-1.05,1.05])for(const z of [-.43,.43])grainBox(g,'TaperedLeg',[.105,.94,.105],[x,.53,z],'#e8dfcc',[0,0,x*.025]);grainBox(g,'Apron',[2.1,.13,.065],[0,.92,-.44]);
  box(g,'Cabinet',[.57,.74,.87],[.76,.50,0],'sage',.045);for(let i=0;i<3;i++){box(g,'Drawer',[.52,.222,.032],[.76,.268+i*.228,.445],'sage',.014);box(g,'InsetPull',[.13,.029,.008],[.76,.32+i*.228,.465],'oakDark',.008);}
  slab(g,'DeskMat',1.22,.49,.009,.06,[.02,1.11,.215],'#a6b097');
  if(kind==='archive'){
    for(let i=0;i<4;i++)book(g,[-.48,1.155+i*.042,-.21],[.43,.041,.32],['cream','sage','terra','paper'][i],i*.06);
    for(let i=0;i<5;i++){box(g,'FileFolder',[.06,.32,.3],[.2+i*.071,1.273,-.25],i%2?'oak':'cream',.004);box(g,'FolderTab',[.05,.055,.025],[.2+i*.071,1.445,-.12],'paper',.004);}box(g,'PaperTray',[.43,.04,.33],[.5,1.14,.25],'oak',.009);
  }else{
    if(kind==='research'){monitor(g,-.47,-.32,.93,'map',.07);monitor(g,.51,-.32,.93,'research',-.07);}else monitor(g,.03,-.33,1.18,kind==='idle'?'document':kind);
    if(kind==='design'){const tablet=slab(g,'PenTablet',.84,.49,.045,.04,[0,1.15,.19],'charcoal');mesh(g,'TabletArt',new T.PlaneGeometry(.74,.39),'white',[0,1.18,.19],[-Math.PI/2,0,0],'screen-design');line(g,'Pen',[.51,1.14,.06],[.67,1.15,.35],.013,'charcoal');}
    else {keyboard(g,[0,1.137,.20]);ell(g,'Mouse',[.058,.025,.092],[.59,1.14,.23],'cream');}
  }
  const p=plant('DeskPlant',.33);p.position.set(-1.02,1.108,-.38);g.add(p);if(kind!=='archive'){book(g,[-.84,1.15,.07],[.29,.05,.36],'blue',.09);book(g,[-.84,1.20,.07],[.29,.04,.36],'paper',.03);}mug(g,[.99,1.108,.27]);
  if(kind==='code'){box(g,'Tower',[.21,.43,.40],[.93,1.32,-.28],'cream',.025);box(g,'TowerVent',[.08,.18,.014],[.93,1.31,-.069],'sage',.007);}
  if(kind==='design'){cyl(g,'PencilPot',.066,.057,.14,[.98,1.18,-.30],'terra');for(let i=0;i<4;i++)line(g,'Pencil',[.94+i*.026,1.19,-.3],[.92+i*.034,1.44+(i%2)*.04,-.31],.009,['brass','blue','sage','charcoal'][i]);}
  return compact(g);
}

function scalp(p,style){const seg=40,rows=20,pos=[],uv=[],idx=[],rx=.266,ry=.285,rz=.248;
  for(let i=0;i<=rows;i++)for(let j=0;j<=seg;j++){const phi=j/seg*Math.PI*2;const front=(Math.cos(phi)+1)/2;const max=2.15-.90*Math.pow(front,3);const theta=.005+i/rows*max;pos.push(rx*Math.sin(theta)*Math.sin(phi),.024+ry*Math.cos(theta),rz*Math.sin(theta)*Math.cos(phi)-.014);uv.push(j/seg,i/rows);if(i<rows&&j<seg){let a=i*(seg+1)+j,b=a+seg+1;idx.push(a,b,a+1,a+1,b,b+1);}}
  const geom=new T.BufferGeometry();geom.setAttribute('position',new T.Float32BufferAttribute(pos,3));geom.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geom.setIndex(idx);geom.computeVertexNormals();mesh(p,'SculptedHair',geom,'hair');
  if(style===1){ell(p,'Bun',[.135,.13,.12],[.01,.14,-.27],'hair');torus(p,'HairTie',.08,.012,[.01,.13,-.32],'brass');}
  if(style===2||style===4){for(let i=0;i<12;i++){const phi=.75+i/11*(Math.PI*2-1.5),x=Math.sin(phi)*.235,z=Math.cos(phi)*.22;tube(p,'BobLock',[[x*.8,.18,z*.8],[x,.02,z],[x*.96,-.20,z+.015],[x*.90,-.28,z+.04]],[.050,.056,.043,.004],i%3?'hair':'hairLight',undefined,14);}}
  for(let i=0;i<9;i++){const x=-.20+i*.045;const t=i/8;tube(p,'SweptFringe',[[x*.44-.045,.27,.045],[x*.85-.025,.225,.15],[x,.135+Math.sin(t*Math.PI)*.012,.216],[x+.025,.078+Math.abs(t-.4)*.10,.22]],[.005,.046,.042,.002],i%3?'hair':'hairLight',undefined,14);}
  for(let i=0;i<10;i++){const a=.4+i*.57; tube(p,'CrownStrand',[[Math.sin(a)*.05,.305,Math.cos(a)*.045],[Math.sin(a)*.17,.26,Math.cos(a)*.15],[Math.sin(a)*.252,.10,Math.cos(a)*.228]],[.003,.009,.003],'hairLight',undefined,14);}
  if(style===2){ell(p,'Beret',[.284,.087,.256],[.027,.32,-.004],'terra',[0,0,-.12]);tube(p,'BeretTip',[[.04,.40,0],[.04,.439,.012]],[.017,.01],'terra',undefined,4);}
}
function shoe(p,x){const g=group('Sneaker',p);g.position.set(x,.085,.45);slab(g,'Sole',.19,.34,.032,.06,[0,-.04,0],'cream');ell(g,'Upper',[.089,.065,.145],[0,.02,-.01],'white');for(let i=0;i<3;i++)line(g,'Lace',[-.05,.077,-.03+i*.025],[.05,.077,-.03+i*.025],.005,'cream');}
export function worker(name='Worker',color='blue',style=0,pose='typing'){
  const g=group(name);g.userData={assetType:'employee',forward:'+Z',rig:'hierarchical rigid part animation; sculpted procedural meshes'};
  const hips=group(name+'_Hips',g);ell(hips,'Seat',[.245,.13,.19],[0,.77,0],'charcoal');
  for(const x of [-.135,.135]){tube(hips,'TrouserLeg',[[x,.79,0],[x,.76,.21],[x,.66,.36],[x,.41,.385],[x,.16,.39]],[.112,.110,.095,.078,.075],'charcoal',undefined,22);torus(hips,'TrouserHem',.074,.006,[x,.177,.389],'charcoal',[Math.PI/2,0,0]);shoe(hips,x);}
  const body=group(name+'_Body',g);body.position.y=.89;
  const outline=[[.0,-.18],[.16,-.17],[.24,-.11],[.254,.10],[.24,.28],[.20,.38],[.11,.43],[0,.43]];const shape=new T.LatheGeometry(outline.map(p=>new T.Vector2(...p)),32);const torso=mesh(body,'TailoredSweater',shape,color,[0,.15,0],[0,0,0],'fabric');torso.scale.z=.83;
  torus(body,'SweaterHem',.232,.020,[0,.05,0],color,[Math.PI/2,0,0]).scale.y=.81;
  cyl(body,'Neck',.069,.081,.15,[0,.54,.015],'skin');torus(body,'Collar',.086,.020,[0,.505,.015],color,[Math.PI/2,0,0]);
  if(color==='blue'){const hood=ell(body,'Hood',[.19,.09,.13],[0,.42,-.14],color);for(const x of [-.065,.065])tube(body,'Drawstring',[[x,.49,.105],[x*.8,.40,.178],[x*.9,.33,.185]],[.008,.008,.006],'cream',undefined,8);}
  const head=group(name+'_Head',body);head.position.set(0,.76,.018);ell(head,'Head',[.25,.278,.226],[0,0,0],'skin');scalp(head,style);
  for(const x of [-.252,.252]){ell(head,'Ear',[.039,.060,.031],[x,-.022,-.002],'skin');ell(head,'InnerEar',[.018,.033,.012],[x*1.055,-.026,.014],'#dba58d');}
  for(const x of [-.079,.079]){ell(head,'Eye',[.014,.021,.009],[x,-.001,.225],'charcoal');ell(head,'EyeGlint',[.004,.005,.002],[x-.003,.006,.233],'white');tube(head,'Eyebrow',[[x-.032,.062,.214],[x,.068,.227],[x+.024,.059,.218]],[.004,.008,.003],'hair',undefined,8);}
  ell(head,'Nose',[.022,.023,.019],[0,-.047,.235],'skin');tube(head,'Smile',[[-.026,-.105,.21],[0,-.115,.214],[.030,-.103,.207]],[.003,.004,.002],'hair',undefined,8);
  if(style===3){for(const x of [-.082,.082])torus(head,'Spectacles',.064,.008,[x,.0,.246],'charcoal');line(head,'Bridge',[-.018,.007,.246],[.018,.007,.246],.005,'charcoal');}
  const arms=[];
  for(const [i,x] of [-.22,.22].entries()){const a=group(name+(i?'_ArmR':'_ArmL'),body);a.position.set(x,.40,0);let hand=[x>0?-.035:.035,-.16,.47],elbow=[x*.30,-.23,.17];if(pose==='coffee'&&i===1){hand=[-.035,.20,.34];elbow=[.095,-.14,.11];}if(pose==='reading'){hand=[x>0?-.025:.025,.01,.44];elbow=[x*.28,-.13,.17];}
    ell(a,'RoundedShoulder',[.107,.107,.107],[0,0,0],color).material=material(color,'fabric');
    tube(a,'SoftSleeve',[[0,0,0],[x*.21,-.07,.045],elbow,[hand[0],hand[1]-.012,hand[2]-.07]],[.107,.11,.089,.063],color,'fabric',24);
    const end=new T.Vector3(hand[0],hand[1]-.012,hand[2]-.07),direction=new T.Vector3(...hand).sub(end).normalize();const cuff=torus(a,'Cuff',.063,.008,end.toArray(),color);cuff.quaternion.setFromUnitVectors(new T.Vector3(0,0,1),direction);
    ell(a,'Palm',[.060,.037,.071],hand,'skin');ell(a,'Thumb',[.023,.023,.04],[hand[0]+(i?-.048:.048),hand[1]+.006,hand[2]+.012],'skin',[0,i?-.5:.5,0]);
    if(pose==='coffee'&&i===1)mug(a,[hand[0]-.06,hand[1],hand[2]+.02],'cream');arms.push(a);}
  if(pose==='reading'){const folder=group('HeldFolder',body);folder.position.set(0,.34,.52);folder.rotation.x=-.20;box(folder,'Folder',[.43,.38,.025],[0,0,0],'oak',.008);box(folder,'Paper',[.39,.35,.005],[0,.01,-.016],'paper',.004);}
  const q=(x,y=0,z=0)=>new T.Quaternion().setFromEuler(new T.Euler(x,y,z)).toArray();const tr=(o,t,v)=>new T.QuaternionKeyframeTrack(o.name+'.quaternion',t,v.flat());
  // 幅度基准（2026-09-11 用户实测后修正）：原 Working 只有 q(.01)~q(.042)（约 2.4°），
  // 与 Idle 同量级——实机上面板已显示 working，但肉眼完全看不出动作。
  // 现在双臂在键盘上方交替起落约 12°（负 X 是抬手方向，避免手沉进桌面），
  // 并加躯干前倾与低头，读得出"在干活"。Idle 同步放大到约 2 倍，让待机有呼吸感。
  const idle=new T.AnimationClip('Idle',5,[tr(body,[0,2.5,5],[q(-.016),q(.018),q(-.016)]),tr(head,[0,2.5,5],[q(0,-.028),q(.014,.034),q(0,-.028)])]);
  // 按**姿势**给"干活"动作：六个工位共用一套摆臂是一眼能看出的假。
  // 每个动作围绕该姿势自己的静止手位做小幅运动；幅度刻意保守——我看不到画面，
  // 宁可动作小一点，也不能让手穿进桌面/脸/显示器。
  // 方向约定：负 X 是抬手（手位在身体前方偏下，正 X 会把手压进桌面）。
  const WORK = {
    // 打字：双手在键盘上方快速交替起落 + 轻微前倾
    typing: { duration: 1.6, tracks: [
      tr(arms[0],[0,.4,.8,1.2,1.6],[q(-.05,.05),q(-.22,.08),q(-.05,.04),q(-.20,.09),q(-.05,.05)]),
      tr(arms[1],[0,.4,.8,1.2,1.6],[q(-.21,-.08),q(-.05,-.04),q(-.22,-.09),q(-.05,-.03),q(-.21,-.08)]),
      tr(body,[0,.8,1.6],[q(.0),q(-.028),q(.0)]),
      tr(head,[0,.8,1.6],[q(-.02),q(-.055),q(-.02)]),
    ]},
    // 翻读卷宗：双手小幅起伏（像翻页），头随视线左右微摆
    reading: { duration: 2.4, tracks: [
      tr(arms[0],[0,.6,1.2,1.8,2.4],[q(.04,-.06),q(-.16,-.10),q(.04,-.06),q(-.13,-.13),q(.04,-.06)]),
      tr(arms[1],[0,.6,1.2,1.8,2.4],[q(-.14,.10),q(.04,.06),q(-.16,.12),q(.04,.06),q(-.14,.10)]),
      tr(body,[0,1.2,2.4],[q(.0),q(-.05),q(.0)]),
      tr(head,[0,.8,1.6,2.4],[q(-.05,.05),q(-.09,-.06),q(-.05,.06),q(-.05,.05)]),
    ]},
    // 端咖啡：右臂（马克杯挂在右臂上）小幅起落送到嘴边方向，左臂搁在桌上
    coffee: { duration: 2.4, tracks: [
      tr(arms[1],[0,.8,1.6,2.4],[q(.02),q(-.20,-.04),q(-.04),q(.02)]),
      tr(arms[0],[0,1.2,2.4],[q(.05,-.05),q(-.12,-.08),q(.05,-.05)]),
      tr(body,[0,1.2,2.4],[q(.0),q(.04),q(.0)]),
      tr(head,[0,1.2,2.4],[q(.05,-.03),q(-.07,.03),q(.05,-.03)]),
    ]},
    // 数位板绘画：双手在板面上横向小幅移动（绕 Y），偶尔抬落
    design: { duration: 2.0, tracks: [
      tr(arms[0],[0,.5,1,1.5,2],[q(-.06,.14),q(-.12,-.10),q(-.05,.06),q(-.11,-.12),q(-.06,.14)]),
      tr(arms[1],[0,.5,1,1.5,2],[q(-.05,-.12),q(-.11,.08),q(-.06,-.05),q(-.12,.10),q(-.05,-.12)]),
      tr(head,[0,1,2],[q(-.03),q(-.05),q(-.03)]),
    ]},
  }
  const workSpec = WORK[pose] ?? WORK.typing
  const working = new T.AnimationClip('Working', workSpec.duration, workSpec.tracks)
  const error=new T.AnimationClip('Error',3,[tr(head,[0,.75,1.5,2.25,3],[q(0),q(-.02,-.1,.045),q(-.02,.1,-.035),q(-.02,-.1,.045),q(0)])]);
  compact(hips);compact(head);arms.forEach(compact);const clothing=group(name+'_Clothing',body);for(const c of [...body.children])if(c.isMesh||c.name==='HeldFolder')clothing.attach(c);compact(clothing);g.animations=[idle,working,error];return g;
}

export function shelf(name='Bookshelf',low=false){const g=group(name),h=low?1.0:1.90,w=low?2.4:1.60;grainBox(g,'Back',[w,h,.045],[0,h/2,-.21],'#d9c4a1');for(const x of [-w/2,w/2])grainBox(g,'Side',[.09,h+.045,.5],[x,h/2,0]);const levels=low?[.08,.52,1.0]:[.08,.67,1.28,1.90];for(const y of levels)grainBox(g,'Shelf',[w+.1,.08,.52],[0,y,0]);for(let i=0;i<levels.length-1;i++){standingBooks(g,[-w/2+.15,levels[i]+.04,.01],i%2?5:6);box(g,'Storage',[.42,.32,.33],[w/2-.31,levels[i]+.20,.035],i%2?'sage':'cream',.02);box(g,'Label',[.15,.08,.006],[w/2-.31,levels[i]+.23,.205],'paper',.006);box(g,'LabelLine',[.10,.008,.003],[w/2-.31,levels[i]+.23,.209],'brass',.001);}return compact(g);}
function robot(g,pos){const p=group('Coordinator',g);p.position.set(...pos);ell(p,'Body',[.18,.19,.145],[0,.18,0],'cream');slab(p,'Head',.49,.32,.34,.115,[0,.47,0],'cream');const face=slab(p,'Face',.38,.24,.013,.075,[0,.47,.198],'charcoal');face.rotation.x=Math.PI/2;for(const x of [-.087,.087])tube(p,'Eye',[[x-.023,.47,.212],[x-.014,.493,.212],[x+.008,.5,.212],[x+.024,.48,.212]],[.007,.009,.009,.007],'#a0d3d5',undefined,9);for(const x of [-.15,.15])ell(p,'Foot',[.076,.05,.1],[x,.045,.07],'cream');for(const x of [-.21,.21])ell(p,'Hand',[.053,.086,.053],[x,.22,0],'cream');return compact(p);}
export function consoleDesk(name='Console'){const g=group(name);slab(g,'Plinth',2.27,1.20,.09,.21,[0,.09,0],'oakDark');slab(g,'Cabinet',2.26,1.21,.79,.20,[0,.49,0],'sage');for(const x of [-.71,0,.71])box(g,'DoorSeam',[.008,.67,.003],[x,.50,.607],'#70816c',.001);slab(g,'Top',2.45,1.39,.10,.25,[0,.93,0],'white','oak');
  mesh(g,'Label',new T.PlaneGeometry(1.50,.375),'white',[0,.50,.640],[0,0,0],'console-label');const p=plant('Plant',.51);p.position.set(.79,.99,-.07);g.add(p);book(g,[-.76,1.03,.12],[.32,.06,.27],'blue',.1);book(g,[-.74,1.09,.12],[.32,.04,.27],'cream',-.03);
  // Static furniture may be merged; Coordinator must remain an independent animation and bubble anchor.
  compact(g);robot(g,[0,.995,.02]);return g;}
export function lounge(name='Lounge'){const g=group(name);for(const x of [-.85,.85])for(const z of [-.30,.30])cyl(g,'OakLeg',.045,.030,.23,[x,.15,z],'white',[0,0,0],'oak');slab(g,'Base',2.0,.94,.25,.12,[0,.36,0],'sage','fabric');box(g,'Back',[2.0,.74,.25],[0,.76,-.35],'sage',.12,[0,0,0],'fabric');for(const x of [-.94,.94])box(g,'Arm',[.25,.55,.97],[x,.63,0],'sage',.115,[0,0,0],'fabric');for(const x of [-.43,.43]){slab(g,'SeatCushion',.79,.70,.18,.12,[x,.59,.06],'sageLight','fabric');box(g,'BackCushion',[.79,.48,.15],[x,.89,-.18],'sage',.075,[.12,0,0],'fabric');}box(g,'Pillow',[.39,.38,.14],[.53,.90,-.05],'terra',.064,[.13,0,-.15],'fabric');box(g,'Pillow',[.39,.38,.14],[-.48,.87,-.05],'cream',.064,[.13,0,.16],'fabric');return compact(g);}
export function coffeeTable(name='CoffeeTable'){const g=group(name);const top=cyl(g,'Top',.54,.54,.065,[0,.49,0],'white',[0,0,0],'oak');top.scale.z=.78;for(const a of [.1,2.2,4.3])tube(g,'Leg',[[Math.sin(a)*.29,.46,Math.cos(a)*.23],[Math.sin(a)*.36,.06,Math.cos(a)*.29]],[.039,.026],'oakDark',undefined,2);book(g,[-.10,.55,.01],[.30,.04,.26],'cream',.13);book(g,[-.10,.595,.01],[.30,.05,.26],'blue',.07);return compact(g);}
function cat(p,pos){const g=group('TinyCat',p);g.position.set(...pos);ell(g,'Body',[.09,.10,.08],[0,.095,0],'cream');ell(g,'Head',[.095,.083,.076],[0,.22,.025],'cream');for(const x of [-.06,.06]){const e=mesh(g,'Ear',new T.ConeGeometry(.035,.075,4),'cream',[x,.30,.025]);e.rotation.z=x>0?-.2:.2;ell(g,'Eye',[.006,.01,.005],[x*.6,.225,.10],'charcoal');}tube(g,'Tail',[[.05,.10,-.03],[.14,.12,-.07],[.15,.22,-.06]],[.022,.02,.011],'cream',undefined,10);}
export function room(name='Room'){
  const g=group(name);slab(g,'Foundation',12.4,10,.27,.65,[0,-.16,0],'cream');slab(g,'OakFloor',12.15,9.75,.045,.54,[0,-.008,0],'white','oak');
  // Broad physical boards with tonal variation. The grain is a texture, not floating seam lines.
  for(let row=0;row<27;row++){const z=-4.55+row*.347;for(let col=0;col<4;col++){const start=-5.68+col*2.88;const length=2.87;const b=box(g,'FloorBoard',[length,.012,.338],[start+length/2-.28,.024,z],['#f8f0e5','#f4eadb','#fff8ec','#f4eadc'][(row+col*3)%4],.003,[0,0,0],'oak');}}
  box(g,'BackLower',[12,.79,.20],[0,.43,-4.69],'wall',.06);box(g,'BackUpper',[12,.32,.20],[0,3.18,-4.69],'wall',.06);for(const [x,w] of [[-5.79,.45],[1.12,.30],[3.66,4.36]])box(g,'WallPier',[w,2.25,.20],[x,1.91,-4.69],'wall',.06);
  mesh(g,'WindowView',new T.PlaneGeometry(6.59,2.07),'white',[-2.30,1.91,-4.725],[0,0,0],'window');for(const x of [-5.64,-3.39,-1.14,1.05])box(g,'Mullion',[.085,2.18,.16],[x,1.92,-4.56],'cream',.02);for(const y of [.84,3.0])box(g,'WindowFrame',[6.85,.10,.20],[-2.30,y,-4.56],'cream',.02);grainBox(g,'WindowSill',[7.03,.10,.48],[-2.30,.83,-4.43]);
  box(g,'RightWall',[.20,3.37,9.4],[5.94,1.64,-.05],'wall',.085);box(g,'RightTrim',[.055,.12,9.3],[5.805,.105,-.05],'cream',.02);box(g,'BackTrim',[11.8,.12,.055],[0,.105,-4.56],'cream',.02);
  picture(g,'TypePoster',.64,.87,[2.13,2.48,-4.52],'poster-type');picture(g,'ArtPoster',.75,.94,[3.22,2.37,-4.52],'poster-art');
  const board=group('Moodboard',g);board.position.set(4.48,2.09,-4.51);grainBox(board,'Cork',[1.14,.88,.065],[0,0,0],'#e3caa4');for(let i=0;i<6;i++){box(board,'Swatch',[.23,.27,.005],[-.35+(i%3)*.35,.18-Math.floor(i/3)*.36,.039],['cream','terra','sage','paper','blue','oak'][i],.004,[0,0,(i%3-1)*.035]);ell(board,'Pin',[.018,.018,.01],[-.35+(i%3)*.35,.27-Math.floor(i/3)*.36,.050],'brass');}
  // Left entry marker and shelving form a soft cutaway edge, without a tall blocking wall.
  const entry=slab(g,'EntryArch',1.24,2.52,.13,.35,[-5.65,1.29,2.77],'sage');entry.rotation.x=Math.PI/2;picture(g,'EntryPrint',.72,1.06,[-5.65,1.62,2.852],'poster-type');
  return compact(g);
}

export function studio(){const g=group('Studio');g.add(room());const clips=[],labels=[];
  const stations=[[-3.72,-2.87,0,'research','cream',1,'typing','研究员'],[-.24,-2.87,0,'code','blue',0,'typing','工程师'],[3.21,-2.87,0,'design','terra',2,'typing','设计师'],[-3.76,1.84,Math.PI,'archive','sage',3,'reading','档案员'],[-.33,3.24,0,'document','terra',4,'typing','文档员'],[3.58,2.23,Math.PI,'idle','blue',0,'coffee','助理']];
  for(const [i,[x,z,r,kind,color,style,pose,label]] of stations.entries()){const station=group('Station_'+i,g);station.position.set(x,0,z);station.rotation.y=r;station.add(desk('Desk_'+i,kind));const c=chair('Chair_'+i);c.position.z=.82;station.add(c);const w=worker('Employee_'+i,color,style,pose);w.position.set(0,.014,.82);w.rotation.y=Math.PI;station.add(w);clips.push(...w.animations);labels.push({name:label,anchor:[x,2.20,z],station:i,rest:pose==='coffee'});}
  const rug=cyl(g,'StudioRug',1,1,.012,[0,.054,.32],'rug',[0,0,0],'fabric');rug.scale.set(1.95,1,1.37);const cons=consoleDesk();cons.position.set(-.02,.02,.10);g.add(cons);
  const bookcase=shelf();bookcase.position.set(-5.15,0,-.05);bookcase.rotation.y=.10;g.add(bookcase);const p1=plant('ShelfPlant',.61,'trailing');p1.position.set(-5.54,1.96,-.02);g.add(p1);cat(g,[-4.79,1.95,.13]);
  const low=shelf('LowShelf',true);low.position.set(-.53,0,4.40);low.rotation.y=0;g.add(low);const trailing=plant('Trailing',.63,'trailing');trailing.position.set(-1.53,1.065,4.35);g.add(trailing);picture(g,'FloorArt',.41,.54,[.55,.37,4.72],'poster-art');
  const sofa=lounge();sofa.position.set(5.20,0,-.18);sofa.rotation.y=-Math.PI/2;g.add(sofa);const smallRug=cyl(g,'LoungeRug',1,1,.012,[4.38,.048,-.05],'rug',[0,0,0],'fabric');smallRug.scale.set(.95,1,1.26);const coffee=coffeeTable();coffee.position.set(4.11,0,-.04);g.add(coffee);
  for(const [x,z,scale,type] of [[5.42,-4.03,1.15,'tall'],[5.40,1.17,.83,'broad'],[-5.52,-3.86,1.0,'broad'],[-5.71,4.34,.72,'broad'],[5.61,4.29,1.0,'tall']]){const p=plant('FloorPlant',scale,type);p.position.set(x,.03,z);g.add(p);}
  for(const x of [-4.67,-1.24,.50]){const p=plant('SillPlant',.43);p.position.set(x,.89,-4.40);g.add(p);}
  g.userData={units:'meters',upAxis:'Y',forward:'+Z',visualReference:'docs/assets/studio-visual-reference-v1.png',labels,description:'v2 sculpted six-worker studio, embedded procedural oak/fabric/screen/art textures'};
  return {scene:g,animations:['Idle','Working','Error'].map(name=>{const c=clips.filter(x=>x.name===name);return new T.AnimationClip(name,c[0].duration,c.flatMap(x=>x.tracks));})};
}
export const assets={room:()=>({scene:room()}),desk:()=>({scene:desk()}),chair:()=>({scene:chair()}),employee:()=>{const g=worker();return {scene:g,animations:g.animations};},plant:()=>({scene:plant()}),bookshelf:()=>({scene:shelf()}),console:()=>({scene:consoleDesk()}),sofa:()=>({scene:lounge()}),coffeeTable:()=>({scene:coffeeTable()}),studio};
