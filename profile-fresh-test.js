'use strict';
/**
 * Profile 新鲜度测试：直接打开账号 #2 的持久 profile（不注入任何 cookie，
 * 全靠 profile 里 Google 轮换后的存量），若页面能进 ⟹ 会话在 profile 层活着，
* 随即取 context.cookies() 做 CountTokens 纯 HTTP 实测。
 */
const fs = require('node:fs');
const https = require('node:https');
const { chromium } = require('playwright');

const PROFILE = '/opt/rhnode/data/aistudio-profiles/2';
const HASH = '-CXqoVnCxb4C9Yb3zUM9n_Lxeyw';
const URL_CT = 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/CountTokens';
const BODY = '["models/gemini-3-pro-image",[[[[null,"生成一张风景图"]],"user"]]]';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Safari/537.36';

function postCT(cookie) {
  const now = Math.floor(Date.now() / 1000).toString();
  const auth = `SAPISIDHASH ${now}_${HASH} SAPISID1PHASH ${now}_${HASH} SAPISID3PHASH ${now}_${hash_()}`;
  function hash_() { return HASH; }
  return new Promise((resolve) => {
    const u = new URL(URL_CT);
    const req = https.request(u, {
      method: 'POST', timeout: 30000,
      headers: {
        'x-goog-api-key': 'AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs',
        'content-type': 'application/json+protobuf',
        'x-browser-validation': '6sWHb8G4ZxDIKZivt/PCtKQKFEk=',
        'x-aistudio-visit-id': 'cH1XoCDQf8eJzNp8',
        'origin': 'https://aistudio.google.com',
        'referer': 'https://aistudio.google.com/prompts/new_chat',
        'user-agent': UA,
        cookie,
        authorization: auth,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 300) }));
    });
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.write(BODY);
    req.end();
  });
}

(async () => {
  fs.rmSync(PROFILE + '/SingletonLock', { force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--renderer-process-limit=1'],
    viewport: { width: 1440, height: 900 },
    timeout: 90_000,
  });
  const page = await context.newPage();
  console.log('打开 profile（不注入 cookie）…');
  await page.goto('https://aistudio.google.com/prompts/new_chat', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2500);
  const url = page.url();
  console.log('URL: %s', url.slice(0, 90));
  if (/accounts\.google\.com|signin/.test(url)) {
    console.log('❌ profile 存量会话也失效（页面级）');
    await context.close();
    process.exit(1);
  }
  console.log('✅ profile 存量会话有效（页面级）');
  const cookies = await context.cookies();
  const names = cookies.map((c) => c.name);
  console.log('profile cookie %d 个', cookies.length);
  const str = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  fs.writeFileSync('/tmp/http-test/profile-cookie.txt', str, { mode: 0o600 });
  const sidts = (cookies.find((c) => c.name === '__Secure-1PSIDTS') || {}).value || '';
  console.log('1PSIDTS 前 30 字符:', sidts.slice(0, 30));

  const r = await postCT(str);
  console.log('CountTokens(profile 新鲜 cookie): %s %s', r.status, r.body.slice(0, 150));
  console.log(r.status === 200 ? '🎉 纯 HTTP 打通（会话常量 + profile 新鲜 cookie）' : 'HTTP 仍拒');
  await context.close().catch(() => {});
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
