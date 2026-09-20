'use strict';
/**
 * 账号信息采集自测 —— 用**真实 cookie** 把「采集 → 回报」这条链路跑通。
 *
 * 为什么要有这个自测：
 * 控制台上「每个号还剩多少积分」是节点采回来的，而节点在墙外、开发机在墙内。
 * 直接跑节点进程验不了这条链路（开发机够不到 ads.tiktok.com，得经代理）。
 * 所以这里把 `collectAccountInfo` 的 `fetchImpl` 换成**走代理的 curl**，
 * 让「采集」这段代码在本机也能用真实数据跑一遍 —— 验的是同一份代码。
 *
 * 用法（在本目录下）：
 *   node selftest/accountpool.js --cookie /path/cookie.txt \
 *        --proxy http://127.0.0.1:7890 [--report --pool http://… --token … --account 1]
 *
 * 不带 --report 就只采集、不打扰号池。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const tiktok = require('../lib/tiktok');
const { normalizeSession } = require('../lib/session');
const { cfg } = require('../lib/config');
const { curlFetch } = require('./proxyfetch');

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);

let pass = 0;
let fail = 0;
function check(label, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${extra ? ' —— ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? ' —— ' + extra : ''}`); }
}

/** 直连打号池（不走代理：号池在国内，绕海外反而更慢更容易失败）。 */
function poolPost(url, token, payload) {
  const args = ['-sS', '-m', '30', '-X', 'POST', url,
                '-H', 'Content-Type: application/json',
                '-H', `Authorization: Bearer ${token}`,
                '--data-binary', '@-'];
  const p = spawnSync('curl.exe', args, {
    input: JSON.stringify(payload), maxBuffer: 8 * 1024 * 1024,
  });
  if (p.error) throw p.error;
  const raw = p.stdout.toString('utf8');
  try { return JSON.parse(raw); } catch { return { _raw: raw.slice(0, 400) }; }
}

async function main() {
  const cookieFile = arg('cookie');
  const proxy = arg('proxy', process.env.HTTPS_PROXY || '');
  if (!cookieFile) {
    console.error('用法：node selftest/accountpool.js --cookie /path/cookie.txt [--proxy …]');
    process.exit(2);
  }
  const cookie = fs.readFileSync(path.resolve(cookieFile), 'utf8').trim();
  const session = normalizeSession({
    cookie,
    x_csrftoken: (cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '',
    x_fp_id: arg('fp', '68320d0b1fb0a537e8715e73d8c4c053'),
    device_id: arg('did', '7671503800712054289'),
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  });
  const fetchImpl = curlFetch(proxy);
  console.log(`目标 ${cfg.origin}${proxy ? `（经代理 ${proxy}）` : '（直连）'}`);
  console.log('');

  // ---- 1) 验活 ----
  console.log('[1] 会话验活 probeSession');
  const probe = await tiktok.probeSession(session, cfg, { fetchImpl });
  check('拿到业务码', probe.code !== null && probe.code !== undefined,
    `code=${probe.code} status=${probe.status}`);
  check('会话未失效（非 10001106）', probe.code !== tiktok.LOGIN_REQUIRED_CODE);

  // ---- 2) 积分 ----
  console.log('\n[2] 积分账户 creditAccount');
  const credit = await tiktok.creditAccount(session, cfg, { fetchImpl });
  check('接口通', credit.ok, credit.ok ? `HTTP ${credit.status}` : (credit.error || ''));
  if (credit.ok) {
    check('credits 是数字', Number.isFinite(credit.credits), `credits=${credit.credits}`);
    check('bonus 是数字', Number.isFinite(credit.bonus), `bonus=${credit.bonus}`);
    check('★ 合计口径 = credits + bonus',
      credit.total === credit.credits + credit.bonus,
      `total=${credit.total}（${credit.credits} + ${credit.bonus}）`);
    check('拿得到广告户名', Boolean(credit.adv_name), credit.adv_name);
  }

  // ---- 3) 并发上限 ----
  console.log('\n[3] 并发上限 generateMaxCount');
  const mx = await tiktok.generateMaxCount(session, cfg, { fetchImpl });
  check('接口通', mx.ok, mx.ok ? `max=${mx.max}` : `code=${mx.code}`);
  check('上限 > 0', !mx.ok || Number(mx.max) > 0);

  // ---- 4) 在跑任务数 ----
  console.log('\n[4] 在跑任务数 runningCount');
  const rc = await tiktok.runningCount(session, cfg, { fetchImpl });
  check('接口通', rc.ok, rc.ok ? `total=${rc.total}` : `code=${rc.code}`);

  // ---- 5) 分档额度 ----
  console.log('\n[5] 分档每日额度 generationQuota');
  const q = await tiktok.generationQuota(session, cfg, { fetchImpl });
  check('接口通', q.ok, q.ok ? `档位 ${Object.keys(q.daily).length} 个` : `code=${q.code}`);
  if (q.ok) {
    check('三个档位都在', tiktok.QUOTA_STRATEGIES.every((s) => q.daily[s]),
      tiktok.QUOTA_STRATEGIES.map((s) => `${s}:${(q.daily[s] || {}).remaining}`).join(' '));
    check('带着重置时间', Number(q.reset_ts) > 0);
  }

  // ---- 6) 合成快照 ----
  console.log('\n[6] 合成快照 collectAccountInfo（单项失败不影响整体）');
  const info = await tiktok.collectAccountInfo(session, cfg, { fetchImpl, log: null });
  check('快照里有 ts', Number(info.ts) > 0);
  check('快照里有 credits/bonus',
    info.credits !== undefined || info.bonus !== undefined);
  const merged = (Number(info.credits) || 0) + (Number(info.bonus) || 0);
  check('★ 号池页面口径能算出来', merged > 0, `${merged} 分`);
  console.log('\n快照原文：');
  console.log(JSON.stringify(info, null, 2));

  // ---- 7) 回报号池（可选）----
  if (has('report')) {
    const pool = arg('pool', 'http://39.96.66.94');
    const token = arg('token');
    const accountId = Number(arg('account', '1'));
    console.log(`\n[7] 回报号池 ${pool}（account_id=${accountId}）`);
    const r = poolPost(`${pool}/api/v1/agent/account/report`, token, {
      agent_id: 'selftest-accountpool',
      account_id: accountId,
      ok: probe.alive,
      code: probe.code,
      message: `selftest：${String(probe.message || '').slice(0, 160)}`,
      info,
    });
    check('回报被接受', r && r.ok === true, JSON.stringify(r).slice(0, 200));
  } else {
    console.log('\n（跳过回报；加 --report --token <agent_token> 可写入号池）');
  }

  console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('自测自身出错：', err && err.stack || err);
  process.exit(3);
});
