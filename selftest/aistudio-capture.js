'use strict';
/**
 * 本地抓包：用号池下发的真实 cookie 在本机跑一次 AI Studio 生图，
 * 落盘 GenerateContent 请求/响应 wire 模板，供「纯 HTTP 重放」实验用。
 *
 * 用法（本地，需代理可达 Google）：
 *   node selftest/aistudio-capture.js [提示词]
 * 产物：
 *   selftest/aistudio-capture.json   请求模板 + 响应（脱敏后分析用）
 *   selftest/aistudio-capture.res    原始响应字节
 */

const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { parseCookieHeader, RPC_URL_MATCH } = require('../lib/aistudio');

const HERE = __dirname;
const ACCT_FILE = path.join(HERE, 'aistudio-acct2.json');
const OUT_JSON = path.join(HERE, 'aistudio-capture.json');
const OUT_RES = path.join(HERE, 'aistudio-capture.res');
const PROFILE = path.join(HERE, '.capture-profile');
const PROXY = process.env.CAPTURE_PROXY || 'http://127.0.0.1:7890';
const PROMPT = process.argv[2] || '一只红苹果放在白色桌面上，产品摄影风格，特写';

function die(msg) {
  console.error('[capture] FAIL:', msg);
  process.exit(1);
}

(async () => {
  if (!fs.existsSync(ACCT_FILE)) die(`找不到凭据文件 ${ACCT_FILE}`);
  const acct = JSON.parse(fs.readFileSync(ACCT_FILE, 'utf-8'));
  const list = acct.accounts || [];
  if (!list.length) die('凭据文件里没有账号');
  const { cookie, user_agent: ua } = list[0].session || {};
  if (!cookie) die('账号 session.cookie 为空');

  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  console.log('[capture] 启动 Chromium（代理 %s）…', PROXY);
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: process.env.HEADFUL ? false : true,
    // 本地代理对 gstatic.com 稳定断连（但对 aistudio.google.com 正常）；
    // gstatic 有 Google 中国 CDN，直连 200 —— 走旁路白名单。
    proxy: { server: PROXY, bypass: process.env.CAPTURE_BYPASS !== '0' ? '*.gstatic.com' : undefined },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    viewport: { width: 1440, height: 900 },
    timeout: 90_000,
  });
  if (ua) {
    try { await context.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }); } catch { /* 忽略 */ }
  }
  await context.addCookies(parseCookieHeader(cookie));

  // 全程记录命中的请求/响应
  const hits = [];
  const allUrls = [];
  const scripts = new Set();
  const WIDE_MATCH = /GenerateContent|alkalimakersuite|clients6|batchexecute|StreamGenerate|BardFrontendService/i;
  context.on('request', (req) => {
    const u = req.url();
    if (u.startsWith('data:')) return;
    allUrls.push(`${req.method()} ${u.slice(0, 160)}`);
    if (allUrls.length <= 4000 && allUrls.length % 50 === 0) {
      fs.writeFileSync(path.join(HERE, 'aistudio-capture.urls'), allUrls.join('\n'));
    }
    if (WIDE_MATCH.test(u)) {
      hits.push({
        url: u, method: req.method(),
        headers: req.headers(), postData: req.postData() || '',
      });
      console.log('[capture] 捕获请求 #%d：%s', hits.length, u.slice(0, 120));
    }
  });
  const resBodies = [];
  context.on('response', async (res) => {
    const u = res.url();
    if (RPC_URL_MATCH.test(u)) {
      try {
        const buf = await res.body();
        resBodies.push({ url: u, status: res.status(), len: buf.length });
        fs.writeFileSync(OUT_RES, buf);
        console.log('[capture] 捕获响应 #%d：status=%d len=%d', resBodies.length, res.status(), buf.length);
      } catch (e) {
        console.log('[capture] 响应体读取失败：%s', e.message);
      }
    }
  });
  const page = await context.newPage();

  // CDP 伪造 UA + 客户端提示：无头 Chromium 自曝 "HeadlessChrome"，Google 反滥用
  // （waa）拒绝为可疑环境签令牌 ⟹ GenerateContent 403 permission denied。
  // 这里把整组 sec-ch-ua-* 换成正常 Chrome 指纹，同时抹掉 navigator.webdriver。
  const UA = (acct.accounts[0].session.user_agent
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');
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
    } catch (e) { console.log('[capture] 指纹伪造失败（继续裸跑）：%s', e.message); }
  }
  await spoof(page);
  context.on('page', (p) => spoof(p));

  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 160));
  });

  console.log('[capture] 打开 AI Studio …');
  let ok = false, lastErr = null;
  for (let i = 0; i < 4 && !ok; i += 1) {
    try {
      await page.goto('https://aistudio.google.com/prompts/new_chat', {
        waitUntil: 'domcontentloaded', timeout: 60_000,
      });
      ok = true;
    } catch (e) {
      lastErr = e;
      console.log('[capture] goto 第%d次失败：%s，5s 后重试', i + 1, String(e.message).slice(0, 80));
      await page.waitForTimeout(5000);
    }
  }
  if (!ok) throw lastErr;
  await page.waitForTimeout(2500);
  const url = page.url();
  console.log('[capture] 当前 URL：%s', url.slice(0, 100));
  if (/accounts\.google\.com|ServiceLogin|signin/.test(url)) {
    await context.close().catch(() => {});
    die('cookie 已失效（被重定向到登录页）');
  }

  // 填提示词
  const PROMPT_SEL = [
    'textarea[aria-label*="Type" i]', 'textarea[placeholder*="Type" i]',
    'ms-autocomplete textarea', 'ms-chunk-editor textarea', 'main textarea',
  ].join(', ');
  const el = await page.waitForSelector(PROMPT_SEL, { timeout: 30_000 }).catch(() => null);
  if (!el) {
    const html = await page.content().catch(() => '');
    fs.writeFileSync(path.join(HERE, 'aistudio-capture.html'), html);
    console.log('[capture] body innerHTML 长度：%d', (await page.evaluate(() => document.body.innerHTML.length).catch(() => -1)));
    fs.writeFileSync(OUT_JSON, JSON.stringify({ stage: 'no-prompt-box', url }, null, 1));
    await page.screenshot({ path: path.join(HERE, 'aistudio-capture.png'), fullPage: true });
    die('找不到提示词输入框，已截图 + 落盘 HTML 供校准');
  }
  await el.click({ clickCount: 3 });
  await el.fill('');
  await el.type(PROMPT, { delay: 5 });
  console.log('[capture] 提示词已填入（%d 字符）', PROMPT.length);

  // 点 Run
  const RUN_SEL = [
    'button[aria-label*="Run" i]', 'button[aria-label*="运行" i]', 'button.run-button',
  ].join(', ');
  const run = await page.$(RUN_SEL);
  if (run) {
    await run.click();
    console.log('[capture] 已点 Run 按钮');
  } else {
    console.log('[capture] 未找到 Run 按钮，改用 Ctrl+Enter 快捷键');
  }
  // 双保险：焦点在输入框时 Ctrl+Enter 一定提交（UI 上标着 Run Ctrl+↵）
  await el.focus().catch(() => {});
  await page.keyboard.press('Control+Enter');
  console.log('[capture] 已发 Ctrl+Enter，等待响应（最长 240s）…');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(HERE, 'aistudio-capture-after3s.png') });

  const t0 = Date.now();
  while (resBodies.length === 0 && Date.now() - t0 < 240_000) {
    await page.waitForTimeout(2000);
  }
  if (!resBodies.length) {
    fs.writeFileSync(OUT_JSON, JSON.stringify({
      stage: 'no-response', url, requests: hits, scripts: [...scripts],
    }, null, 1));
    fs.writeFileSync(path.join(HERE, 'aistudio-capture.urls'), allUrls.join('\n'));
    await page.screenshot({ path: path.join(HERE, 'aistudio-capture.png'), fullPage: true });
    die('240s 内未捕获到响应，已截图 + 落盘请求列表（aistudio-capture.urls）');
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify({
    prompt: PROMPT,
    captured_at: new Date().toISOString(),
    requests: hits,
    responses: resBodies,
    scripts: [...scripts].slice(0, 60),
  }, null, 1));
  console.log('[capture] DONE：%s / %s', OUT_JSON, OUT_RES);
  await context.close().catch(() => {});
  process.exit(0);
})().catch((e) => die(e.stack || e.message));
