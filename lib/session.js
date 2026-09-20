'use strict';
/**
 * 会话凭据的**纯函数**部分 —— 解析、归一化、寿命推算。
 *
 * 刻意不碰 `process.env`、不碰网络：这样它既能被 `lib/config.js`（运行时）
 * 用，也能被 `tools/from-curl.js`（离线取凭据）用，两边只有一份实现。
 *
 * 广告线会话 TTL 只有 **3 天**（见 API.md §3.1），所以「还剩多久」是本模块
 * 最值钱的输出 —— 比「有没有 cookie」重要得多。
 */

/** 必需字段。缺任何一个，节点能起来但第一次出片必然失败。 */
const SESSION_REQUIRED = ['cookie', 'x_csrftoken', 'device_id'];
/** 抓包里出现过的可选头，给了就带上。 */
const SESSION_OPTIONAL = ['x_fp_id', 'user_agent'];

/** `a=1; b=2` → `{a:'1', b:'2'}`。同名键保留**最后一个**（`msToken` 会出现两次）。 */
function parseCookies(cookieHeader) {
  const out = {};
  for (const seg of String(cookieHeader || '').split(';')) {
    const i = seg.indexOf('=');
    if (i < 0) continue;
    const k = seg.slice(0, i).trim();
    if (k) out[k] = seg.slice(i + 1).trim();
  }
  return out;
}

/** 校验并挑出会话字段（保留可选字段，见 config.js 的说明）。 */
function normalizeSession(sess) {
  if (!sess || typeof sess !== 'object') {
    throw new Error('会话凭据解出来不是对象');
  }
  const missing = SESSION_REQUIRED.filter((k) => !sess[k]);
  if (missing.length) throw new Error(`会话凭据缺少必需字段：${missing.join(', ')}`);

  const out = {};
  for (const k of SESSION_REQUIRED.concat(SESSION_OPTIONAL)) {
    if (sess[k]) out[k] = String(sess[k]);
  }
  return out;
}

/**
 * 从 cookie 里推算**广告线**会话的到期时间。
 *
 * 声明格式（实测）：`sid_guard_ads = <会话 id>|<签发时间戳>|259200|<过期时间>`
 * 通用线 `sid_guard` 是同一个格式但 TTL 180 天 —— **号池认广告线**，别混。
 *
 * 解析不出来返回 `null`，不算错：只影响提示，不影响使用。
 */
function adsLifetime(sessionOrCookie) {
  // 两种入参都接受：整条 cookie 头，或带 `cookie` 字段的会话对象
  const raw = typeof sessionOrCookie === 'string'
    ? sessionOrCookie
    : (sessionOrCookie && sessionOrCookie.cookie) || '';
  let value = parseCookies(raw)['sid_guard_ads'] || '';
  if (!value) return null;
  if (value.includes('%7C')) {
    try { value = decodeURIComponent(value); } catch { /* 保持原样 */ }
  }

  const parts = value.split('|').map((s) => s.trim());
  const nums = parts.filter((p) => /^\d+$/.test(p)).map(Number);
  const issue = nums.find((n) => n > 1_600_000_000 && n < 2_200_000_000) || null;
  const ttl = nums.find((n) => n > 0 && n <= 40_000_000) || null;

  let expire = issue && ttl ? issue + ttl : null;
  if (!expire) {
    for (const p of parts) {
      const t = Date.parse(p);
      if (!Number.isNaN(t)) { expire = Math.floor(t / 1000); break; }
    }
  }
  if (!expire) return { ttl, expire: null, remain: null };
  return { ttl, expire, remain: expire - Math.floor(Date.now() / 1000) };
}

/** 秒 → 「3 天 4 小时」这类人类可读串（纯时长，不带方向）。 */
function humanDuration(sec) {
  if (sec == null) return '?';
  const s = Math.abs(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

/** 「还剩 2 天 3 小时」/「已过期 5 小时」—— 带方向，直接可用于提示语。 */
function remainingText(sec) {
  if (sec == null) return '到期时间未知';
  return sec < 0 ? `已过期 ${humanDuration(sec)}` : `还剩 ${humanDuration(sec)}`;
}

/**
 * 一句话概括「这份凭据现在什么状态」——启动日志与自检共用。
 * `level`: 'ok' | 'warn' | 'dead'
 */
function describe(session) {
  const cookies = parseCookies(session && session.cookie);
  const keys = Object.keys(cookies);
  const lt = adsLifetime(session);

  let level = 'ok';
  let note = '';
  if (!keys.includes('sessionid_ads')) {
    level = 'warn';
    note = '没有 sessionid_ads（取自通用线页面？号池认广告线）';
  }
  if (lt && lt.remain != null) {
    if (lt.remain <= 0) { level = 'dead'; note = `广告线会话${remainingText(lt.remain)}`; }
    else if (lt.remain < 12 * 3600) { level = 'warn'; note = `广告线会话${remainingText(lt.remain)}`; }
    else { note = `广告线会话${remainingText(lt.remain)}`; }
  } else if (!note) {
    note = '读不出到期时间（按 3 天节奏换）';
  }
  return { level, note, cookieKeys: keys, lifetime: lt };
}

module.exports = {
  SESSION_REQUIRED,
  SESSION_OPTIONAL,
  parseCookies,
  normalizeSession,
  adsLifetime,
  humanDuration,
  remainingText,
  describe,
};
