'use strict';
/** 重放 v4：先用 RotateCookies 刷新号池 cookie，再用新 cookie 重试 CountTokens */
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

function rawReq(url, { method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(u, { method, headers, timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8').slice(0, 400),
        setCookie: res.headers['set-cookie'] || [],
        loc: res.headers.location || '',
      }));
    });
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message, setCookie: [], loc: '' }));
    if (body) req.write(body);
    req.end();
  });
}
const authHeader = (ts, hash) => `SAPISIDHASH ${ts}_${hash} SAPISID1PHASH ${ts}_${hash} SAPISID3PHASH ${ts}_${hash}`;

/** 把 Set-Cookie 行合并回 cookie 字符串 */
function mergeCookies(cookieStr, setCookies) {
  const jar = new Map();
  for (const seg of cookieStr.split(';')) {
    const i = seg.indexOf('=');
    if (i > 0) jar.set(seg.slice(0, i).trim(), seg.slice(i + 1).trim());
  }
  let merged = 0;
  for (const sc of setCookies) {
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) { jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim()); merged += 1; }
  }
  return { str: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '), merged };
}

(async () => {
  const data = await poolGet('/api/v1/agent/accounts?backend=aistudio_image');
  const list = data.accounts || [];
  const acct = list.find((a) => String(a.id) === '2') || list[0];
  let cookie = acct.session.cookie;
  console.log('原始 cookie %d 字节', cookie.length);

  // Step 1: RotateCookies
  const rc = await rawReq('https://accounts.google.com/RotateCookies', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': BASE_HEADERS['user-agent'],
      cookie,
    },
    body: '[000,-1]',
  });
  console.log('RotateCookies: status=%s set-cookie=%d body=%s', rc.status, rc.setCookie.length, rc.body.slice(0, 100));
  const names = rc.setCookie.map((s) => s.split('=')[0]);
  console.log('  轮换到:', names.join(', '));
  if (rc.setCookie.length) {
    cookie = mergeCookies(cookie, rc.setCookie).str;
    console.log('cookie 已合并，新长度 %d', cookie.length);
  }

  // Step 2: 用新 cookie 重试 CountTokens
  const now = Math.floor(Date.now() / 1000).toString();
  const r = await rawReq(URL_CT, {
    method: 'POST',
    headers: { ...BASE_HEADERS, cookie, authorization: authHeader(now, HASH) },
    body: BODY,
  });
  console.log('CountTokens(新cookie): %s %s', r.status, r.body.slice(0, 150));
  console.log(r.status === 200 ? '🎉🎉🎉 纯 HTTP 打通！' : '仍未通过');
})();
