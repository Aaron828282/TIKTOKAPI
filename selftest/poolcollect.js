'use strict';
/**
 * 账号池**整批采集**自测 —— 验 `sessionruntime.collectPool` 这条路径。
 *
 * 和 `accountpool.js` 的分工：
 *   accountpool.js  验「一个账号采得对不对」（解析口径、字段、合并公式）
 *   poolcollect.js  验「一批账号串起来对不对」（循环、错误隔离、回报载荷）
 *
 * 为什么单独测一批：号池里一行一个号，`collectPool` 要拿**清单**再逐个采。
 * 这里最容易出错的不是采集本身，而是「一个坏号把整批带崩」和
 * 「把网络抖动误判成凭据失效」。两个都是**静默**的 —— 界面看不出错，
 * 只是数字不再更新。所以要对真实号池跑一遍看回报。
 *
 * 用法（在本目录下）：
 *   node selftest/poolcollect.js --pool http://39.96.66.94 --token <agent_token> \
 *        --proxy http://127.0.0.1:7890
 */
const path = require('node:path');

const sessionruntime = require('../lib/sessionruntime');
const { createClient } = require('../lib/pool');
const { curlFetch } = require('./proxyfetch');

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

let pass = 0;
let fail = 0;
function check(label, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${extra ? ' —— ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? ' —— ' + extra : ''}`); }
}

async function main() {
  const pool = arg('pool', 'http://39.96.66.94');
  const token = arg('token');
  const proxy = arg('proxy', process.env.HTTPS_PROXY || '');
  const backend = arg('backend', 'tiktok_r2v');
  if (!token) {
    console.error('需要 --token <agent_token>');
    process.exit(2);
  }

  const client = createClient({ poolUrl: pool, agentToken: token });
  const lines = [];
  const log = (msg, level = 'info') => {
    lines.push(`    [${level}] ${msg}`);
    if (level !== 'debug') console.log(`    [${level}] ${msg}`);
  };

  console.log(`号池 ${pool} · backend ${backend}${proxy ? ` · 经代理 ${proxy}` : ''}`);
  console.log('');

  // ---- 1) 账号清单（这条就是本轮新加的接口）----
  console.log('[1] 拉账号清单 GET /api/v1/agent/accounts');
  let cl;
  try {
    cl = await client.accounts(backend);
  } catch (err) {
    check('清单接口可用', false, err.message);
    console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(1);
  }
  check('接口返回 ok', cl && cl.ok === true);
  check('清单里的账号带凭据', (cl.accounts || []).every((a) => a.session && a.session.cookie),
    `${(cl.accounts || []).length} 个账号`);

  // ---- 2) 整批采集 ----
  console.log('\n[2] 整批采集 collectPool（验活 + 积分 + 额度 + 并发上限，一次回报）');
  const r = await sessionruntime.collectPool(client, log, { backend, fetchImpl: curlFetch(proxy) });
  check('整批采集没抛异常', Boolean(r));
  check('至少回报成功一个账号', r && r.count > 0,
    `count=${r && r.count} / total=${r && r.total} / 会话有效 ${r && r.alive}`);
  check('一个账号失败没有带崩整批', r && r.ok === true);

  // ---- 3) 采集状态进了模块状态（/status 能看到）----
  console.log('\n[3] 采集状态可观测（/status 的 sessionruntime.status()）');
  const st = sessionruntime.status();
  check('记录了采集时间', Number(st.collectAt) > 0);
  check('记录了采集结论', st.collectOk === true || st.collectOk === false,
    `collectOk=${st.collectOk} count=${st.collectCount}`);

  console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
  if (fail) {
    console.log('\n采集日志：');
    console.log(lines.join('\n'));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('自测自身出错：', err && err.stack || err);
  process.exit(3);
});
