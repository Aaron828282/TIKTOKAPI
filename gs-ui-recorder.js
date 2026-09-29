// 被动抓包模式：开浏览器给用户手动操作，后台录下所有 genspark /api/ 的 POST 请求体。
// 记录追加写入 /tmp/gs-ui-capture.log（JSON lines），浏览器保持 40 分钟。
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const LOG = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

(async () => {
  const ctx = await chromium.launchPersistentContext('/opt/rhnode/data/genspark-profiles/gs-13', {
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1080,620', '--window-position=0,0'],
    viewport: { width: 1080, height: 600 }, timeout: 60000,
  });
  const out = fs.createWriteStream('/tmp/gs-ui-capture.log', { flags: 'a' });
  let n = 0;
  ctx.on('request', (req) => {
    const u = req.url();
    if (req.method() !== 'POST' || !u.includes('genspark.ai/api/')) return;
    const rec = {
      ts: new Date().toISOString(),
      url: u.replace('https://www.genspark.ai', ''),
      body: String(req.postData() || '').slice(0, 6000),
    };
    out.write(JSON.stringify(rec) + '\n');
    n += 1;
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.genspark.ai', { waitUntil: 'domcontentloaded', timeout: 60000 });
  LOG(`抓包器就绪（登录态已确认）。浏览器保持 40 分钟，请在窗口里走一遍 AI Image 生图流程。`);
  await new Promise((r) => setTimeout(r, 40 * 60 * 1000));
  LOG(`结束，共记录 ${n} 条 POST。`);
  await ctx.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
