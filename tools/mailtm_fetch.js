#!/usr/bin/env node
/**
 * mailtm_fetch.js —— mail.tm 系邮箱（自定义域，MX=in.mail.tm）取 TikTok 邮箱验证码。
 *
 * 2026-10-22 新增：用户采购的「一拖一」号（邮箱+TikTok 商务中心）邮箱托管在
 * mail.tm（自定义域），不是 Microsoft 账号 —— codepanel_fetch（Graph OAuth）与
 * outlook_read（微软网页）两条链路均不适用，本工具是这些域名的专用接码通道。
 *
 * mail.tm 公开 API：
 *   POST {base}/token   {address, password} → {token}（JWT，24h）
 *   GET  {base}/messages?page=1 → 消息数组（裸数组或 hydra:member）
 *   GET  {base}/messages/{id}   → 详情（含 text 纯文本正文）
 * TikTok 商务中心验证码邮件特征：主题「验证帮助中心」，正文引导句
 * 「以下是你申请获取的验证码」后独立一行 6 位大写字母数字混合码（如 PCZ8QR），
 * 10 分钟有效 —— 抽取规则按此定（只收字母+数字混合、排除纯数字年份等）。
 *
 * 用法（由 tiktok_login.js 在邮箱域名命中 RH_MAILTM_DOMAINS 时调用）：
 *   node mailtm_fetch.js --email <邮箱> --password <邮箱密码>
 *        [--budget 240] [--interval 10] [--max-age 600] [--within 30]
 * 输出：最后一行 JSON {ok, code, age_seconds, tries, elapsed} 或 {ok:false, error, _rc}
 * 退出码约定（与 codepanel_fetch.js 一致，调用方依赖）：
 *   0 = 取到码
 *   1 = 平台可达且凭据有效，但预算内没等到新码（调用方如实报失败，不回落）
 *   2 = 配置缺失/不可达（--password 缺失、API 不可达、凭据被拒）（调用方回落下一级）
 */
'use strict';

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
const PASSWORD = String(arg('password', ''));
const BUDGET = Number(arg('budget', 240));      // 总预算（秒）
const INTERVAL = Number(arg('interval', 10));   // 轮询间隔（秒）
const MAX_AGE = Number(arg('max-age', 600));    // 只收 N 秒内的新码
const WITHIN = Number(arg('within', 30));       // 只看最近 N 分钟内的邮件
const BASE = (process.env.RH_MAILTM_API || 'https://api.mail.tm').replace(/\/+$/, '');

if (!EMAIL || !EMAIL.includes('@')) out({ ok: false, error: '缺少 --email', _rc: 2 });
if (!PASSWORD) out({ ok: false, error: '缺少 --password（mail.tm 邮箱密码）', _rc: 2 });

async function api(path, opts = {}, timeoutMs = 30_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const r = await fetch(BASE + path, { ...opts, headers, signal: ctl.signal });
    const txt = await r.text();
    let body = null;
    try { body = JSON.parse(txt); } catch { /* 非 JSON */ }
    return { status: r.status, body };
  } finally { clearTimeout(t); }
}

function ageSeconds(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
}

/** 从纯文本正文抽验证码：验证码引导句之后、独立成行的 4~8 位字母数字混合 token。 */
function extractCode(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/).map((s) => s.trim());
  const isToken = (s) => /^[A-Z0-9]{4,8}$/.test(s)
    && /[A-Z]/.test(s) && /[0-9]/.test(s);   // 必须字母数字混合，排除纯数字年份/数量
  const leadIdx = [];
  lines.forEach((ln, i) => {
    if (/验证码/.test(ln) || /verification code|enter this code|your code/i.test(ln)) leadIdx.push(i);
  });
  const scanFrom = (start, end) => {
    for (let i = Math.max(0, start); i < Math.min(lines.length, end); i++) {
      if (isToken(lines[i])) return lines[i];
    }
    return null;
  };
  for (const li of leadIdx) {
    const hit = scanFrom(li + 1, li + 6);   // 引导句后 5 行内
    if (hit) return hit;
  }
  return scanFrom(0, lines.length);         // 兜底：全文第一个独立 token
}

(async () => {
  // 1) 登录换 token（401/403 = 凭据被拒 → rc=2，调用方回落）
  let token = null;
  try {
    const r = await api('/token', {
      method: 'POST',
      body: JSON.stringify({ address: EMAIL, password: PASSWORD }),
    });
    if (r.status !== 200 || !r.body || !r.body.token) {
      out({
        ok: false, error: 'mail.tm 登录被拒（HTTP ' + r.status + '）'
          + (r.body && r.body.message ? '：' + r.body.message : ''),
        _rc: 2,
      });
    }
    token = r.body.token;
  } catch (e) {
    out({ ok: false, error: 'mail.tm 不可达：' + e.message, _rc: 2 });
  }

  // 2) 轮询：列消息 → 按时间窗过滤 → 拉详情抽码
  const t0 = Date.now();
  let tries = 0;
  let lastNote = '';
  while ((Date.now() - t0) / 1000 < BUDGET) {
    tries++;
    let items = null;
    try {
      const r = await api('/messages?page=1', { headers: { Authorization: 'Bearer ' + token } });
      if (r.status !== 200) { lastNote = '列消息 HTTP ' + r.status; }
      else items = Array.isArray(r.body) ? r.body : (r.body && r.body['hydra:member']) || [];
    } catch (e) {
      lastNote = '列消息网络异常：' + e.message;
      await new Promise((res) => setTimeout(res, INTERVAL * 1000));
      continue;
    }
    // 时间窗内最新优先
    const fresh = items
      .map((m) => ({ m, age: ageSeconds(m.createdAt) }))
      .filter((x) => x.age !== null && x.age <= WITHIN * 60)
      .sort((a, b) => a.age - b.age);
    for (const { m, age } of fresh) {
      try {
        const d = await api('/messages/' + encodeURIComponent(m.id),
          { headers: { Authorization: 'Bearer ' + token } });
        if (d.status !== 200 || !d.body) continue;
        const text = d.body.text || '';
        const html = Array.isArray(d.body.html) ? d.body.html.join('\n') : (d.body.html || '');
        const code = extractCode(text) || extractCode(String(html).replace(/<[^>]+>/g, '\n'));
        if (code) {
          if (age > MAX_AGE) { lastNote = '码太旧（age ' + age + 's > ' + MAX_AGE + 's）'; break; }
          out({
            ok: true, code, age_seconds: age, tries,
            subject: m.subject || '', from: (m.from || {}).address || '',
            elapsed: Math.round((Date.now() - t0) / 1000),
          });
        }
      } catch (e) { lastNote = '拉详情异常：' + e.message; }
    }
    lastNote = lastNote || ('窗口内 ' + fresh.length + ' 封，未抽到新码');
    await new Promise((res) => setTimeout(res, INTERVAL * 1000));
  }
  out({ ok: false, stage: 'no-code', error: 'mail.tm ' + BUDGET + 's 内未取到新码（' + lastNote + '）', tries });
})();
