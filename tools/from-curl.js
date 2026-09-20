#!/usr/bin/env node
'use strict';
/**
 * 「Copy as cURL」→ session.json（+ 可直接贴进托管平台环境变量的 base64）
 *
 * 用法
 * ----
 *   # 1) 浏览器里抓一次真请求，导出成文件
 *   #    DevTools → Network → 选任意一条 creative_bff_i18n 请求
 *   #    → 右键 → Copy → **Copy as cURL (bash)** → 粘进 curl.txt
 *
 *   # 2) 转换
 *   node tools/from-curl.js --in curl.txt
 *   #    → 写出 session.json，并打印 base64
 *
 *   # 3) 把打印出来的 base64 原样贴进 RH_SESSION_JSON
 *
 *   # 也支持 stdin
 *   pbpaste | node tools/from-curl.js --stdin
 *
 * 为什么必须走 cURL 而不是 `document.cookie`
 * ------------------------------------------
 * 🔴 **`document.cookie` 读不到 httpOnly 的 cookie**，而身份层认的
 *    `sessionid_ads` 正是 httpOnly。在 Console 里 `copy(document.cookie)`
 *    会得到一个「看着很长、其实少了关键几项」的假凭据 —— 拿去部署会在
 *    第一次出片时收到 `10001106 Login Required`，而你会以为是 TTL 到期。
 *    cURL 是 DevTools 从网络层导出的，**包含 httpOnly**，这才是真凭据。
 *
 * 只做解析与校验，**不联网、不消耗任何额度**。
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseCookies, adsLifetime, remainingText, normalizeSession } = require('../lib/session');

// ---------------------------------------------------------------------------
// cURL 解析
// ---------------------------------------------------------------------------

/** 把 `\` 续行拼回一行，避免多行 cURL 拆断 header。 */
function unfold(text) {
  return String(text).replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ');
}

/**
 * 取出所有 header。兼容三种写法：
 *   -H 'k: v'      -H "k: v"      --header "k: v"
 * 以及 bash 的 ANSI-C 引用 `$'k: v'`（值里有转义时会出现）。
 */
function parseHeaders(line) {
  const out = [];
  const re = /(?:-H|--header)\s+\$?(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const raw = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const i = raw.indexOf(':');
    if (i < 0) continue;
    out.push([raw.slice(0, i).trim().toLowerCase(), raw.slice(i + 1).trim()]);
  }
  return out;
}

