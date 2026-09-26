'use strict';
/**
 * 执行面端到端自测：号池取账号 → AistudioAccount（登录型凭据 + 持久 profile）
 * → 真实提交一次 GenerateContent → 图片落盘。
 *
 * 跑法（VPS）：node selftest/aistudio-exec-test.js [账号id] [提示词]
 * 产物：/tmp/aiexec-test/<时间戳>.png + report.json
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const util = require('node:util');
const aistudio = require('../lib/aistudio');
const { normalizeAiSession } = require('../lib/session');

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
      timeout: 25000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function log(...a) { console.log(new Date().toISOString().slice(11, 19), util.format(...a)); }

(async () => {
  const wantId = process.argv[2] || '';
  const prompt = process.argv[3]
    || 'A cute orange cat sitting on a windowsill, warm sunlight, photorealistic, 3:2';
  const outDir = '/tmp/aiexec-test';
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const data = await poolGet('/api/v1/agent/accounts?backend=aistudio_image');
  const list = data.accounts || [];
  const accMeta = wantId ? list.find((a) => String(a.id) === wantId) : list[0];
  if (!accMeta) throw new Error(`账号不在池子里（现有：${list.map((a) => a.id).join(',')}）`);

  const session = normalizeAiSession(accMeta.session);
  log(`账号 #${accMeta.id} 凭据形态 kind=${session.kind}`);

  const cfg = {
    aistudioProfileDir: process.env.RH_AISTUDIO_PROFILE_DIR || 'data/aistudio-profiles',
    aistudioTabs: 2,
    aistudioTimeoutSeconds: 300,
    aistudioResolution: '4K',
  };
  const pool = new aistudio.AistudioPool(cfg, log);
  const acct = pool.get(accMeta.id, session);

  log(`提交生图：${prompt.slice(0, 60)}…`);
  const t0 = Date.now();
  const images = await acct.generate({ prompt });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(`拿到 ${images.length} 张（${secs}s）—— 取最大一张落盘`);

  const best = images.slice().sort((a, b) => b.base64.length - a.base64.length)[0];
  const ext = /png/i.test(best.contentType) ? 'png' : 'jpg';
  const file = path.join(outDir, `out.${ext}`);
  fs.writeFileSync(file, Buffer.from(best.base64, 'base64'));
  const report = { account_id: accMeta.id, kind: session.kind, status: 'ok',
    images: images.length, seconds: Number(secs), file,
    bytes: fs.statSync(file).size };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  log('结果：', JSON.stringify(report));
  await pool.stop();
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
