'use strict';
/**
 * CountTokens 纯 HTTP 重放矩阵（VPS 直连 Google）。
 * T1 原样重放（旧时间戳） T2 新时间戳+同哈希 T3 换提示词
 * T4 去 x-browser-validation T5 最小头集合
 * 结论落 /tmp/http-test/report.json
 */
const fs = require('node:fs');
const https = require('node:https');

const OUT = '/tmp/http-test';
fs.mkdirSync(OUT, { recursive: true });

// ===== 用户手动抓包原样数据（2026-09-27 凌晨）=====
const CAP = {
  url: 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/CountTokens',
  ts: '1790442596',
  hash: '-CXqoVnCxb4C9Yb3zUM9n_Lxeyw',
  cookie: '__Secure-1PSIDTS=sidts-CjEBkldj_8tUqM_oj2ZLpjeMYVXH1GGqOZYlkaUHZTQJqcDZ-Yz2cLDL_Zih8JumZXjx5E.ae3Fc1jVdJ_P8ed6601A8gCzr0PevAVXZOXhMS3yLQlbBTWhR8fR1tZ8x7Gyz8Z2CskSKLhX5g5DS6DUL5bRlNf1LemYowvbciFYIakw8fXH89xss40t7qGWQOfx5t9H2U0O1wH46HfeD9wJe7vNN0c_eMBwJTlo9RUPCzfkl0cy6oC7B2Sd3yaGyMHvwUINzouN0KpWmiMs9S4LQVeU9qRM9sXYU_hux9Q84vOmg7NQg58dQAdLr5wZF86-I3YoVLO0hQoPKgqkR87ql7dqX8-XXQMkD9jJoQBuWvLtWy-NC32KfwRtsQ9gKDSQTRoEVK9UY7MFT5DnLfaMH8ib28zu8AMqZgdcGB4XXwQihrWMu4-JVHTwb71BDEqXKLWhugRJIZ1fsuXJ8U2nskwuhPSI0QP2DLWffoGtvWABo1eaQ-VXfWIGWVGPn3r3rY0Hr62jXd4FOhXB0UdjoEc6qcxSRzPUyYOTAGJ0RLvzyVyCgQEq8mq; __Secure-3PSIDTS=sidts-CjEBkldj_8tUqM_oj2ZLpjeMYVXH1GGqOZYlkaUHZTQJqcDZ-Yz2cLDL_Zih8JumZXjx5E.ae3Fc1jVdJ_P8ed6601A8gCzr0PevAVXZOXhMS3yLQlbBTWhR8fR1tZ8x7Gyz8Z2CskSKLhX5g5DS6DUL5bRlNf1LemYowvbciFYIakw8fXH89xss40t7qGWQOfx5t9H2U0O1wH46HfeD9wJe7vNN0c_eMBwJTlo9RUPCzfkl0cy6oC7B2Sd3yaGyMHvwUINzouN0KpWmiMs9S4LQVeU9qRM9sXYU_hux9Q84vOmg7NQg58dQAdLr5wZF86-I3YoVLO0hQoPKgqkR87ql7dqX8-XXQMkD9jJoQBuWvLtWy-NC32KfwRtsQ9gKDSQTRoEVK9UY7MFT5DnLfaMH8ib28zu8AMqZgdcGB4XXwQihrWMu4-JVHTwb71BDEqXKLWhugRJIZ1fsuXJ8U2nskwuhPSI0QP2DLWffoGtvWABo1eaQ-VXfWIGWVGPn3r3rY0Hr62jXd4FOhXB0UdjoEc6qcxSRzPUyYOTAGJ0RLvzyVyCgQEq8mq; SAPISID=531FvHGAYa4_IZHA/AJA9ILAFAyA4k_0Kw; __Secure-1PAPISID=531FvHGAYa4_IZHA/AJA9ILAFAyA4k_0Kw; __Secure-3PAPISID=531FvHGAYa4_IZHA/AJA9ILAFAyA4k_0Kw; NID=nwid02fXEu0F3hFyCR5L3Lb_IYlCVDz5Zj9mzSDPu1jCxvjUxVDRlAiiGyEYVsFbfF4-WnnOlJqMPVYtRdaCVpknUSMUC0uBSrSD3DS2vhLdKLJKJd60LhNpajfJc2Q4Q1MdQmIxaOSJfBNa-23OZkmNHIcQ3yNPZUpUhGg33RI5Icy2eb_EWEOnwhrUiItEBzKpw8pSK6y5YtrHR7LZamVZT2CISDfgF2D1UVFFH-YofC6XNYBf6TVxx7P99Xf4SPW7feDrXotMi7pLQPJhHK2xsk5jP9jKA6G_JY3z3Y4eQ4l2s57mT8ypMnCCIvSg; AEC=AVYBKeRX5IhAtAAqxyJDvcRjre9XXt8HUnW0YIpv2is6oyGpdLkvBfQYcA; __Secure-YEC=CgtUenF2d2NuRDBlQRjoAcWaAaIjQmdrSEh2WW5DU19LSW5FTGlZWHVQSzBWV2M5dUpQZ01DZkFhNktrQm44VGJBPT0; OSID=ISSIJBkta16DVLOxA1T0h1e4t3Rc_Oei3nXYM2Jz37iGvXfDC1ll1KkZ1WJUrb8BOO_F8Q.; __Secure-OSID=ISSIJBkta16DVLOxA1T0h1e4t3Rc_Oei3nXYM2Jz37iGvXfDC1ll1KkZ1WJUrb8BOO_F8Q.',
  headers: {
    'x-goog-api-key': 'AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs',
    'content-type': 'application/json+protobuf',
    'x-browser-validation': '6sWHb8G4ZxDIKZivt/PCtKQKFEk=',
    'x-aistudio-visit-id': 'cH1XoCDQf8eJzNp8',
    'x-client-data': 'CMqMygEIdbblGAQprskJCKmfyQUi3v7vAyiOkbEIrf/x9gI=',
    'x-goog-download-batch-size': '1',
    'origin': 'https://aistudio.google.com',
    'referer': 'https://aistudio.google.com/prompts/new_chat',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  },
  body: '["models/gemini-3-pro-image",[[[[null,"生成一张风景图"]],"user"]]]',
};

