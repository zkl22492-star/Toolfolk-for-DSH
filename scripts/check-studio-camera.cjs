const { chromium } = require(process.env.STUDIO_PLAYWRIGHT_PATH || 'C:/Users/LAI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

(async () => {
  const server = spawn(process.execPath, ['scripts/serve-preview.mjs'], {
    env: { ...process.env, STUDIO_PREVIEW_PORT: '4187' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error('Server exited: ' + code))); });
    browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
    const page = await browser.newPage();
    for (const [name, width, height, dark] of [['day-desktop', 1056, 860, false], ['night-desktop', 1056, 860, true], ['night-mobile', 390, 600, true]]) {
      await page.setViewportSize({ width, height });
      await page.goto('http://127.0.0.1:4187/?capture&version=v2');
      await page.waitForFunction(() => window.previewReady);
      const result = await page.evaluate(async (dark) => {
        const T = await import('three');
        const { frameStudioCamera } = await import('/src/shared/studio-camera.mjs');
        const p = window.studioPreview;
        const box = new T.Box3().setFromObject(p.model);
        p.controls.target.copy(box.getCenter(new T.Vector3()));
        frameStudioCamera(p.camera, box, innerWidth, innerHeight);
        const { createStudioLighting, observeStudioTheme } = await import('/src/shared/studio-lighting.mjs');
        const scene = new T.Scene();
        scene.add(p.model);
        const lighting = createStudioLighting(scene);
        const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
        renderer.setSize(innerWidth, innerHeight);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = T.PCFSoftShadowMap;
        Object.assign(renderer.domElement.style, { position: 'fixed', inset: '0', zIndex: '9999' });
        document.body.append(renderer.domElement);
        document.body.style.background = dark ? '#141414' : '#ffffff';
        renderer.domElement.style.background = dark ? '#141414' : '#ffffff';
        document.body.toggleAttribute('data-ds-dark-theme', dark);
        observeStudioTheme(document.body, lighting);
        const render = () => { renderer.render(scene, p.camera); requestAnimationFrame(render); };
        render();
        window.themeRenderer = renderer;
        document.querySelector('#labels-toggle').click();
        const corners = [];
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
          corners.push(new T.Vector3(x,y,z).project(p.camera).toArray());
        }
        return { corners, x: p.camera.position.x, z: p.camera.position.z };
      }, dark);
      assert(result.x < 0 && result.z > 0);
      assert(result.corners.every(([x,y]) => Math.abs(x) < 1 && Math.abs(y) < 1));
      await page.waitForTimeout(500);
      await page.screenshot({ path: `docs/assets/studio-camera-${name}.png` });
      const pixels = await page.evaluate(() => {
        const r = window.themeRenderer, gl = r.getContext();
        const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data);
        return new Set(data).size;
      });
      assert(pixels > 30, 'Canvas is blank');
      console.log('PASS', name, 'framing and rendered pixels');
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
