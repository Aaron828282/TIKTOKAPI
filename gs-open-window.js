// 常驻可见浏览器：gs-13 profile（账号 gklhze5zb9ph@xingdez.com / Plus），
// 打开 genspark.ai 供用户在 noVNC 里手动核验生图窗口。保持 60 分钟。
'use strict';
const { chromium } = require('playwright');
(async () => {
  const ctx = await chromium.launchPersistentContext('/opt/rhnode/data/genspark-profiles/gs-13', {
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1080,620', '--window-position=0,0'],
    viewport: { width: 1080, height: 600 }, timeout: 60000,
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.genspark.ai', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const user = await page.evaluate(async () => {
    const r = await fetch('/api/user', { credentials: 'include', headers: { accept: 'application/json' } });
    const c = ((JSON.parse(await r.text()).data || {}).cogen) || {};
    return { email: c.email || '', plan: c.plan || '' };
  }).catch(() => ({}));
  console.log(`[window] 已打开 genspark.ai · 登录账号: ${user.email} · plan: ${user.plan}`);
  console.log('[window] 浏览器保持 60 分钟，供 noVNC 手动核验。');
  await new Promise((r) => setTimeout(r, 60 * 60 * 1000));
  await ctx.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
