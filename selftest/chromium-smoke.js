'use strict';
/**
 * AI Studio 执行面 —— 本地 Chromium 冒烟测试（**手动跑**，不在 npm run selftest 里）。
 *
 * 目的：不碰 Google、不需要任何凭据，用真实 Playwright 验证 lib/aistudio.js
 * 依赖的每一条 API 假设 + 并发配对正确性：
 *
 *   1. launchPersistentContext(headless) 在本机可启动；
 *   2. parseCookieHeader 的产物能被 addCookies 原样接收（含 __Secure-/SID）；
 *   3. context.route(RegExp) 能拦下页面 fetch 的「GenerateContent」请求；
 *   4. _handleRpc 的完整链路：改写分辨率 → route.fetch({url}) 打到本地假上游
 *      → route.fulfill({response, body}) 回给页面；
 *   5. **按 page 配对**：两个页面并发提交、响应乱序到达，各自拿到自己的图
 *      （修复前的 FIFO 会拿错）；
 *   6. rewriteResolution / extractImages 在真实 wire 数据上行为正确。
 *
 * 用法（先 npm i --no-save playwright && npx playwright install chromium）：
 *   node selftest/chromium-smoke.js
 */

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const {
  extractImages, parseCookieHeader, rewriteResolution, RPC_URL_MATCH,
} = require('../lib/aistudio');

