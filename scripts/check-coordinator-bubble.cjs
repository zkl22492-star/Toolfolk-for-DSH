const { chromium } = require(process.env.STUDIO_PLAYWRIGHT_PATH || 'C:/Users/LAI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'tmp/coordinator-bubble-check');
  fs.mkdirSync(output, { recursive: true });
  const result = await build({
    stdin: {
      contents: fs.readFileSync(path.join(root, 'src/client/index.mjs'), 'utf8') +
        '\nimport { createModelActivity, applyStreamChunk, modelSnapshot } from "../shared/model-activity.mjs";' +
        '\nwindow.bubbleTest = { mountStudio, createModelActivity, applyStreamChunk, modelSnapshot };',
      resolveDir: path.join(root, 'src/client'),
    },
    bundle: true, format: 'iife', write: false,
    plugins: [{ name: 'react-stub', setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}' }));
    } }],
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/test.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(result.outputFiles[0].text);
    } else if (req.url === '/studio.glb') {
      res.setHeader('Content-Type', 'model/gltf-binary');
      res.end(fs.readFileSync(path.join(root, 'assets/3d/v2/studio.glb')));
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<body style="margin:0"><div id="surface"><div id="host" style="width:100vw;height:100vh"></div></div></body>');
    }
  });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1056, height: 860 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.addScriptTag({ url: '/test.js' });
    await page.evaluate(async () => {
      const buffer = await fetch('/studio.glb').then(r => r.arrayBuffer());
      window.mounted = bubbleTest.mountStudio(document.querySelector('#host'), buffer, message => { window.mountStatus = message; }, () => {});
    });
    await page.waitForFunction(() => /场景已渲染|解析失败/.test(window.mountStatus ?? ''), null, { timeout: 60000 });
    assert.match(await page.evaluate(() => window.mountStatus), /6 个员工动作就绪/);
    assert.equal(await page.evaluate(() => window.mounted.getDiagnostics().coordinatorFound), true, 'Real GLB must retain the Coordinator anchor');
    await page.evaluate(() => {
      const a = bubbleTest.createModelActivity();
      bubbleTest.applyStreamChunk(a, { type: 'reasoning-delta', text: '先检查配置文件，再核对页面布局。' }, Date.now());
      window.activity = a;
      window.mounted.applyState({ model: bubbleTest.modelSnapshot(a), sessions: {} }, 'test-session');
    });
    const live = page.getByText('思考中：先检查配置文件，再核对页面布局。', { exact: true });
    await live.waitFor({ state: 'visible' });
    assert(Number(await live.evaluate(el => getComputedStyle(el.parentElement).opacity)) > 0);
    console.log('PASS: live reasoning bubble mounted and visible on real GLB');
    await page.screenshot({ path: path.join(output, 'thinking.png') });
    const ended = await page.evaluate(() => {
      const at = Date.now();
      bubbleTest.applyStreamChunk(window.activity, { type: 'tool-call-delta', id: 'example', argumentsDelta: '{}' }, at);
      bubbleTest.applyStreamChunk(window.activity, { type: 'block-end' }, at + 10);
      bubbleTest.applyStreamChunk(window.activity, { type: 'usage', usage: { outputTokens: 10 } }, at + 20);
      bubbleTest.applyStreamChunk(window.activity, { type: 'finish' }, at + 30);
      const model = bubbleTest.modelSnapshot(window.activity, at + 250);
      window.mounted.applyState({ model, sessions: {} }, 'test-session');
      return { phase: model.phase, reasoningTail: model.reasoningTail };
    });
    console.log('Snapshot after a fast reasoning/tool sequence:', ended);
    assert.equal(ended.phase, 'idle');
    await live.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.mounted.getDiagnostics().coordinatorBubbleText), '', 'Finished streams must not pretend to keep thinking');
    await page.evaluate(() => window.mounted.unmount());
    assert.equal(await page.locator('canvas').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: completed stream clears the bubble; cleanup succeeds');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
