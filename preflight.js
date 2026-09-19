#!/usr/bin/env node
'use strict';
/**
 * 海外执行节点 —— 上线前置验收（preflight）。
 *
 * 在一台**即将承载执行节点**的机器上运行，一次性回答三个问题：
 *
 *     A. 这台机器是不是干活的材料？  （Node 版本 / 落地国家 / 时钟 / 规格）
 *     B. 能不能连上号池？            （拉活通道：claim / heartbeat / result）
 *     C. 能不能连上 TikTok 上游？    （真正的业务链路：bff / upload-proxy / CDN）
 *
 * 设计约束
 * --------
 * * **零 npm 依赖、单文件可跑** —— 裸机 `node preflight.js` 直接出结果。
 * * **绝不下单、绝不花钱** —— 唯一发出的真实业务请求是「空体探活」，
 *   上游会因为缺参数回一个业务错误码，而这恰好证明整条链路是通的。
 * * **不打印任何凭据**（令牌只回「有没有配」，cookie 一个字节都不碰）。
 *
 * 用法：
 *     node preflight.js                                  # 生产：直连
 *     node preflight.js --proxy http://127.0.0.1:7890     # 借代理当海外视角
 *     node preflight.js --pool 39.96.66.94 --token XXX
 *
 * 退出码：0 = 必检项全过；1 = 有必检项失败。
 *
 * ⚠️ 关于 `--proxy`：裸 `net.connect` **不认代理**。本文件所有 TCP/TLS 探测
 *    都走 `TunnelAgent`（先 `CONNECT` 打隧道再握手），否则探测的是「本机直连」，
 *    会出现「代理明明通、TCP 却 timed out」的假失败。
 */
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const os = require('node:os');
const fs = require('node:fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const TIKTOK_HOST = 'ads.tiktok.com';
const HISTORY_PATH = '/creative_bff_i18n/api/cue/history/tasks';
const UPLOAD_PROXY_PATH = '/creative/creativestudio/upload-proxy';
const CDN_HOST = 'p19-creative-tool-sg.ibyteimg.com';
const REFERER = 'https://ads.tiktok.com/creative/creativestudio/image-to-video';

const RESULTS = [];
const START = Date.now();

function rec(name, ok, detail = '', required = true) {
  RESULTS.push({ required, name, ok: Boolean(ok), detail });
  const mark = ok ? '[ OK ]' : (required ? '[FAIL]' : '[WARN]');
  console.log(`  ${mark} ${name.padEnd(44)} ${detail}`);
  return Boolean(ok);
}

const head = (t) => {
  console.log(`\n${'-'.repeat(86)}\n${t}\n${'-'.repeat(86)}`);
};

// ---------------------------------------------------------------------------
// HTTP 底座：直连 or 经代理隧道
// ---------------------------------------------------------------------------
function parseProxy(proxy) {
  if (!proxy) return null;
  const u = new URL(proxy);
  return { host: u.hostname, port: Number(u.port || 80), auth: u.username
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
    : null };
}

/** 直连 TCP，或经 HTTP 代理打 CONNECT 隧道，返回已连通的 socket。 */
function connectThrough({ host, port, proxy, timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    const p = parseProxy(proxy);
    if (!p) {
      const sock = net.connect({ host, port });
      sock.setTimeout(timeout, () => sock.destroy(new Error('connect timeout')));
      sock.once('connect', () => resolve(sock));
      sock.once('error', reject);
      return;
    }
    const raw = net.connect({ host: p.host, port: p.port });
    raw.setTimeout(timeout, () => raw.destroy(new Error('proxy connect timeout')));
    raw.once('error', reject);
    raw.once('connect', () => {
      const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
      if (p.auth) lines.push(`Proxy-Authorization: ${p.auth}`);
      raw.write(lines.join('\r\n') + '\r\n\r\n');
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('latin1');
        if (!buf.includes('\r\n\r\n')) return;
        raw.removeListener('data', onData);
        if (!/^HTTP\/1\.[01] 200/.test(buf)) {
          raw.destroy();
          reject(new Error('CONNECT 被拒: ' + buf.split('\r\n')[0]));
          return;
        }
        resolve(raw);
      };
      raw.on('data', onData);
    });
  });
}