let passed = 0;
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}`); process.exitCode = 1; }
}

function main() {
  let pw;
  try {
    pw = require('playwright');
  } catch {
    console.log('SKIP：未安装 playwright（npm i --no-save playwright && npx playwright install chromium）');
    return;
  }

  // ---- 纯函数：wire 数据与真实抓包同构 ----
  // lib 的语义是**替换外层数组元素** body[3][i] = [null,"4K"]（与真实用法一致）
  const g = [[null, '1K']];
  ok(rewriteResolution(g, '4K') === true && g[0][1] === '4K',
    'rewriteResolution 把 [null,"1K"] 替换为 [null,"4K"]');
  ok(rewriteResolution([['1K']], '4K') === false, 'rewriteResolution 拒绝非 [null,"xK"] 结构');
  ok(rewriteResolution(null, '4K') === false, 'rewriteResolution 容忍非数组入参');

  const fakeImg = Buffer.alloc(2048, 7).toString('base64');
  const respBody = JSON.stringify([[[['text', 'hi']], [['image/png', fakeImg]]]]);
  const imgs = extractImages(JSON.parse(respBody));
  ok(imgs.length === 1 && imgs[0].contentType === 'image/png'
    && Buffer.from(imgs[0].base64, 'base64').length === 2048,
  'extractImages 抽出 image part 并保留字节');

  const cookies = parseCookieHeader(
    'SID=g.a000xxx; __Secure-1PSID=g.a111yyy; SAPISID=abc123; NID=zzz');
  ok(cookies.length === 4
    && cookies.every((c) => c.secure === true && c.path === '/')
    && cookies[0].domain === '.google.com'
    && cookies[0].httpOnly === true
    && cookies[1].httpOnly === true,
  'parseCookieHeader：SID/__Secure- 全部 httpOnly+secure，域归 .google.com');

  ok(RPC_URL_MATCH.test('https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent'),
    'RPC_URL_MATCH 命中真实形态的 GenerateContent 端点');
  ok(!RPC_URL_MATCH.test('https://alkalimakersuite-pa.clients6.google.com/OtherMethod'),
    'RPC_URL_MATCH 不误伤其他端点');

  (async () => {
    // ---- 本地假上游：回显收到的 generationConfig 是否为 4K；图片 base64 里
    //      编入请求 tag，用于断言「响应被喂给了正确的页面」。 ----
    const seen = { rewritten: null, hits: 0 };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const tag = Array.isArray(body) && typeof body[1] === 'string' ? body[1] : '?';
        // 直接检查：到达假上游的 generationConfig 是否已含改写后的 "4K"
        seen.rewritten = Array.isArray(body[3]) && JSON.stringify(body[3]).includes('"4K"');
        seen.hits += 1;
        const payload = Buffer.alloc(2048);
        payload.write(`PNG-${tag}`, 0);
        const delay = tag === 'slow' ? 800 : 0;
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([[[['text', 'ok']], [['image/png', payload.toString('base64')]]]]));
        }, delay);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const upstream = `http://127.0.0.1:${server.address().port}/GenerateContent`;

    // ---- 持久 profile + cookie 注入 ----
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-smoke-'));
    const context = await pw.chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      viewport: { width: 1280, height: 800 },
      timeout: 60_000,
    });
    try {
      await context.addCookies(parseCookieHeader('SID=g.smoke; SAPISID=smoke'));
      ok(true, 'launchPersistentContext + addCookies 在本机 Chromium 上可用');

      // ---- 拦截器：与 lib/aistudio.js 的 _handleRpc 同构 ----
      const waiters = [];               // [{page, resolve, timer}]
      await context.route(new RegExp(RPC_URL_MATCH.source), async (route) => {
        const req = route.request();
        const bodyText = req.postData() || '';
        let body = null;
        try { body = JSON.parse(bodyText); } catch { /* 原样放行 */ }
        if (Array.isArray(body)) rewriteResolution(body[3], '4K');
        const resp = await route.fetch({
          ...(Array.isArray(body)
            ? { url: upstream, method: 'POST', postData: JSON.stringify(body) }
            : {}),
        });
        const buf = await resp.body();
        const reqPage = (() => {
          try { return req.frame().page(); } catch { return null; }
        })();
        const idx = waiters.findIndex((w) => w.page === reqPage);
        if (idx >= 0) {
          clearTimeout(waiters[idx].timer);
          waiters[idx].resolve({ status: resp.status(), bytes: buf });
        }
        await route.fulfill({ response: resp, body: buf });
      });
      ok(true, 'context.route(RegExp) + route.fetch({url}) + route.fulfill({response,body}) API 可用');

      // ---- 两个页面并发提交，slow 的响应后到，验证按 page 归属 ----
      const runOn = async (page, tag) => {
        const captured = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const i = waiters.findIndex((x) => x.resolve === resolve);
            if (i >= 0) waiters.splice(i, 1);
            reject(new Error('wait timeout'));
          }, 15_000);
          waiters.push({ page, resolve, timer });
        });
        await page.goto('about:blank');
        // 域名与真实端点同构 —— 必须命中 RPC_URL_MATCH 才会被 context.route 拦截
        //（route 在 DNS 之前接管，域名不需要真实解析）
        await page.evaluate((t) => fetch(
          'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal/GenerateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([null, t, null, [[null, '1K']]]),
        }).then((r) => r.text()), tag);
        const { status, bytes } = await captured;
        const parsed = JSON.parse(bytes.toString('utf-8'));
        return { status, imgs: extractImages(parsed), bytes };
      };

      const pageA = await context.newPage();
      const pageB = await context.newPage();
      const pA = runOn(pageA, 'slow');   // A 慢 → B 的响应先到
      const pB = runOn(pageB, 'fast');
      const [rA, rB] = await Promise.all([pA, pB]);

      ok(rA.status === 200 && rB.status === 200, '两个并发任务都拿到 200');
      const tagOf = (r) => Buffer.from(r.imgs[0].base64, 'base64').toString('utf-8', 0, 8);
      ok(tagOf(rA) === 'PNG-slow', `页面 A（slow）拿到的是自己的图（实际 ${tagOf(rA)}）`);
      ok(tagOf(rB) === 'PNG-fast', `页面 B（fast）拿到的是自己的图（实际 ${tagOf(rB)}）`);
      ok(seen.hits === 2 && seen.rewritten === true, '假上游两次都被打中，且收到的已是改写后的 4K 配置');
      ok(await pageA.evaluate('1+1') === 2, 'fulfill 后页面 JS 环境正常继续');
    } finally {
      await context.close().catch(() => {});
      server.close();
      fs.rmSync(profileDir, { recursive: true, force: true });
    }

    console.log(`\nchromium-smoke：${passed} 项通过${process.exitCode ? '（有失败）' : ''}`);
  })().catch((err) => {
    console.error(`  ✗ 冒烟测试异常：${err.message}`);
    process.exitCode = 1;
  });
}

main();
