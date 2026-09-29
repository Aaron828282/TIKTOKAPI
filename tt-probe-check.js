// 用刚回填的 cookie 跑标准探针 + 抓会话身份
process.chdir('/opt/rhnode');
const tiktok = require('/opt/rhnode/lib/tiktok.js');
const { cfg } = require('/opt/rhnode/lib/config');
const fs = require('fs');

(async () => {
  const out = JSON.parse(fs.readFileSync('/tmp/tt-manual-out.json', 'utf8'));
  // 号池 normalize 会存 device_id 等字段——按 agent accounts 通道拿标准 session
  const { createClient } = require('/opt/rhnode/lib/pool');
  const client = createClient(cfg);
  const r = await client.accounts('tiktok_r2v');
  const a = (r.accounts || [])[0] || {};
  const sess = a.session || {};
  console.log('session keys:', Object.keys(sess).join(','));
  console.log('cookie has sessionid_ads:', String(sess.cookie || '').includes('sessionid_ads='));
  const probe = await tiktok.probeSession(sess, cfg);
  console.log('PROBE:', JSON.stringify(probe));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