/** 经代理时把已连通的裸 socket 升成 TLS。 */
function upgradeTls(sock, host, ca, insecure) {
  return new Promise((resolve, reject) => {
    const opts = { socket: sock };
    // RFC 6066 不允许对 IP 字面量发 SNI；带上只会换来一条 DeprecationWarning
    if (!net.isIP(host)) opts.servername = host;
    if (ca) opts.ca = ca;
    if (insecure) opts.rejectUnauthorized = false;
    const s = tls.connect(opts, () => resolve(s));
    s.once('error', reject);
  });
}

/**
 * 自定义 Agent —— 让**每个请求**都能控制 TLS（号池是 IP 自签证书）并支持代理隧道。
 *
 * ⚠️ 为什么不能用 `agent: false` + 请求级 `createConnection`
 * ------------------------------------------------------------
 * 这个坑实测吃掉了整整一轮排查：`agent: false` 时 Node 会**自己新建一个默认
 * agent**，于是请求选项里的 `createConnection` 被**静默忽略**。表现是
 * 「所有请求都退化成直连」——
 *
 *   · 代理形同虚设（`--proxy` 打了等于没打，出口 IP 还是本机）；
 *   · `rejectUnauthorized: false` 不生效，本该 200 的自签 HTTPS 报 self-signed；
 *   · 本该由代理解析的域名去撞本地 DNS 污染，报 `ETIMEDOUT 69.171.235.22`。
 *
 * 正确做法：把隧道 + TLS 逻辑放进**自定义 Agent 的 createConnection**，
 * 再把 agent 实例传进请求选项。
 */
function makeAgent(isHttps, { proxy, ca, insecure, timeout }) {
  const build = (opts, cb) => {
    let done = false;
    const finish = (err, sock) => {
      if (done) return;
      done = true;
      cb(err, sock);
    };
    connectThrough({ host: opts.host, port: opts.port, proxy, timeout })
      .then((sock) => {
        if (!isHttps) {
          finish(null, sock);
          return;
        }
        const t = { socket: sock, timeout };
        // IP 字面量不合法做 SNI，Node 只警告不报错；带 host 是为了域名场景
        if (!net.isIP(opts.host)) t.servername = opts.host;
        if (ca) t.ca = ca;
        if (insecure) t.rejectUnauthorized = false;
        const s = tls.connect(t, () => finish(null, s));
        s.once('error', (e) => finish(e));
      })
      .catch((e) => finish(e));
  };

  return isHttps
    ? new (class extends https.Agent { createConnection(o, cb) { build(o, cb); } })({ keepAlive: false })
    : new (class extends http.Agent { createConnection(o, cb) { build(o, cb); } })({ keepAlive: false });
}

/**
 * 发一个 HTTP(S) 请求。`insecure` 只用于号池的 IP 自签证书那一跳。
 * 返回 { status, headers, body }（body 为字符串）。
 */