function parseUrl(line) {
  const m = line.match(/(?:^|\s)-{0,2}[A-Za-z-]*\s*(['"])(https?:\/\/[\s\S]*?)\1/)
    || line.match(/(['"])(https?:\/\/[\s\S]*?)\1/);
  if (m) return m[2];
  const bare = line.match(/https?:\/\/\S+/);
  return bare ? bare[0] : '';
}

// cookie 解析与寿命推算复用 `lib/session.js`（运行时与工具只有一份实现）
// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

function die(msg, hint) {
  console.error(`\n🔴 ${msg}`);
  if (hint) console.error(`   ${hint}`);
  process.exit(1);
}

async function readInput() {
  if (has('--stdin')) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }
  const file = arg('--in');
  if (!file) die('没给输入。用 `--in curl.txt` 或 `--stdin`。');
  if (!fs.existsSync(file)) die(`文件不存在：${file}`);
  return fs.readFileSync(file, 'utf8');
}

(async () => {
  const line = unfold(await readInput());
  if (!line.trim()) die('输入是空的。');

  const headers = parseHeaders(line);
  const hmap = {};
  for (const [k, v] of headers) hmap[k] = v;   // 同名后者胜

  const url = parseUrl(line);
  const cookie = hmap.cookie || '';
  const cookies = parseCookies(cookie);

  // 网络层没导出 cookie 头，但正文里就是 cookie 值 —— 兜底
  let cookieUsed = cookie;
  if (!cookieUsed && /sessionid\s*=/.test(line)) {
    cookieUsed = line.replace(/^\s*curl\s+/i, '').trim();
    Object.assign(cookies, parseCookies(cookieUsed));
  }
  if (!cookieUsed) {
    die('没找到 `cookie` 请求头。',
      '确认用的是 **Copy as cURL (bash)**，而不是「Copy URL」或 `document.cookie`。');
  }

  // device_id：优先 URL 查询参数，其次命令行覆盖
  let deviceId = arg('--device-id', '');
  if (!deviceId && url) {
    const q = new URL(url).searchParams;
    deviceId = q.get('device_id') || q.get('did') || '';
  }
  const csrf = hmap['x-csrftoken'] || cookies.csrftoken || '';
  const fpId = hmap['x-fp-id'] || '';
  const ua = hmap['user-agent'] || '';

  const sess = { cookie: cookieUsed, x_csrftoken: csrf, device_id: deviceId };
  if (fpId) sess.x_fp_id = fpId;
  if (ua) sess.user_agent = ua;

  // ---- 校验 ----
  const missing = ['cookie', 'x_csrftoken', 'device_id'].filter((k) => !sess[k]);
  if (missing.length) {
    const why = {
      x_csrftoken: 'cookie 里有 `csrftoken` 就能自动补；这条请求可能不带它',
      device_id: 'URL 里没有 `device_id=` 查询参数，可用 `--device-id <值>` 指定',
    };
    die(`缺必需字段：${missing.join(', ')}`, why[missing[0]]);
  }
  normalizeSession(sess);   // 与运行时同一份校验，别让两边判定不一致

  // ---- 报告 ----
  const mask = (s) => (s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-4)}（${s.length} 字符）`);
  const lt = adsLifetime(cookieUsed);
  const keys = Object.keys(cookies);

  console.log('\n■ 解析结果');
  console.log(`  来源 URL      ${url ? url.split('?')[0] : '（未识别）'}`);
  console.log(`  cookie        ${keys.length} 个键`);
  console.log(`  x_csrftoken   ${mask(csrf)}`);
  console.log(`  device_id     ${deviceId}`);
  console.log(`  x_fp_id       ${fpId ? mask(fpId) : '（无，实测可省）'}`);
  console.log(`  user_agent    ${ua ? ua.slice(0, 60) + (ua.length > 60 ? '…' : '') : '（无，将用内置默认值）'}`);

  console.log('\n■ cookie 关键项');
  const FLAG = [
    ['sessionid_ads', '广告线身份层 —— **号池认的就是它**'],
    ['csrftoken', '与 x-csrftoken 配对'],
    ['sid_guard_ads', '广告线有效期声明'],
    ['sessionid', '通用登录态（180 天，号池不认）'],
    ['ttwid', '设备指纹'],
  ];
  for (const [k, why] of FLAG) {
    console.log(`  ${keys.includes(k) ? '✓' : '·'} ${k.padEnd(16)} ${why}`);
  }

  if (!keys.includes('sessionid_ads')) {
    console.log('\n🔴 **没有 `sessionid_ads`** —— 号池的身份层认的就是它。');
    console.log('   这份凭据大概率来自「通用线」页面（tiktok.com 主站），而不是');
    console.log('   广告线 Creative Studio。请到 ads.tiktok.com 的 Creative Studio');
    console.log('   里重新抓一条请求再试。');
    process.exitCode = 2;
  } else if (lt && lt.remain != null) {
    console.log(`\n■ 广告线会话寿命`);
    console.log(`  声明 TTL     ${lt.ttl ? lt.ttl + ' 秒（≈ ' + (lt.ttl / 86400).toFixed(1) + ' 天）' : '?'}`);
    console.log(`  到期         ${lt.expire ? new Date(lt.expire * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '?'}`);
    console.log(`  剩余         ${remainingText(lt.remain)}`);
    if (lt.remain <= 0) {
      console.log('  🔴 已经过期了 —— 先重新登录再抓。');
      process.exitCode = 2;
    } else if (lt.remain < 24 * 3600) {
      console.log('  ⚠️ 不到 24 小时。建议现在就重抓一份。');
    }
  } else if (keys.includes('sessionid_ads')) {
    console.log('\n· `sid_guard_ads` 读不出到期时间（格式变了？）—— 不影响使用，');
    console.log('  按 3 天节奏定期更换即可。');
  }

  // ---- 输出 ----
  const json = JSON.stringify(sess);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const out = arg('--out', 'session.json');
  if (out !== '-') {
    fs.writeFileSync(out, JSON.stringify(sess, null, 2) + '\n', { mode: 0o600 });
    console.log(`\n■ 已写出 ${path.resolve(out)}（权限 0600，已被 .gitignore 忽略）`);
  }

  if (!has('--no-b64')) {
    console.log('\n■ RH_SESSION_JSON 的值（原样贴，别加引号）');
    console.log(b64);
    console.log(`\n  ${b64.length} 字符 · 解出来 ${json.length} 字符`);
  }

  console.log('\n■ 下一步');
  console.log('  1) 本地先验一次（不花额度）：填好 RH_SESSION_JSON 后跑');
  console.log('       node preflight.js --session-only');
  console.log('  2) 通过后再贴进托管平台的环境变量。');
  console.log('\n⚠️ curl.txt 与 session.json 都是**账号控制权**，别提交、别外发。\n');
})().catch((err) => {
  console.error(`\n🔴 未预期错误：${err && err.stack || err}\n`);
  process.exit(1);
});
