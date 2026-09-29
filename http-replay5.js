'use strict';
/** 重放 v5：GET AI Studio 首页收 Set-Cookie 刷新 → 重试 CountTokens */
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
        body: Buffer.concat(chunks).toString('utf8'),
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

function mergeCookies(cookieStr, setCookies) {
  const jar = new Map();
  for (const seg of cookieStr.split(';')) {
    const i = seg.indexOf('=');
    if (i > 0) jar.set(seg.slice(0, i).trim(), seg.slice(i + 1).trim());
  }
  const names = [];
  for (const sc of setCookies) {
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) { jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim()); names.push(first.slice(0, i).trim()); }
  }
  return { str: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '), names };
}

(async () => {
  const data = await poolGet('/api/v1/agent/accounts?backend=aistudio_image');
  const list = data.accounts || [];
  const acct = list.find((a) => String(a.id) === '2') || list[0];
  let cookie = acct.session.cookie;

  // Step 1: 访问首页收集 Set-Cookie（跟随一次重定向）
  let url = 'https://aistudio.google.com/';
  const allNames = [];
  for (let hop = 0; hop < 3 && url; hop += 1) {
    const r = await rawReq(url, { method: 'GET', headers: { 'user-agent': BASE_HEADERS['user-agent'], cookie } });
    console.log('GET %s → %s %s', url.slice(0, 60), r.status, r.loc ? '→ ' + r.loc.slice(0, 70) : '');
    if (r.setCookie.length) {
      const m = mergeCookies(cookie, r.setCookie);
      cookie = m.str;
      allNames.push(...m.names);
      console.log('  set-cookie:', m.names.join(', '));
    }
    url = r.loc && r.status >= 300 && r.status < 400 ? r.loc : '';
  }
  console.log('合并后 cookie %d 字节，刷新了: %s', cookie.length, allNames.join(', ') || '(无)');

  // Step 2: 新 cookie 重试 CountTokens
  const now = Math.floor(Date.now() / 1000).toString();
  const r = await rawReq(URL_CT, {
    method: 'POST',
    headers: { ...BASE_HEADERS, cookie, authorization: authHeader(now, HASH) },
    body: BODY,
  });
  console.log('CountTokens(刷新后): %s %s', r.status, r.body.slice(0, 150));
  if (r.status === 200) console.log('🎉🎉🎉 纯 HTTP 打通！');
  if (r.setCookie.length) console.log('  ↳ set-cookie:', r.setCookie.map((s) => s.split('=')[0]).join(', '));
})();