function request({ url, method = 'GET', headers = {}, body = null, proxy = null,
  timeout = 20000, ca = null, insecure = false }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port || (isHttps ? 443 : 80));

    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    const req = (isHttps ? https : http).request({
      host: u.hostname,
      port,
      path: u.pathname + u.search,
      method,
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...headers },
      agent: makeAgent(isHttps, { proxy, ca, insecure, timeout }),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        settled = true;
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.setTimeout(timeout, () => req.destroy(new Error('request timeout')));
    req.once('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 探测原语
// ---------------------------------------------------------------------------
async function tcpProbe(host, port, proxy, timeout = 10000) {
  const t0 = Date.now();
  const sock = await connectThrough({ host, port, proxy, timeout });
  sock.destroy();
  return Date.now() - t0;
}

async function tlsPeer(host, proxy, ca = null) {
  const sock = await connectThrough({ host, port: 443, proxy });
  const s = await upgradeTls(sock, host, ca, false);
  const cert = s.getPeerCertificate();
  s.destroy();
  return { subject: (cert.subject || {}).CN || '?', validTo: cert.valid_to };
}

const PRIVATE_RE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** 污染/内网地址识别。GFW 污染 TikTok 域名时会回 2001::1 这类假地址。 */
function badIp(ip) {
  if (ip.startsWith('2001:') || ip === '::1' || ip === '0.0.0.0') return true;
  return PRIVATE_RE.test(ip);
}

async function resolveAll(host) {
  const list = await dns.promises.lookup(host, { all: true });
  return [...new Set(list.map((r) => r.address))].sort();
}

// ---------------------------------------------------------------------------
// A. 机器体检
// ---------------------------------------------------------------------------
async function partA(proxy) {
  head('A. 机器体检 —— 这台机器是不是干活的材料');

  const major = Number(process.versions.node.split('.')[0]);
  rec('Node >= 18（需要全局 fetch）', major >= 18,
    `Node ${process.versions.node} · ${os.platform()} ${os.release()} · ${os.arch()}`);

  try {
    const r = await request({ url: 'http://ip-api.com/json/?fields=status,country,regionName,city,isp,as,query', proxy, insecure: true });
    const info = JSON.parse(r.body);
    if (info.status === 'success') {
      rec('出网公网 IP 落地国家', true,
        `IP=${info.query}  ${info.country} / ${info.city} / ${String(info.as || '').slice(0, 26)}`);
      const isUS = /united states/i.test(info.country || '');
      rec('落地在美国（节点选型预期）', isUS,
        isUS ? '符合预期' : `${info.country}（不影响功能，但 TikTok 上游时延会变）`,
        false);
    } else {
      rec('出网公网 IP 落地国家', false, r.body.slice(0, 70), false);
    }
  } catch (err) {
    rec('出网公网 IP 落地国家', false, err.message.slice(0, 80), false);
  }

  // 时钟：cookie 3 天过期靠绝对时间，漂移会静默搞坏签名与轮询
  try {
    const r = await request({ url: `https://${TIKTOK_HOST}${HISTORY_PATH}?aid=585599`, method: 'POST',
      body: '{}', headers: { 'Content-Type': 'application/json', Referer: REFERER, Origin: `https://${TIKTOK_HOST}` },
      proxy, timeout: 20000 });
    const d = r.headers.date;
    if (d) {
      const skew = (Date.now() - Date.parse(d)) / 1000;
      rec('时钟偏移 < 120s', Math.abs(skew) < 120, `偏移 ${skew.toFixed(1)} 秒`);
    } else {
      rec('时钟偏移 < 120s', false, '上游未返回 Date 头', false);
    }
  } catch (err) {
    rec('时钟偏移 < 120s', false, err.message.slice(0, 80), false);
  }

  const totalMem = (os.totalmem() / 1073741824).toFixed(1);
  rec('规格满足最低要求（1 核 1G 起）', os.cpus().length >= 1,
    `${os.cpus().length} 核 / 内存 ${totalMem} GB / ${os.hostname()}`);
}

// ---------------------------------------------------------------------------
// B. 节点 -> 号池
// ---------------------------------------------------------------------------
async function partB(pool, proxy, token, caFile) {
  head('B. 节点 → 号池 —— 拉活通道（claim / heartbeat / result）');

  const host = pool.split(':')[0];
  const port = Number(pool.split(':')[1] || 443);

  try {
    const ms = await tcpProbe(host, port, proxy);
    rec(`TCP 握手 ${host}:${port}`, true, `connect=${(ms / 1000).toFixed(3)}s${proxy ? '（经代理）' : ''}`);
  } catch (err) {
    rec(`TCP 握手 ${host}:${port}`, false, err.message.slice(0, 70));
    return;
  }
  try {
    await tcpProbe(host, 80, proxy);
    rec('TCP 握手 :80', true, 'ok');
  } catch (err) {
    rec('TCP 握手 :80', false, err.message.slice(0, 60), false);
  }

  const ca = caFile && fs.existsSync(caFile) ? fs.readFileSync(caFile) : null;

  // HTTP 80：只有不加密才过。用来确认「不校验也能通」的兜底路径存在。
  try {
    const r = await request({ url: `http://${pool}/api/v1/health`, proxy, timeout: 20000 });
    rec('HTTP  :80  /api/v1/health → 200', r.status === 200,
      `HTTP ${r.status} ${r.body.slice(0, 62)}`);
  } catch (err) {
    rec('HTTP  :80  /api/v1/health → 200', false, err.message.slice(0, 80), false);
  }

  // HTTPS 443：号池是 IP 自签证书，先验「不校验能通」，再报证书长什么样
  try {
    const r = await request({ url: `https://${pool}/api/v1/health`, proxy, insecure: true, timeout: 20000 });
    rec('HTTPS :443 /api/v1/health → 200（跳过校验）', r.status === 200,
      `HTTP ${r.status} ${r.body.slice(0, 56)}`);
  } catch (err) {
    rec('HTTPS :443 /api/v1/health → 200（跳过校验）', false, err.message.slice(0, 80));
  }

  try {
    const peer = await tlsPeer(host, proxy, ca || undefined);
    rec('TLS 证书可校验', true, `CN=${peer.subject} 有效期至 ${peer.validTo}${ca ? '（已用 CA 钉身份）' : ''}`);
  } catch (err) {
    rec('TLS 证书可校验', false,
      `${err.message.slice(0, 52)} —— 设 RH_POOL_CA_FILE 指向号池自签证书，或临时用 RH_POOL_INSECURE=1`, false);
  }

  if (!token) {
    rec('GET /api/v1/agent/stats（带令牌）→ 200', false, '未提供 --token，跳过', false);
    return;
  }
  try {
    const r = await request({ url: `https://${pool}/api/v1/agent/stats`, proxy, insecure: true,
      headers: { Authorization: 'Bearer ' + token }, timeout: 20000 });
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      rec('GET /api/v1/agent/stats（带令牌）→ 200', true,
        `后端=${JSON.stringify(d.backends)} 待接单=${d.pending_agent} 执行中=${d.agent_running}`);
    } else if (r.status === 401) {
      rec('GET /api/v1/agent/stats（带令牌）→ 200', false, '401 令牌无效（两侧 agent_token 必须一致）');
    } else if (r.status === 503) {
      rec('GET /api/v1/agent/stats（带令牌）→ 200', false,
        '503 —— 号池 config.json 的 agent_token 还是空串，通道整体关闭');
    } else {
      rec('GET /api/v1/agent/stats（带令牌）→ 200', false, `HTTP ${r.status} ${r.body.slice(0, 60)}`);
    }
  } catch (err) {
    rec('GET /api/v1/agent/stats（带令牌）→ 200', false, err.message.slice(0, 80));
  }
}

// ---------------------------------------------------------------------------
// C. 节点 -> TikTok 上游
// ---------------------------------------------------------------------------
async function partC(proxy) {
  head('C. 节点 → TikTok 上游 —— 真正的业务链路');

  // DNS：这一步是「国内机」与「海外机」的分水岭
  if (proxy) {
    rec(`解析 ${TIKTOK_HOST}（本机，仅供参考）`, true,
      '走代理时 DNS 由代理侧解析，本机结果不参与判定', false);
  } else {
    try {
      const ips = await resolveAll(TIKTOK_HOST);
      const polluted = ips.filter(badIp);
      rec(`解析 ${TIKTOK_HOST}`, polluted.length === 0,
        `→ ${ips.slice(0, 3).join(', ')}${polluted.length ? '  ⚠ 出现污染/内网地址' : ''}`);
      if (polluted.length) return;
    } catch (err) {
      rec(`解析 ${TIKTOK_HOST}`, false, err.message.slice(0, 80));
      return;
    }
  }

  try {
    const ms = await tcpProbe(TIKTOK_HOST, 443, proxy);
    rec(`TCP 443 → ${TIKTOK_HOST}`, true, `connect=${(ms / 1000).toFixed(3)}s${proxy ? '（经代理）' : ''}`);
  } catch (err) {
    rec(`TCP 443 → ${TIKTOK_HOST}`, false, err.message.slice(0, 80));
    return;
  }

  try {
    const peer = await tlsPeer(TIKTOK_HOST, proxy);
    rec('TLS 握手 + 证书校验', true, `CN=${peer.subject} 有效期至 ${peer.validTo}`);
  } catch (err) {
    rec('TLS 握手 + 证书校验', false, err.message.slice(0, 80));
  }

  // 业务探活：空体打 history，上游必然回业务错误码 —— 这恰好证明链路直达
  try {
    const r = await request({
      url: `https://${TIKTOK_HOST}${HISTORY_PATH}?aid=585599&app_name=creative_aio_client&device_platform=web`,
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json', Referer: REFERER, Origin: `https://${TIKTOK_HOST}` },
      proxy, timeout: 25000,
    });
    let detail;
    try {
      detail = `HTTP ${r.status} code=${JSON.parse(r.body).code}（缺参数回业务码＝链路通）`;
    } catch {
      detail = `HTTP ${r.status} ${r.body.slice(0, 60)}`;
    }
    rec(`POST ${HISTORY_PATH} 可直达`, r.status < 500, detail);
  } catch (err) {
    rec(`POST ${HISTORY_PATH} 可直达`, false, err.message.slice(0, 80));
  }

  // 上传代理：不带签名打它，期望 4xx JSON —— 证明路由存在而不是 404/超时
  try {
    const r = await request({
      url: `https://${TIKTOK_HOST}${UPLOAD_PROXY_PATH}?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=n2703mo9gi&FileSize=45431`,
      headers: { Referer: REFERER, Origin: `https://${TIKTOK_HOST}` },
      proxy, timeout: 25000,
    });
    rec('upload-proxy 路由存在', ![404, 502, 503].includes(r.status),
      `HTTP ${r.status} ${r.body.slice(0, 56)}`);
  } catch (err) {
    rec('upload-proxy 路由存在', false, err.message.slice(0, 80));
  }

  try {
    const ms = await tcpProbe(CDN_HOST, 443, proxy);
    rec(`CDN ${CDN_HOST} 可达`, true, `connect=${(ms / 1000).toFixed(3)}s`);
  } catch (err) {
    rec(`CDN ${CDN_HOST} 可达`, false, err.message.slice(0, 70), false);
  }
}

// ---------------------------------------------------------------------------
function summary() {
  head('汇总');
  const req = RESULTS.filter((r) => r.required);
  const bad = req.filter((r) => !r.ok);
  const warn = RESULTS.filter((r) => !r.required && !r.ok);
  console.log(`  必检 ${req.length} 项，通过 ${req.length - bad.length} 项，失败 ${bad.length} 项；` +
    `提示项 ${warn.length} 个；耗时 ${Math.round((Date.now() - START) / 1000)} 秒`);

  if (bad.length) {
    console.log('\n  未通过：');
    for (const r of bad) console.log(`    [FAIL] ${r.name}\n           ${r.detail}`);
  }
  console.log('');
  if (bad.length) {
    console.log('  结论：**这台机器还不能上** —— 先解决上面列出的必检项。');
  } else {
    console.log('  结论：**前置验收全部通过，可以开始部署执行节点。**');
  }
  console.log('');
  return bad.length ? 1 : 0;
}

function parseArgs(argv) {
  const out = { pool: process.env.RH_POOL_HOST || '39.96.66.94', proxy: process.env.PREFLIGHT_PROXY || '',
    token: process.env.RH_AGENT_TOKEN || '', ca: process.env.RH_POOL_CA_FILE || '', skipUpstream: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pool') out.pool = argv[++i] || out.pool;
    else if (a === '--proxy') out.proxy = argv[++i] || '';
    else if (a === '--token') out.token = argv[++i] || '';
    else if (a === '--ca') out.ca = argv[++i] || '';
    else if (a === '--skip-upstream') out.skipUpstream = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node preflight.js [--pool IP[:PORT]] [--token TOKEN] [--ca FILE] [--proxy URL] [--skip-upstream]');
      process.exit(0);
    }
  }
  if (['none', '-', ''].includes(String(out.proxy).toLowerCase())) out.proxy = '';
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log('='.repeat(86));
  console.log('海外执行节点 —— 上线前置验收');
  console.log(`  主机 ${os.hostname()} / Node ${process.versions.node} / ${os.platform()}`);
  console.log(`  时间 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  console.log(`  出网 ${args.proxy ? '代理 ' + args.proxy : '直连'}`);
  console.log(`  号池 ${args.pool}`);
  console.log('='.repeat(86));

  await partA(args.proxy);
  await partB(args.pool, args.proxy, args.token, args.ca);
  if (!args.skipUpstream) await partC(args.proxy);
  process.exit(summary());
}

main().catch((err) => {
  console.error('\n[preflight] 意外失败：', err && err.stack || err);
  process.exit(2);
});
