'use strict';
/** 重放 v3：验证 SAPISID 匹配 + 剥离易轮换 cookie 的变体 */
const fs = require('node:fs');
const https = require('node:https');
const { parseCookieHeader } = require('./lib/aistudio');

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
    req.end();
  });
}
const HASH = '-CXqoVnCxb4C9Yb3zUM9n_Lxeyw';
const BASE_HEADERS = {
  'x-goog-api-key': 'AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs',
  'content-type': 'application/json+protobuf',
  'x-browser-validation': '6sWHb8G4ZxDIKZivt/PCtKQKFEk=',
  'x-aistudio-visit-id': 'cH1XoCDQf8eJzNp8',
  'x-client-data': 'CMqMygEIdbblGAQprskJCKmfyQUi3v7vAyiOkbEIrf/x9gI=',
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
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 300), loc: res.headers.location || '' }));
    });
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message, loc: '' }));
    req.write(body);
    req.end();
  });
}
const authHeader = (ts, hash) => `SAPISIDHASH ${ts}_${hash} SAPISID1PHASH ${ts}_${hash} SAPISID3PHASH ${ts}_${hash}`;

(async () => {
  const data = await poolGet('/api/v1/agent/accounts?backend=aistudio_image');
  const list = data.accounts || [];
  const acct = list.find((a) => String(a.id) === '2') || list[0];
  const { cookie } = acct.session || {};
  const cookies = parseCookieHeader(cookie);
  const get = (n) => (cookies.find((c) => c.name === n) || {}).value || '(缺)';
  console.log('SAPISID 池:', get('SAPISID').slice(0, 14));
  console.log('SAPISID 抓包: 531FvHGAYa4_IZ');
  console.log('匹配:', get('SAPISID') === '531FvHGAYa4_IZHA/AJA9ILAFAyA4k_0Kw' ? 'YES ✅' : 'NO ❌');
  console.log('cookie 名单:', cookies.map((c) => c.name).join(', '));

  const dropNames = (names) => cookies.filter((c) => !names.includes(c.name))
    .map((c) => `${c.name}=${c.value}`).join('; ');
  const now = Math.floor(Date.now() / 1000).toString();

  const variants = [
    ['V1 全量 cookie', cookie],
    ['V2 去 1PSIDTS/3PSIDTS', dropNames(['__Secure-1PSIDTS', '__Secure-3PSIDTS'])],
    ['V2b 去 TS+SIDCC', dropNames(['__Secure-1PSIDTS', '__Secure-3PSIDTS', 'SIDCC', '__Secure-1PSIDCC', '__Secure-3PSIDCC'])],
    ['V3 仅核心(SID HSID SSID APISID SAPISID 1PAPISID 3PAPISID)', dropNames(cookies.map((c) => c.name).filter((n) => !['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID', '__Secure-1PSID', '__Secure-3PSID'].includes(n)))],
  ];
  for (const [label, ck] of variants) {
    const r = await post(URL_CT, {
      ...BASE_HEADERS, cookie: ck, authorization: authHeader(now, HASH),
    }, BODY);
    console.log('%-52s %s %s', label, r.status, r.body.slice(0, 90));
  }
  console.log('DONE');
})();
