const {chromium}=require(process.env.STUDIO_PLAYWRIGHT_PATH||'C:/Users/LAI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});try{
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:4175/preview/hunyuan.html?motion=paused');await page.waitForFunction(()=>window.studioPreview?.worker?.mixer,null,{timeout:120000});
const info=await page.evaluate(()=>({bones:studioPreview.worker.bones,clips:studioPreview.worker.animationNames}));assert(info.bones>0);assert(info.clips.length>0);
await page.evaluate(()=>document.querySelector('#person').click());
const poses=[];
for(const [i,time] of [0,.27,.53,.8].entries()){
  poses.push(await page.evaluate(t=>{const w=studioPreview.worker;w.mixer.setTime(t);w.group.updateMatrixWorld(true);let bone;w.group.traverse(o=>{if(o.isBone&&o.name==='thighL')bone=o;});studioPreview.renderer.render(studioPreview.scene,studioPreview.camera);return {position:w.group.position.toArray(),bones:(()=>{const a=[];w.group.traverse(o=>{if(o.isBone)a.push([o.name,...o.quaternion.toArray()]);});return a;})()};},time));
  await page.screenshot({path:`tmp/hunyuan-preview/walk-${i}.png`});
}
assert.notDeepEqual(poses[0].bones,poses[1].bones,'Skeleton must deform across frames');
const before=await page.evaluate(()=>studioPreview.worker.group.position.toArray());await page.evaluate(()=>document.querySelector('#walk').click());
await page.waitForFunction(p=>studioPreview.worker.group.position.distanceTo({x:p[0],y:p[1],z:p[2]})>.02,before,{timeout:15000});
assert.deepEqual(errors,[]);console.log('PASS',JSON.stringify(info),'bone animation, locomotion, pause and screenshots');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