function post(url, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(u, {
      method: 'POST', headers, timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 500) }));
    });
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'ERR timeout' }); });
    req.write(body);
    req.end();
  });
}

function buildAuth(ts, hash) {
  return `SAPISIDHASH ${ts}_${hash} SAPISID1PHASH ${ts}_${hash} SAPISID3PHASH ${ts}_${hash}`;
}

(async () => {
  const report = [];
  const mkHeaders = (h, withAuth, ts, hash) => {
    const out = { ...CAP.headers, ...h, cookie: CAP.cookie };
    for (const k of Object.keys(out)) {
      if (out[k] === undefined) delete out[k];
    }
    if (withAuth) out.authorization = buildAuth(ts, hash);
    return out;
  };

  // T1 原样重放
  let r = await post(CAP.url, mkHeaders({}, true, CAP.ts, CAP.hash), CAP.body);
  report.push({ t: 'T1-replay-verbatim', status: r.status, body: r.body });
  console.log('T1 原样重放:', r.status, r.body.slice(0, 120));

  // T2 新时间戳 + 同哈希
  const now = Math.floor(Date.now() / 1000).toString();
  r = await post(CAP.url, mkHeaders({}, true, now, CAP.hash), CAP.body);
  report.push({ t: 'T2-fresh-ts-same-hash', status: r.status, body: r.body });
  console.log('T2 新时间戳+同哈希:', r.status, r.body.slice(0, 120));

  // T3 换提示词（关键：绑不绑内容）
  const body3 = '["models/gemini-3-pro-image",[[[[null,"A orange cat on the windowsill in the sunshine"]],"user"]]]';
  r = await post(CAP.url, mkHeaders({}, true, now, CAP.hash), body3);
  report.push({ t: 'T3-different-prompt', status: r.status, body: r.body });
  console.log('T3 换提示词:', r.status, r.body.slice(0, 120));

  // T4 去掉 x-browser-validation
  const h4 = { 'x-browser-validation': undefined };
  r = await post(CAP.url, mkHeaders(h4, true, now, CAP.hash), CAP.body);
  report.push({ t: 'T4-no-browser-validation', status: r.status, body: r.body });
  console.log('T4 去 x-browser-validation:', r.status, r.body.slice(0, 120));

  // T5 最小头：api-key + auth + origin + content-type
  const h5 = {
    'x-browser-validation': undefined, 'x-aistudio-visit-id': undefined,
    'x-client-data': undefined, 'x-goog-download-batch-size': undefined,
    'referer': undefined, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) node-https/1.0',
  };
  r = await post(CAP.url, mkHeaders(h5, true, now, CAP.hash), CAP.body);
  report.push({ t: 'T5-minimal-headers', status: r.status, body: r.body });
  console.log('T5 最小头:', r.status, r.body.slice(0, 120));

  // T6 无鉴权（对照）
  r = await post(CAP.url, mkHeaders({}, false, now, CAP.hash), CAP.body);
  report.push({ t: 'T6-no-auth', status: r.status, body: r.body });
  console.log('T6 无鉴权对照:', r.status, r.body.slice(0, 120));

  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  console.log('DONE -> /tmp/http-test/report.json');
})();
