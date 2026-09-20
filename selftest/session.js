#!/usr/bin/env node
'use strict';
/**
 * `lib/session.js` 的离线断言 —— 不联网、不需要任何真实凭据。
 *
 * 为什么值得单测：这个模块的输出会**决定部署判断**。「广告线会话还剩多久」
 * 算错的代价是——要么误判为过期去重抓一份（浪费），要么误判为健康、
 * 三天后每个任务在上游拿 `10001106`（线上事故）。
 *
 * 跑法：node selftest/session.js     （退出码 0 = 全过）
 */
const S = require('../lib/session');

let pass = 0;
let fail = 0;

function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? '  ← ' + detail : ''}`); }
}
function eq(name, got, want) {
  ok(name, got === want, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
}
function head(t) { console.log(`\n■ ${t}`); }

// ---------------------------------------------------------------------------
head('parseCookies');
{
  const c = S.parseCookies('a=1; b=2; sess=xy%3Dz; ; broken; c=3');
  // a / b / sess / c —— 空段与没有 `=` 的 `broken` 都被跳过
  eq('跳过空段与无 = 段', Object.keys(c).length, 4);
  eq('值里的 = 不被截断', c.sess, 'xy%3Dz');
  eq('无 = 的段被跳过', c.broken, undefined);

  // ⚠️ msToken 在真实抓包里出现两次且值相同 —— 前端 append 了两次
  const dup = S.parseCookies('msToken=A; x=1; msToken=A');
  eq('重复键保留最后一个', dup.msToken, 'A');
  eq('空串 cookie 不炸', Object.keys(S.parseCookies('')).length, 0);
  eq('undefined 不炸', Object.keys(S.parseCookies(undefined)).length, 0);
}

// ---------------------------------------------------------------------------
head('normalizeSession');
{
  const full = S.normalizeSession({
    cookie: 'c', x_csrftoken: 'x', device_id: 'd', x_fp_id: 'F', user_agent: 'UA', 无关字段: 1,
  });
  eq('必需三键齐全', Object.keys(full).filter((k) => ['cookie', 'x_csrftoken', 'device_id'].includes(k)).length, 3);
  eq('可选字段透传 x_fp_id', full.x_fp_id, 'F');
  eq('可选字段透传 user_agent', full.user_agent, 'UA');
  eq('无关字段被丢弃', full.无关字段, undefined);

  let threw = '';
  try { S.normalizeSession({ cookie: 'c' }); } catch (e) { threw = e.message; }
  ok('缺字段会抛错', threw.includes('x_csrftoken') && threw.includes('device_id'), threw);

  threw = '';
  try { S.normalizeSession(null); } catch (e) { threw = e.message; }
  ok('null 会抛错', threw.length > 0, threw);
}

// ---------------------------------------------------------------------------
head('adsLifetime');
{
  const now = Math.floor(Date.now() / 1000);
  // 实测格式：<会话 id>|<签发时间戳>|259200|<过期时间>
  const issued = now - 3600;                         // 1 小时前签发
  const cookie = `sessionid_ads=abc; sid_guard_ads=sid%7C${issued}%7C259200%7CMon%2C+01-Jan-2027`;

  const lt = S.adsLifetime(cookie);
  ok('解析出 TTL', lt && lt.ttl === 259200, JSON.stringify(lt));
  ok('由「签发 + TTL」算出到期', lt && lt.expire === issued + 259200, JSON.stringify(lt));
  ok('剩余约 3 天 − 1 小时', lt && Math.abs(lt.remain - (259200 - 3600)) < 5, String(lt && lt.remain));

  eq('没有 sid_guard_ads 返回 null',
    S.adsLifetime('sessionid_ads=abc; a=1'), null);

  // URL 编码的 | 与未编码的 | 都要认
  const plain = S.adsLifetime({ cookie: `sid_guard_ads=x|${issued}|259200|zzz` });
  ok('未编码的 | 也能解析', plain && plain.ttl === 259200, JSON.stringify(plain));

  // 过期
  const dead = S.adsLifetime({ cookie: `sid_guard_ads=x|${now - 400000}|259200|zzz` });
  ok('过期时 remain 为负', dead && dead.remain < 0, JSON.stringify(dead));

  // 只有日期、没有数字 TTL —— 走 Date.parse 兜底，不该抛
  const odd = S.adsLifetime({ cookie: 'sid_guard_ads=x|y|z|' + new Date().toUTCString() });
  ok('退化输入不抛异常', odd === null || typeof odd.remain === 'number' || odd.remain === null,
    JSON.stringify(odd));
}

// ---------------------------------------------------------------------------
head('humanDuration / remainingText');
{
  eq('刚好 2 天', S.humanDuration(2 * 86400), '2 天 0 小时');
  eq('90 分', S.humanDuration(5400), '1 小时 30 分');
  eq('30 秒 → 0 分', S.humanDuration(30), '0 分');
  eq('负数取模（不带方向）', S.humanDuration(-86400), '1 天 0 小时');
  eq('剩余文案', S.remainingText(7200), '还剩 2 小时 0 分');
  eq('过期文案', S.remainingText(-7200), '已过期 2 小时 0 分');
  eq('未知', S.remainingText(null), '到期时间未知');
}

// ---------------------------------------------------------------------------
head('describe —— 决定部署判断的那三档');
{
  const now = Math.floor(Date.now() / 1000);
  const make = (sgv) => `sessionid_ads=a; csrftoken=k; ${sgv}`;

  const healthy = S.describe({ cookie: make(`sid_guard_ads=x|${now}|259200|z`) });
  eq('健康 → ok', healthy.level, 'ok');

  const soon = S.describe({ cookie: make(`sid_guard_ads=x|${now - 250000}|259200|z`) });
  eq('不足 12 小时 → warn', soon.level, 'warn');
  ok('提示语点出剩余', soon.note.includes('还剩'), soon.note);

  const dead = S.describe({ cookie: make(`sid_guard_ads=x|${now - 400000}|259200|z`) });
  eq('已过期 → dead', dead.level, 'dead');
  ok('提示语点出已过期', dead.note.includes('已过期'), dead.note);

  // 通用线 cookie：有 sessionid 但没有 sessionid_ads
  const generic = S.describe({ cookie: 'sessionid=abc; csrftoken=k' });
  eq('通用线 → warn', generic.level, 'warn');
  ok('提示语点出 sessionid_ads', generic.note.includes('sessionid_ads'), generic.note);
  eq('cookie 键数正确', generic.cookieKeys.length, 2);

  // 有 sessionid_ads 但读不出寿命：不该被判死
  const unknown = S.describe({ cookie: 'sessionid_ads=a; csrftoken=k' });
  eq('读不出寿命 → 仍是 ok', unknown.level, 'ok');
  ok('提示语说明读不出', unknown.note.includes('读不出'), unknown.note);
}

// ---------------------------------------------------------------------------
console.log(`\n${fail ? '✗' : '✓'} session 自测：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
