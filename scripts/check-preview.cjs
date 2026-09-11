const {chromium}=require(process.env.STUDIO_PLAYWRIGHT_PATH || 'C:/Users/LAI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const version=process.argv.includes('--v1')?'v1':'v2';
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  try{
    const page=await browser.newPage({viewport:{width:1720,height:1080},deviceScaleFactor:1});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.goto('http://127.0.0.1:4173/?version='+version);
    await page.waitForFunction(()=>window.previewReady,null,{timeout:60000});
    fs.mkdirSync('docs/assets',{recursive:true});
    await page.screenshot({path:'docs/assets/studio-assets-preview-'+version+'.png'});
    const assets=await page.locator('[data-asset]').evaluateAll(bs=>bs.map(b=>b.dataset.asset));
    for(const key of assets){
      await page.evaluate(k=>window.studioPreview.load(k),key);
      assert.equal(await page.evaluate(()=>window.previewInfo.key),key);
      const textures=await page.evaluate(()=>{
        let count=0;window.studioPreview.model.traverse(o=>{
          if(o.isMesh&&o.material.map){
            if(!(o.material.map.image.width>0))throw Error('Undecoded map');count++;
          }
        });return count;
      });
      if(version==='v2'&&key!=='plant')assert(textures>0,key+' missing texture');
      if(key==='studio'||key==='employee'){
        for(const motion of ['Idle','Working','Error']){
          await page.locator('[data-motion="'+motion+'"]').click();
          assert.equal(await page.locator('[data-motion="'+motion+'"]').getAttribute('class'),'selected');
          await page.evaluate(()=>window.studioPreview.mixer.update(.3));
        }
      }
      console.log('PASS browser',key,'decoded maps:',textures);
    }
    for(const asset of ['studio','employee']){
      await page.goto('http://127.0.0.1:4173/?capture&version='+version+'&asset='+asset);
      await page.waitForFunction(()=>window.previewReady,null,{timeout:60000});
      await page.evaluate(()=>document.querySelector('#labels-toggle').click());
      await page.waitForTimeout(300);
      await page.screenshot({path:'docs/assets/'+asset+'-render-'+version+'.png'});
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: asset switching, image decoding, motion controls, screenshots; no browser errors');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
