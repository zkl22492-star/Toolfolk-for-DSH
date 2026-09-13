const {chromium}=require(process.env.STUDIO_PLAYWRIGHT_PATH||'C:/Users/LAI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs');
(async()=>{const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});try{
const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:4175/preview/hunyuan.html');await page.waitForFunction(()=>window.studioPreview?.getStats().ready,null,{timeout:120000});
await page.screenshot({path:'tmp/hunyuan-preview/day.png'});
console.log(await page.evaluate(()=>({stats:studioPreview.getStats(),objects:studioPreview.instances.map(i=>({name:i.name,position:i.group.position.toArray()}))})));
await page.click('#night');await page.screenshot({path:'tmp/hunyuan-preview/night.png'});
await page.click('#close');await page.screenshot({path:'tmp/hunyuan-preview/close.png'});
await page.click('#day');await page.click('#top');await page.screenshot({path:'tmp/hunyuan-preview/top.png'});
console.log('Page errors:',errors);if(errors.length)throw new Error(errors.join('\n'));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
