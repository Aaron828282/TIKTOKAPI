// 对账：cookie 串里的 device_id/csrftoken vs 号池落库的 session
process.chdir('/opt/rhnode');
const fs = require('fs');
const { createClient } = require('/opt/rhnode/lib/pool');
const { cfg } = require('/opt/rhnode/lib/config');

function pick(cookieStr, name) {
  const m = cookieStr.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? m[1] : null;
}

(async () => {
  const out = JSON.parse(fs.readFileSync('/tmp/tt-manual-out.json', 'utf8'));
  const c = out.cookie;
  console.log('== 新登录 cookie ==');
  for (const k of ['device_id', 'csrftoken', 'sessionid_ads', 'tt-target-idc']) {
    const v = pick(c, k);
    console.log(' ', k, '=', v ? String(v).slice(0, 40) : '(无)');
  }
  const { createClient: cc } = require('/opt/rhnode/lib/pool');
  void cc;
  const client = createClient(cfg);
  const r = await client.accounts('tiktok_r2v');
  const s = ((r.accounts || [])[0] || {}).session || {};
  console.log('== 号池落库 session ==');
  for (const k of ['device_id', 'x_csrftoken', 'x_fp_id']) {
    const v = s[k];
    console.log(' ', k, '=', v ? String(v).slice(0, 40) : '(无)');
  }
  console.log('  stored cookie device_id =', pick(String(s.cookie || ''), 'device_id'));
  console.log('  stored cookie csrftoken =', pick(String(s.cookie || ''), 'csrftoken'));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
