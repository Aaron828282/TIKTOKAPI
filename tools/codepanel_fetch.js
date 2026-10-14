#!/usr/bin/env node
/**
 * 接码平台（code-panel）取码器 —— OTP 接码第二级链路（2026-10-14）
 *
 * 背景：outlook 网页接码器（outlook_read.js）在「本机没有已登录会话」时要
 * 做微软密码登录，机房 IP + 新设备几乎必触发「验证身份」二次验证风控
 * （2026-10-14 #28 实锤）。接码平台（code-panel）对授权邮箱走 OAuth 令牌
 * 读信（设备码授权落盘 token），完全不碰网页登录，天然绕开该风控。
 *
 * 用法（由 tools/tiktok_login.js 的 fetchOtpCode 链路 spawn，也可手工跑）:
 *   node codepanel_fetch.js --email a@outlook.com \
 *        [--within 10] [--max-age 240] [--interval 5] [--budget 240]
 *
 * 环境变量（缺一即退出码 2，调用方回落网页接码）:
 *   RH_CODEPANEL_URL   平台基址（如 https://desktop-q4ks6qj.taila9c26e.ts.net）
 *   RH_CODEPANEL_USER  Basic 用户名
 *   RH_CODEPANEL_PASS  Basic 密码
 *
 * 输出: JSON {ok, stage, code?, subject?, from?, age_seconds?, slug?, error?}
 * 退出码: 0=拿到码
 *         1=平台已覆盖该邮箱但没取到新码（调用方**不要**再回落网页登录，
 *            如实报失败 —— 面板有 45s 同步延迟，码晚到好过再触一次风控）
 *         2=平台未配置/鉴权失败/不可达/邮箱不在授权清单（调用方回落网页接码）
 *
 * 对接要点（对照《对外开放API.md》2026-10-14 版实测）：
 *   · slug = 邮箱 local part，但**不要自己拼** —— 从 /api/accounts 按邮箱
 *     大小写不敏感精确匹配拿权威 slug（防大小写差异 404）。
 *   · 面板后台每 45s 自动同步一轮，取码有 ~45-70s 延迟 → 轮询 5s/次、
 *     预算 240s（与登录器给接码器的 300s 预算对齐）。
 *   · /api/latest 的 age_seconds 防「旧码误用」：只收 age ≤ max-age 的码。
 */
'use strict';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
}
function numArg(name, def) {
  const v = arg(name);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const EMAIL = String(arg('email', '') || '').trim();
const WITHIN = numArg('within', 10);      // /api/latest 时间窗（分钟）
const MAX_AGE = numArg('max-age', 240);   // 只收比这新的码（秒），防旧码
const INTERVAL = numArg('interval', 5);   // 轮询间隔（秒）
const BUDGET = numArg('budget', 240);     // 总预算（秒）

const BASE = (process.env.RH_CODEPANEL_URL || '').trim().replace(/\/+$/, '');
const USER = process.env.RH_CODEPANEL_USER || '';
const PASS = process.env.RH_CODEPANEL_PASS || '';

function out(obj) { console.log(JSON.stringify(obj)); process.exit(obj._rc || (obj.ok ? 0 : 1)); }

(async () => {
  if (!EMAIL) out({ ok: false, stage: 'config', error: 'missing --email', _rc: 1 });
  if (!BASE || !USER || !PASS) {
    out({ ok: false, stage: 'panel-disabled',
      error: '接码平台未配置（RH_CODEPANEL_URL / USER / PASS）', _rc: 2 });
  }

  const auth = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
  async function getJson(url, timeoutMs = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: { Authorization: auth }, signal: ctl.signal });
      const txt = await r.text();
      let body = null;
      try { body = JSON.parse(txt); } catch { /* 非 JSON 原样返回 null */ }
      return { status: r.status, body };
    } finally { clearTimeout(t); }
  }

  // 1) 解析 slug：/api/accounts 按 email 大小写不敏感精确匹配
  let slug = '';
  try {
    const r = await getJson(BASE + '/api/accounts');
    if (r.status === 401) out({ ok: false, stage: 'panel-auth', error: '接码平台鉴权失败（401）', _rc: 2 });
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.accounts)) {
      out({ ok: false, stage: 'panel-error', error: '账号清单获取失败（HTTP ' + r.status + '）', _rc: 2 });
    }
    const hit = r.body.accounts.find(
      (a) => String(a.email || '').toLowerCase() === EMAIL.toLowerCase());
    if (!hit) out({ ok: false, stage: 'no-account', error: '该邮箱不在接码平台授权清单', _rc: 2 });
    slug = hit.slug;
  } catch (e) {
    out({ ok: false, stage: 'panel-error', error: '接码平台不可达：' + e.message, _rc: 2 });
  }

  // 2) 轮询 /api/latest 直到预算耗尽
  const t0 = Date.now();
  let lastNote = '';
  while ((Date.now() - t0) / 1000 < BUDGET) {
    try {
      const url = BASE + '/api/latest?account=' + encodeURIComponent(slug)
        + '&within=' + WITHIN + '&code_only=1';
      const r = await getJson(url);
      if (r.status === 200 && r.body && r.body.found && r.body.email && r.body.email.code) {
        const em = r.body.email;
        const age = Number(em.age_seconds) || 0;
        if (age <= MAX_AGE && /^\d{4,8}$/.test(String(em.code))) {
          out({ ok: true, stage: 'panel', code: String(em.code),
            subject: em.subject || '', from: em.from || '',
            age_seconds: age, slug });
        }
        lastNote = '最新码 age=' + age + 's 超过新鲜度上限 ' + MAX_AGE + 's，继续等新码';
      } else if (r.status === 200 && r.body) {
        lastNote = r.body.hint ? '窗口内无带码邮件（' + r.body.hint + '）' : '窗口内无带码邮件';
      } else {
        lastNote = 'HTTP ' + r.status;
      }
    } catch (e) {
      lastNote = '请求异常：' + e.message;
    }
    await new Promise((res) => setTimeout(res, INTERVAL * 1000));
  }
  out({ ok: false, stage: 'no-code',
    error: '接码平台 ' + BUDGET + 's 内未取到新码（' + lastNote + '）', _rc: 1 });
})().catch((e) => {
  console.log(JSON.stringify({ ok: false, stage: 'crash', error: e.message, _rc: 2 }));
  process.exit(2);
});
