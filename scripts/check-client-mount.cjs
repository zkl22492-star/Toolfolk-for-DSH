const { chromium } = require(process.env.STUDIO_PLAYWRIGHT_PATH || 'C:/Users/LAI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { build } = require('esbuild');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

(async () => {
  await build({
    stdin: { contents: fs.readFileSync('src/client/index.mjs', 'utf8').replace('return { ...diag,', 'return { cameraZoom: camera.zoom, cameraPosition: camera.position.toArray(), ...diag,') + '\nwindow.mountUnderTest = mountStudio; window.loadArtUnderTest = loadStudioArt;', resolveDir: require('node:path').resolve('src/client') },
    bundle: true, format: 'iife', outfile: 'tmp/client-mount-test.js',
    plugins: [{ name: 'react-stub', setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}' }));
    } }],
  });
  const server = spawn(process.execPath, ['scripts/serve-preview.mjs'], { env: { ...process.env, STUDIO_PREVIEW_PORT: '4188' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
    browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1056, height: 860 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:4188/package.json');
    await page.setContent('<body style="margin:0;background:#141414"><div id="surface"><div id="host" style="width:100vw;height:100vh"></div></div></body>');
    await page.addScriptTag({ url: 'http://127.0.0.1:4188/tmp/client-mount-test.js' });
    await page.evaluate(async () => {
      document.body.setAttribute('data-ds-dark-theme', '');
      const buffer = await fetch('/assets/3d/v2/studio.glb').then(r => r.arrayBuffer());
      const art = await window.loadArtUnderTest(file => '/assets/art/studio-v1/' + file);
      window.mounted = window.mountUnderTest(document.querySelector('#host'), buffer, message => { window.mountStatus = message; }, () => { window.selections = (window.selections || 0) + 1; }, art);
    });
    await page.waitForFunction(() => /场景已渲染|解析失败/.test(window.mountStatus ?? ''), null, { timeout: 60000 });
    const status = await page.evaluate(() => window.mountStatus);
    assert.match(status, /6 个员工动作就绪/);
    const locked = await page.evaluate(() => {
      window.mounted.setViewLocked(true);
      const before = window.mounted.getDiagnostics();
      window.mounted.setZoom(1.7);
      return before;
    });
    await page.mouse.move(450, 440);
    await page.mouse.down();
    await page.mouse.move(540, 480, { steps: 5 });
    await page.mouse.up();
    const afterLock = await page.evaluate(() => window.mounted.getDiagnostics());
    assert.equal(afterLock.cameraZoom, locked.cameraZoom);
    afterLock.cameraPosition.forEach((v, i) => assert(Math.abs(v - locked.cameraPosition[i]) < 1e-8));
    await page.evaluate(() => { window.mounted.setViewLocked(false); window.mounted.setZoom(1.1); });
    assert.equal(await page.evaluate(() => window.mounted.getDiagnostics().cameraZoom), 1.1);
    await page.evaluate(() => window.mounted.setZoom(1));
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#surface')).getPropertyValue('--studio-text').trim()), dark ? '#deded6' : '#4f5947');
    }
    await page.screenshot({ path: 'docs/assets/studio-client-night.png' });
    const originalPixels = await page.locator('canvas').screenshot();
    await page.evaluate(() => window.mounted.setZoom(1.25));
    await page.mouse.move(450, 440);
    await page.mouse.down();
    await page.mouse.move(530, 460, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.selections || 0), 0, 'Dragging must not select a desk');
    await page.screenshot({ path: 'docs/assets/studio-client-rotated.png' });
    assert.notDeepEqual(await page.locator('canvas').screenshot(), originalPixels, 'Zoom and rotation change the view');
    await page.setViewportSize({ width: 390, height: 600 });
    await page.evaluate(() => { window.mounted.setZoom(0.8); document.body.removeAttribute('data-ds-dark-theme'); });
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'docs/assets/studio-client-mobile.png' });
    await page.evaluate(() => window.mounted.unmount());
    assert.equal(await page.locator('canvas').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS actual client mount, six animation sets, theme switching, unmount:', status);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
