'use strict';
/**
 * CountTokens 重放矩阵 v2：cookie 改从号池 agent API 取（完整 cookie 集），
 * 哈希沿用用户抓包的会话常量值。
 */
const fs = require('node:fs');
const https = require('node:https');
const { parseCookieHeader } = require('./lib/aistudio');

const OUT = '/tmp/http-test';
fs.mkdirSync(OUT, { recursive: true });

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
      rejectUnauthorized: false, timeout: 20000,
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

// 会话常量（来自用户抓包，跨请求不变）
const HASH = '-CXqoVnCxb4C9Yb3zUM9n_Lxeyw';
const BASE_HEADERS = {
  'x-goog-api-key': 'AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs',
  'content-type': 'application/json+protobuf',
  'x-browser-validation': '6sWHb8G4ZxDIKZivt/PCtKQKFEk=',
  'x-aistudio-visit-id': 'cH1XoCDQf8eJzNp8',
  'x-client-data': 'CMqMygEIdbblGAQprskJCKmfyQUi3v7vAyiOkbEIrf/x9gI=',
  'x-goog-download-batch-size': '1',
  'origin': 'https://aistudio.google.com',
  'referer': 'https://aistudio.google.com/prompts/new_chat',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};
const URL_CT = 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/CountTokens';
const BODY = '["models/gemini-3-pro-image",[[[[null,"生成一张风景图"]],"user"]]]';

function post(url, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(u, { method: 'POST', headers, timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 400), setCookie: res.headers['set-cookie'] || [] }));
    });
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message, setCookie: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'ERR timeout', setCookie: [] }); });
    req.write(body);
    req.end();
  });
}

function authHeader(ts, hash) {
  return `SAPISIDHASH ${ts}_${hash} SAPISID1PHASH ${ts}_${hash} SAPISID3PHASH ${ts}_${hash}`;
}

(async () => {
  const data = await poolGet('/api/v1/agent/accounts?backend=aistudio_image');
  const list = data.accounts || [];
  const acct = list.find((a) => String(a.id) === '2') || list[0];
  const { cookie } = acct.session || {};
  if (!cookie) throw new Error('pool cookie 为空');
  const cookies = parseCookieHeader(cookie);
  const names = cookies.map((c) => c.name);
  console.log('号池 cookie：%d 个，含 SID=%s 1PSID=%s HSID=%s SAPISID=%s',
    cookies.length, names.includes('SID'), names.includes('__Secure-1PSID'), names.includes('HSID'), names.includes('SAPISID'));

  const report = [];
  const run = async (label, headers, body) => {
    const r = await post(URL_CT, headers, body);
    report.push({ t: label, status: r.status, body: r.body });
    console.log('%-28s %s %s', label, r.status, r.body.slice(0, 100));
    if (r.setCookie.length) console.log('  ↳ set-cookie %d 条（轮换发生）', r.setCookie.length);
    return r;
  };
  const now = Math.floor(Date.now() / 1000).toString();
  const H = (extra) => {
    const out = { ...BASE_HEADERS, cookie, ...extra };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  };

  // T1 完整 cookie + 会话哈希 + 新 ts
  await run('T1-full-cookie-const-hash', H({ authorization: authHeader(now, HASH) }), BODY);
  // T2 换提示词
  await run('T2-different-prompt', H({ authorization: authHeader(now, HASH) }),
    '["models/gemini-3-pro-image",[[[[null,"A orange cat on the windowsill"]],"user"]]]');
  // T3 去 x-browser-validation
  await run('T3-no-browser-validation', H({ authorization: authHeader(now, HASH), 'x-browser-validation': undefined }), BODY);
  // T4 最小头
  await run('T4-minimal-headers', {
    'content-type': 'application/json+protobuf',
    'x-goog-api-key': BASE_HEADERS['x-goog-api-key'],
    'authorization': authHeader(now, HASH),
    'cookie': JSON.stringify('') || undefined, // 占位，下面覆盖
  }, BODY);
  // T4 修正：上面 cookie 传坏了，重写
  report.pop();
  const minimal = {
    'content-type': 'application/json+protobuf',
    'x-goog-api-key': BASE_HEADERS['x-goog-api-key'],
    'authorization': authHeader(now, HASH),
    'cookie': cookie,
  };
  const r4 = await post(URL_CT, minimal, BODY);
  report.push({ t: 'T4-minimal-headers', status: r4.status, body: r4.body });
  console.log('%-28s %s %s', 'T4-minimal-headers', r4.status, r4.body.slice(0, 100));
  // T5 无鉴权头（cookie-only）
  await run('T5-cookie-only', {}, BODY);

  fs.writeFileSync(`${OUT}/report2.json`, JSON.stringify(report, null, 1));
  console.log('DONE');
})();
