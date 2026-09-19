'use strict';
/**
 * SigV4 签名器（火山引擎兼容）—— **零第三方依赖**，只用 node:crypto。
 *
 * 为什么手写而不是装 aws-sdk
 * --------------------------
 * 火山引擎 ImageX 的 OpenAPI 用的是 AWS SigV4 **兼容格式**，签名 scope 是
 * `region=i18n` / `service=imagex`（口径来自真实抓包的 Authorization 头）。
 * 目标执行节点是一台干净的托管小机器，不值得为一个确定性算法拖进
 * aws-sdk 那一坨依赖。
 *
 * 正确性如何保证
 * --------------
 * 算法是确定性的，所以可以用 **AWS 官方文档的已知测试向量**离线自证，
 * 不需要任何真实凭据、不产生任何网络请求：
 *
 *     node lib/sigv4.js
 *
 * 期望 `7/7 通过`。这条自证在拿到新鲜 cookie 之前就能跑，把「签名对不对」
 * 从「上服务器碰运气」变成「本机秒验」。
 *
 * ⚠️ 本文件是 `reference/sigv4.py` 的逐行移植。改动任意一侧都必须让另一侧
 *    的自证仍然全绿 —— 两边的用例是同一组，就是为此准备的。
 */
const crypto = require('node:crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const TERMINATOR = 'aws4_request';

/** RFC 3986 unreserved：A-Z a-z 0-9 - _ . ~ 之外一律百分号编码 */
const UNRESERVED = '-_.~';

/** 空载荷的 sha256 —— GET 也用这个，写错成 "" 是最常见的坑 */
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

/** RFC 3986 编码，十六进制大写（SigV4 要求大写）。 */
function uriEncode(value, encodeSlash = true) {
  let out = encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (!encodeSlash) out = out.replace(/%2F/g, '/');
  return out;
}

function sha256Hex(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 手写 URL 拆分，**刻意不用 new URL()** —— 后者会重排/重新编码查询串，
 * 而签名要求「先编码、再按编码后的字节序排序」，归一化必须由我们自己控制。
 */
function splitUrl(url) {
  const s = String(url);
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(s);
  if (!m) throw new Error('无法解析 URL: ' + s);
  return { scheme: m[1], netloc: m[2], path: m[3] || '', query: m[4] || '' };
}

const decodeQueryPart = (s) => decodeURIComponent(String(s).replace(/\+/g, ' '));

/** 解析查询串，保留空值参数（等价 Python 的 parse_qsl(keep_blank_values=True)）。 */
function parseQuery(query) {
  if (!query) return [];
  return query.split('&').filter((p) => p !== '').map((pair) => {
    const i = pair.indexOf('=');
    return i === -1
      ? [decodeQueryPart(pair), '']
      : [decodeQueryPart(pair.slice(0, i)), decodeQueryPart(pair.slice(i + 1))];
  });
}

/**
 * 查询串归一化：先编码，再按**编码后的键**做字节序升序。
 *
 * ⚠️ 排序必须在编码之后进行 —— 大写字母（`A`=65）排在小写（`s`=115）之前，
 * 所以 `Action, FileSize, ServiceId, Version, device_platform, s`
 * 才是正确顺序。按原始串排序会得到不同结果、签名必然错。
 */
function canonicalQueryString(url) {
  const pairs = parseQuery(splitUrl(url).query);
  if (!pairs.length) return '';
  const encoded = pairs.map(([k, v]) => [uriEncode(k), uriEncode(v)]);
  encoded.sort(comparePairs);
  return encoded.map(([k, v]) => `${k}=${v}`).join('&');
}

function comparePairs(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

/** 键小写、值折叠连续空白并去首尾（SigV4 对值的规范化要求）。 */
function normalizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[String(k).toLowerCase().trim()] = String(v).split(/\s+/).filter(Boolean).join(' ');
  }
  return out;
}

const VOLATILE_HEADERS = ['authorization', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256'];

/**
 * 返回 { canonical, signedHeaders }。
 *
 * 拼接后的形状（注意查询串为空时那一行是空的，且头块末尾会多出一个空行）：
 *
 *     GET
 *     /
 *
 *     content-type:...
 *     host:iam.amazonaws.com
 *     x-amz-date:20150830T123600Z
 *
 *     content-type;host;x-amz-date
 *     e3b0c442...
 */
function buildCanonicalRequest(method, url, headers, payloadSha) {
  const parsed = splitUrl(url);
  const body = Object.assign({}, headers);
  if (!Object.keys(body).some((k) => k.toLowerCase() === 'host')) body.host = parsed.netloc;

  const lower = normalizeHeaders(body);
  const keys = Object.keys(lower).sort();
  const signedHeaders = keys.join(';');
  const canonHeaders = keys.map((k) => `${k}:${lower[k]}\n`).join('');

  const canonical = [
    String(method).toUpperCase(),
    uriEncode(parsed.path || '/', false),
    canonicalQueryString(url),
    canonHeaders,
    signedHeaders,
    payloadSha,
  ].join('\n');

  return { canonical, signedHeaders };
}

/** AWS4 + secret → HMAC 链 → 派生签名密钥（4 轮）。 */
function deriveSigningKey(secretKey, dateStamp, region, service) {
  let key = Buffer.from('AWS4' + secretKey, 'utf8');
  for (const msg of [dateStamp, region, service, TERMINATOR]) {
    key = crypto.createHmac('sha256', key).update(Buffer.from(msg, 'utf8')).digest();
  }
  return key;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** ISO8601 的 `YYYYMMDDTHHMMSSZ`（必须是 UTC）。 */
function amzDateOf(date) {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
}

/**
 * 对一次请求签名，返回**需要补进请求头**的字段（标准 HTTP 大小写形式）。
 *
 * `when` 必须是 UTC 的 Date。默认取当前时间；但对接 TikTok 时应当显式传入
 * STS 的 `CurrentTime` —— 节点机器时钟漂一点就会让签名落在 STS 有效窗口外，
 * 而报错只会是含糊的签名失败。
 *
 * `signContentSha256` —— 是否附带并签名 `X-Amz-Content-Sha256`。
 * ⚠️ AWS 规范规定**所有 `x-amz-*` 头都必须进签名**，所以「发不发」和
 * 「签不签」是同一个开关，不存在「发了但不签」这个中间态。
 *   - false（默认）：完全不发这个头。SigV4 的最小正确形态，AWS 官方示例的形态。
 *   - true：附带并签名。TikTok 的真实抓包里这个头**是存在的**，
 *     所以对接 TikTok 的 CommitImageUpload 要传 true。
 * `sessionToken` 一旦提供就必然附带并签名 —— STS 凭据缺它必被拒。
 */
function sign(opts) {
  const {
    method,
    url,
    accessKey,
    secretKey,
    headers = {},
    payload = Buffer.alloc(0),
    sessionToken = null,
    region = 'i18n',
    service = 'imagex',
    when = null,
    contentSha256 = null,
    signContentSha256 = false,
  } = opts || {};

  const date = when ? new Date(when) : new Date();
  const amzDate = amzDateOf(date);
  const dateStamp = amzDate.slice(0, 8);

  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const payloadSha = contentSha256 || sha256Hex(payloadBuf);

  const hdrs = {};
  for (const [k, v] of Object.entries(headers || {})) hdrs[String(k)] = String(v);
  for (const k of Object.keys(hdrs)) {
    if (VOLATILE_HEADERS.includes(k.toLowerCase())) delete hdrs[k];
  }
  if (!Object.keys(hdrs).some((k) => k.toLowerCase() === 'host')) hdrs.host = splitUrl(url).netloc;
  hdrs['X-Amz-Date'] = amzDate;
  if (signContentSha256) hdrs['X-Amz-Content-Sha256'] = payloadSha;
  if (sessionToken) hdrs['X-Amz-Security-Token'] = sessionToken;

  const { canonical, signedHeaders } = buildCanonicalRequest(method, url, hdrs, payloadSha);

  const scope = `${dateStamp}/${region}/${service}/${TERMINATOR}`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join('\n');

  const signingKey = deriveSigningKey(secretKey, dateStamp, region, service);
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(Buffer.from(stringToSign, 'utf8'))
    .digest('hex');

  const out = {
    Authorization: `${ALGORITHM} Credential=${accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'X-Amz-Date': amzDate,
  };
  if (signContentSha256) out['X-Amz-Content-Sha256'] = payloadSha;
  if (sessionToken) out['X-Amz-Security-Token'] = sessionToken;
  return out;
}

// ---------------------------------------------------------------------------
// 自证：AWS 官方文档的已知测试向量
//
// 来源：AWS 文档 "Examples of the complete Version 4 signing process" 里的
// ListUsers 示例。凭据与签名都是公开的示例值，不是真实密钥。
//
// 之所以能拿它当脚手架：火山引擎是 SigV4 *兼容* 实现，签名算法本身完全相同，
// 只有 scope 里的 region/service 两个字符串不同。所以只要这组向量过了，
// 就能确定 canonical request / 密钥派生 / 签名三处都没有写错。
// ---------------------------------------------------------------------------
const AWS_KEY_ID = 'AKIDEXAMPLE';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const AWS_WHEN = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));

function caseListUsers() {
  const out = sign({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      host: 'iam.amazonaws.com',
    },
    payload: Buffer.alloc(0),
    accessKey: AWS_KEY_ID,
    secretKey: AWS_SECRET,
    region: 'us-east-1',
    service: 'iam',
    when: AWS_WHEN,
  });
  const expect = 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
    'SignedHeaders=content-type;host;x-amz-date, ' +
    'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7';
  return [out.Authorization === expect, out.Authorization, expect];
}

function caseEmptyPayloadHash() {
  const expect = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  return [EMPTY_SHA256 === expect, EMPTY_SHA256, expect];
}

function caseQuerySorting() {
  const url = 'https://x/?s=zzz&device_platform=web&Version=2018-08-01' +
    '&ServiceId=n2703mo9gi&FileSize=45431&Action=ApplyImageUpload';
  const got = canonicalQueryString(url);
  const expect = 'Action=ApplyImageUpload&FileSize=45431&ServiceId=n2703mo9gi' +
    '&Version=2018-08-01&device_platform=web&s=zzz';
  return [got === expect, got, expect];
}

function caseTiktokUrlShape() {
  const url = 'https://ads.tiktok.com/creative/creativestudio/upload-proxy' +
    '?Action=ApplyImageUpload&Version=2018-08-01' +
    '&ServiceId=n2703mo9gi&FileSize=45431&s=m0kza0mqao&device_platform=web';
  const got = canonicalQueryString(url);
  const expect = 'Action=ApplyImageUpload&FileSize=45431&ServiceId=n2703mo9gi' +
    '&Version=2018-08-01&device_platform=web&s=m0kza0mqao';
  return [got === expect, got, expect];
}

function caseSigningKeyVector() {
  const key = deriveSigningKey(
    'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam');
  const expect = 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d';
  return [key.toString('hex') === expect, key.toString('hex'), expect];
}

function caseContentSha256Override() {
  const url = 'https://ads.tiktok.com/creative/creativestudio/upload-proxy?Action=CommitImageUpload';
  const payload = Buffer.from('{"SessionKey":"abc"}', 'utf8');
  const forced = sha256Hex(payload);
  const out = sign({
    method: 'POST', url, payload, contentSha256: forced, signContentSha256: true,
    accessKey: AWS_KEY_ID, secretKey: AWS_SECRET, when: AWS_WHEN,
  });
  const ok = out['X-Amz-Content-Sha256'] === forced && forced !== EMPTY_SHA256;
  return [ok, out['X-Amz-Content-Sha256'], forced];
}

function caseAmzHeadersMustBeSigned() {
  const url = 'https://ads.tiktok.com/creative/creativestudio/upload-proxy?Action=ApplyImageUpload';
  const signedOf = (h) => h.Authorization.split('SignedHeaders=')[1].split(',')[0];
  const both = sign({
    method: 'GET', url, payload: Buffer.alloc(0), signContentSha256: true,
    sessionToken: 'STS2example', accessKey: AWS_KEY_ID, secretKey: AWS_SECRET, when: AWS_WHEN,
  });
  const minimal = sign({
    method: 'GET', url, payload: Buffer.alloc(0),
    accessKey: AWS_KEY_ID, secretKey: AWS_SECRET, when: AWS_WHEN,
  });
  const got = `${signedOf(both)} || ${signedOf(minimal)}`;
  const expect = 'host;x-amz-content-sha256;x-amz-date;x-amz-security-token || host;x-amz-date';
  return [got === expect, got, expect];
}

const CASES = [
  ['AWS 官方 ListUsers 向量', caseListUsers],
  ['空载荷 sha256 常量', caseEmptyPayloadHash],
  ['查询串编码后排序', caseQuerySorting],
  ['TikTok 代理 URL 规范化', caseTiktokUrlShape],
  ['签名密钥派生链', caseSigningKeyVector],
  ['显式 content_sha256 优先', caseContentSha256Override],
  ['x-amz-* 头必须进签名', caseAmzHeadersMustBeSigned],
];

function selftest() {
  console.log('='.repeat(78));
  console.log('SigV4 自证（AWS 官方向量 + 本地不变式）');
  console.log('='.repeat(78));
  let passed = 0;
  for (const [name, fn] of CASES) {
    let ok = false, got = '', expect = '';
    try {
      [ok, got, expect] = fn();
    } catch (err) {
      console.log(`  [ERR] ${name.padEnd(26)} 抛异常: ${err.message}`);
      continue;
    }
    console.log(`  [${ok ? 'OK ' : '!! '}] ${name}`);
    if (!ok) {
      console.log(`        实际: ${got}`);
      console.log(`        期望: ${expect}`);
    }
    if (ok) passed += 1;
  }
  console.log('-'.repeat(78));
  console.log(`  ${passed}/${CASES.length} 通过`);
  return passed === CASES.length ? 0 : 1;
}

module.exports = {
  ALGORITHM,
  TERMINATOR,
  EMPTY_SHA256,
  uriEncode,
  sha256Hex,
  splitUrl,
  canonicalQueryString,
  buildCanonicalRequest,
  deriveSigningKey,
  sign,
  selftest,
};

if (require.main === module) process.exit(selftest());
