#!/usr/bin/env node
/**
 * codepanel_fetch.js —— 对接接码平台（code-panel）取 TikTok 邮箱验证码。
 *
 * 2026-10-14 晚重构（对照《对外开放API(1).md》优化版）：改用新端点
 * **POST /api/fetch-code**（指定账号 → 服务端主动同步该账号 → 再查码，
 * 实测单次 3~5 秒返回），彻底替代旧版「轮询 /api/latest + 定时 POST /api/sync
 * 插队」的两段式 —— 旧版的延迟根因（86 账号串行轮询一圈 6 分钟）已在
 * 平台侧根治（并行轮询 ~99s 一轮 + fetch-code 主动驱动）。
 *
 * 对接要点（文档 §24 实测口径）：
 *   · slug = 邮箱 local part，但**不要自己拼** —— 从 /api/accounts 按邮箱
 *     大小写不敏感精确匹配拿权威 slug（防大小写差异 404）。
 *   · /api/fetch-code 每次都真拉一次 Graph（重接口）：轮询间隔设 10s 起，
 *     预算 240s（与登录器给接码器的 300s 预算对齐）；HTTP 客户端超时 ≥60s。
 *   · age_seconds 防「旧码误用」：只收 age ≤ max-age 的码。
 *   · 退出码约定（调用方 tiktok_login.js 依赖）：
 *       0 = 取到码
 *       1 = 平台已配置且该邮箱在授权清单，但预算内没等到新码
 *           （调用方如实报失败，**不**回落微软网页登录，防风控）
 *       2 = 平台未配置 / 不可达 / 邮箱不在授权清单（调用方回落下一级链路）
 *
 * 用法：node codepanel_fetch.js --email <邮箱> [--budget 240] [--interval 10]
 *           [--max-age 240] [--within 10]
 * 输出：最后一行 JSON：{ok, code, age_seconds, slug, ...} 或 {ok:false, error, _rc}
 */
'use strict';

const fs = require('fs');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function out(obj) {
  obj._rc = obj._rc ?? (obj.ok ? 0 : 1);
  console.log(JSON.stringify(obj));
  process.exit(obj._rc);
}

const EMAIL = String(arg('email', '')).trim();
const BUDGET = Number(arg('budget', 240));     // 总预算（秒）
const INTERVAL = Number(arg('interval', 10));  // fetch-code 重试间隔（秒）
const MAX_AGE = Number(arg('max-age', 240));   // 只收 N 秒内的新码
const WITHIN = Number(arg('within', 10));      // 查最近 N 分钟（fetch-code within）

if (!EMAIL || !EMAIL.includes('@')) out({ ok: false, error: '缺少 --email', _rc: 2 });

const BASE = (process.env.RH_CODEPANEL_URL || '').replace(/\/+$/, '');
const USER = process.env.RH_CODEPANEL_USER || '';
const PASS = process.env.RH_CODEPANEL_PASS || '';

if (!BASE || !USER || !PASS) {
  out({ ok: false, error: '接码平台未配置（RH_CODEPANEL_URL/USER/PASS）', _rc: 2 });
}

const auth = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');

async function req(url, opts = {}, timeoutMs = 90_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, headers: { Authorization: auth, ...(opts.headers || {}) }, signal: ctl.signal });
    const txt = await r.text();
    let body = null;
    try { body = JSON.parse(txt); } catch { /* 非 JSON */ }
    return { status: r.status, body };
  } finally { clearTimeout(t); }
}

(async () => {
  // 1) 权威 slug（邮箱大小写不敏感精确匹配授权清单）
  let slug = null;
  try {
    const r = await req(BASE + '/api/accounts', {}, 20_000);
    const accs = (r.body && r.body.accounts) || [];
    const hit = accs.find((a) => String(a.email || '').toLowerCase() === EMAIL.toLowerCase());
    if (hit) slug = hit.slug;
  } catch (e) {
    out({ ok: false, error: '接码平台不可达：' + e.message, _rc: 2 });
  }
  if (!slug) {
    out({ ok: false, error: '邮箱不在接码平台授权清单：' + EMAIL, _rc: 2 });
  }

  // 2) 循环 POST /api/fetch-code：服务端先同步该账号（3~5s）再查码
  const t0 = Date.now();
  let lastNote = '';
  let tries = 0;
  while ((Date.now() - t0) / 1000 < BUDGET) {
    tries++;
    let r = null;
    try {
      r = await req(BASE + '/api/fetch-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, within: WITHIN, code_only: 1, days: 1, limit: 100 }),
      }, 90_000);
    } catch (e) {
      lastNote = 'fetch-code 网络异常：' + e.message;
      await new Promise((res) => setTimeout(res, INTERVAL * 1000));
      continue;
    }
    const b = r.body;
    if (r.status === 404) out({ ok: false, error: '账号不在平台清单（' + slug + '）', _rc: 2 });
    if (r.status === 400) out({ ok: false, error: '平台参数被拒：' + JSON.stringify(b), _rc: 1 });
    if (!b) { lastNote = '平台返回非 JSON（HTTP ' + r.status + '）'; }
    else if (b.found && b.email && b.email.code) {
      const age = Number(b.email.age_seconds || 0);
      if (age > MAX_AGE) {
        lastNote = '窗口内码太旧（age ' + age + 's > ' + MAX_AGE + 's），防旧码误用继续等';
      } else {
        out({
          ok: true, code: String(b.email.code).trim(), slug,
          age_seconds: age, subject: b.email.subject || '', tries,
          sync_seconds: b.sync_seconds, elapsed: Math.round((Date.now() - t0) / 1000),
        });
      }
    } else {
      const anyAge = b.latest_any_age_seconds;
      lastNote = '窗口内无新码' + (typeof anyAge === 'number' ? '（最新一封 ' + Math.round(anyAge / 60) + ' 分钟前）' : '')
        + (b.sync_error ? '，同步异常：' + b.sync_error : '')
        + (b.note ? '，' + b.note : '');
    }
    await new Promise((res) => setTimeout(res, INTERVAL * 1000));
  }
  out({ ok: false, stage: 'no-code',
    error: '接码平台 ' + BUDGET + 's 内未取到新码（' + lastNote + '）', slug, tries });
})();
