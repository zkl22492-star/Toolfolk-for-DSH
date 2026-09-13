const {chromium}=require(process.env.STUDIO_PLAYWRIGHT_PATH||'C:/Users/LAI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});try{
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:4175/preview/hunyuan.html?motion=paused');await page.waitForFunction(()=>window.studioPreview?.workers?.length===6,null,{timeout:120000});
const start=await page.evaluate(()=>studioPreview.workers.map(w=>w.group.position.toArray()));
for(const mode of ['Working','Idle']){
const info=await page.evaluate(mode=>{const s=studioPreview;s.setWorkerMode(mode);s.workers.forEach(w=>w.mixer.update(.7));s.frame('person');s.renderer.render(s.scene,s.camera);return s.workers.map(w=>({position:w.group.position.toArray(),weight:w.actions[mode].getEffectiveWeight(),skin:(()=>{let a;w.group.traverse(o=>{if(o.isSkinnedMesh)a=o;});return !!a;})()}));},mode);
assert(info.every(x=>x.skin&&x.weight>.95));assert.deepEqual(info.map(x=>x.position),start);
await page.screenshot({path:`tmp/hunyuan-preview/seated-${mode}.png`});
}
await page.evaluate(()=>{studioPreview.frame();studioPreview.renderer.render(studioPreview.scene,studioPreview.camera)});await page.screenshot({path:'tmp/hunyuan-preview/seated-all.png'});
assert.deepEqual(errors,[]);console.log('PASS: six skinned workers; both clips transition; seats stay fixed; no page errors.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
