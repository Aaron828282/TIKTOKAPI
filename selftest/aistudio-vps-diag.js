'use strict';
/**
 * VPS 诊断：为什么节点点 Run 后 GenerateContent RPC 从未出现？
 * 阶段 A：复刻节点路径（只点 Run）等 25s，记录是否发出 RPC；
 * 阶段 B：未发出则补 Ctrl+Enter，再等 240s。
 * 产物：/tmp/aidiag/report.json + 截图 + 全量请求 URL 列表。
 */
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const util = require('node:util');
const { chromium } = require('playwright');
const { parseCookieHeader } = require('./lib/aistudio');

const OUT = '/tmp/aidiag';
const RPC_MATCH = /alkalimakersuite-pa\.clients6\.google\.com\/.*GenerateContent/;
const WIDE = /GenerateContent|alkalimakersuite|clients6|Waa\/Create|batchexecute/i;
const PROMPT = '一只红苹果放在白色桌面上，产品摄影风格，特写';

// ---- 读 .env ----
const env = {};
for (const ln of fs.readFileSync('/opt/rhnode/.env', 'utf-8').split('\n')) {
  const m = ln.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

function poolGet(p) {
  return new Promise((resolve, reject) => {
    const u = new URL(env.RH_POOL_URL.replace(/\/$/, '') + p);
    const req = https.request(u, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.RH_AGENT_TOKEN}`, Accept: 'application/json' },
      rejectUnauthorized: false,
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function log(...a) { console.log(new Date().toISOString().slice(11, 19), util.format(...a)); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const data = await poolGet('/api/v1/agent/accounts?backend=aistudio_image');
  const list = data.accounts || [];
  if (!list.length) throw new Error('号池无 aistudio 账号');
  const { cookie, user_agent: ua } = list[0].session || {};
  if (!cookie) throw new Error('session.cookie 为空');
  log('凭据 OK：cookie len=%d', cookie.length);

  const PROFILE = path.join(OUT, 'profile');
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--no-zygote', '--renderer-process-limit=1'],
    viewport: { width: 1440, height: 900 },
    timeout: 90_000,
  });
  await context.addCookies(parseCookieHeader(cookie));
  log('已注入 %d 个 cookie', parseCookieHeader(cookie).length);

  // client-hints 伪造（与节点 lib/aistudio.js 相同）
  const UA = ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  const CHROME_VER = (UA.match(/Chrome\/(\d+)/) || [])[1] || '153';
  async function spoof(p) {
    try {
      const cdp = await context.newCDPSession(p);
      await cdp.send('Network.setUserAgentOverride', {
        userAgent: UA,
        userAgentMetadata: {
          brands: [
            { brand: 'Google Chrome', version: CHROME_VER },
            { brand: 'Chromium', version: CHROME_VER },
            { brand: 'Not_A Brand', version: '24' },
          ],
          fullVersionList: [
            { brand: 'Google Chrome', version: `${CHROME_VER}.0.8010.12` },
            { brand: 'Chromium', version: `${CHROME_VER}.0.8010.12` },
            { brand: 'Not_A Brand', version: '24.0.0.0' },
          ],
          fullVersion: `${CHROME_VER}.0.8010.12`,
          platform: 'Windows', platformVersion: '10.0.0',
          architecture: 'x86', bitness: '64', model: '',
          mobile: false, wow64: false, formFactors: ['Desktop'],
        },
      });
      await p.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
    } catch (e) { log('spoof 失败（继续）：%s', e.message); }
  }

  const rpcReqs = [];
  const rpcRes = [];
  const wideReqs = [];
  context.route(new RegExp(RPC_MATCH.source), async (route) => {
    const u = route.request().url();
    log('>>> ROUTE 拦截 GenerateContent：%s', u.slice(0, 110));
    rpcReqs.push(u);
    try {
      const resp = await route.fetch();
      const buf = await resp.body();
      rpcRes.push({ status: resp.status(), len: buf.length });
      log('<<< ROUTE 响应 status=%d len=%d', resp.status(), buf.length);
      await route.fulfill({ response: resp, body: buf });
    } catch (e) {
      log('!!! route.fetch 失败：%s', e.message);
      try { await route.continue_(); } catch { /* ignore */ }
    }
  });
  context.on('request', (req) => {
    const u = req.url();
    if (WIDE.test(u)) {
      wideReqs.push(`${req.method()} ${u.slice(0, 150)}`);
      log('WIDE req: %s', `${req.method()} ${u.slice(0, 110)}`);
    }
  });
  context.on('page', (p) => spoof(p));

  const page = await context.newPage();
  await spoof(page);
  page.on('console', (m) => { if (m.type() === 'error') log('[console.err]', m.text().slice(0, 140)); });

  log('打开 AI Studio …');
  for (let i = 0; i < 3; i += 1) {
    try {
      await page.goto('https://aistudio.google.com/prompts/new_chat', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      break;
    } catch (e) { log('goto 重试 %d：%s', i + 1, String(e.message).slice(0, 70)); await page.waitForTimeout(5000); }
  }
  await page.waitForTimeout(2500);
  const url0 = page.url();
  if (/accounts\.google\.com|signin/.test(url0)) throw new Error('cookie 失效：' + url0.slice(0, 90));
  log('页面 OK：%s', url0.slice(0, 80));

  // 诊断 dump：Run 按钮 / 模型 chip / textarea
  const dump = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].map((b) => ({
      label: b.getAttribute('aria-label') || '', text: (b.innerText || '').trim().slice(0, 30),
      disabled: b.disabled, cls: (b.className || '').toString().slice(0, 40),
    })).filter((b) => /run|运行/i.test(b.label + b.text + b.cls));
    const chip = document.querySelector('ms-model-selector, [aria-label*="model" i]');
    const tas = [...document.querySelectorAll('textarea')].map((t) => ({
      aria: t.getAttribute('aria-label') || '', ph: t.placeholder || '',
    }));
    return { runBtns: btns, modelChip: chip ? (chip.innerText || chip.getAttribute('aria-label') || '').slice(0, 80) : null, textareas: tas, title: document.title };
  });
  log('页面 dump：%s', JSON.stringify(dump).slice(0, 600));
  await page.screenshot({ path: path.join(OUT, '1-loaded.png'), fullPage: true });

  // 填提示词
  const PROMPT_SEL = 'textarea[aria-label*="Type" i], textarea[placeholder*="Type" i], ms-autocomplete textarea, ms-chunk-editor textarea, main textarea';
  const el = await page.waitForSelector(PROMPT_SEL, { timeout: 30_000 });
  await el.click({ clickCount: 3 });
  await el.fill('');
  await el.type(PROMPT, { delay: 5 });
  log('提示词已填入');

  // ---- 阶段 A：复刻节点 —— 只点 Run ----
  const RUN_SEL = 'button[aria-label*="Run" i], button[aria-label*="运行" i], button.run-button';
  const run = await page.$(RUN_SEL);
  if (!run) throw new Error('找不到 Run 按钮');
  await run.click();
  log('阶段 A：已点 Run（复刻节点路径），等 25s 观察 RPC…');
  await page.waitForTimeout(25_000);
  await page.screenshot({ path: path.join(OUT, '2-after-run-click.png'), fullPage: true });
  const stageA = { rpcCount: rpcReqs.length, wideCount: wideReqs.length };
  log('阶段 A 结果：GenerateContent RPC=%d，wide 请求=%d', rpcReqs.length, wideReqs.length);

  // ---- 阶段 B：Ctrl+Enter 兜底 ----
  if (!rpcReqs.length) {
    await el.focus().catch(() => {});
    await page.keyboard.press('Control+Enter');
    log('阶段 B：已发 Ctrl+Enter，等 RPC（最长 240s）…');
  }
  const t0 = Date.now();
  while (rpcRes.length === 0 && Date.now() - t0 < 240_000) await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, '3-final.png'), fullPage: true });

  const report = {
    stageA, rpcReqs, rpcRes,
    wideReqs: wideReqs.slice(0, 60),
    dump,
    finalUrl: page.url(),
    elapsedMs: Date.now() - t0,
    verdict: rpcRes.length ? `RPC 响应到达 status=${rpcRes[0].status} len=${rpcRes[0].len}`
      : (rpcReqs.length ? 'RPC 发出但响应未捕获' : 'RPC 从未发出（Run 点击无效，Ctrl+Enter 也未触发）'),
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  log('VERDICT: %s', report.verdict);
  await context.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('AIDIAG FAIL:', e.message); process.exit(1); });
