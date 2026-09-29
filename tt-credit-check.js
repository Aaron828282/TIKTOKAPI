// 用刚回填的 cookie 直查 TikTok 侧积分与配额，和号池看板对账
const path = require('path');
process.chdir('/opt/rhnode');
const tiktok = require('/opt/rhnode/lib/tiktok.js');
const { cfg } = require('/opt/rhnode/lib/config');
const { createClient } = require('/opt/rhnode/lib/pool');

(async () => {
  const fs = require('fs');
  const out = JSON.parse(fs.readFileSync('/tmp/tt-manual-out.json', 'utf8'));
  const session = { cookie: out.cookie, user_agent: out.user_agent };
  const acc = await tiktok.creditAccount(session, cfg, {});
  console.log('CREDIT:', JSON.stringify(acc));
  try {
    const mc = await tiktok.generateMaxCount(session, cfg);
    console.log('MAXCOUNT:', JSON.stringify(mc));
  } catch (e) { console.log('MAXCOUNT ERR:', e.message); }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
