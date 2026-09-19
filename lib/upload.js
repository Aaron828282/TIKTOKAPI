'use strict';
/**
 * 参考图上传（五步）—— **全程不需要浏览器**。
 *
 * TikTok 的 R2V 只认自家 ibyteimg 图床上的素材：把外部地址塞进
 * `settings.images[].imageSrcSet.origin`，接口直接回 `illegal url`。
 * 所以任何外部参考图都必须先传上去。
 *
 * 五步（口径来自真实抓包，见 API.md §5.10）：
 *
 *   ① POST {origin}/creative_bff_i18n/api/cue/upload/token      取 STS 临时凭据（**无签名**）
 *   ② GET  {origin}/creative/creativestudio/upload-proxy
 *           ?Action=ApplyImageUpload…                            **AWS SigV4** → StoreUri/Auth/UploadHosts
 *   ③ POST https://{UploadHosts[0]}/upload/v1/{StoreUri}         真传字节（只带 Auth JWT + CRC32，**无签名**）
 *   ④ POST {origin}/creative/creativestudio/upload-proxy
 *           ?Action=CommitImageUpload…                           **AWS SigV4** + {"SessionKey":…}
 *   ⑤ 拼 CDN URL：{cdnHost}/{StoreUri}~tplv-{serviceId}-webp:1280:1280.image
 *
 * 三个容易踩的点
 * --------------
 * 1. ③ 的**成功码是 `2000`，不是 `200`** —— 与业务接口的 `code: 0` 又差一套口径。
 * 2. 签名用 STS 的 `CurrentTime` 而不是本机时间：STS 有效期只有 5 分钟，
 *    节点时钟漂一点就会让签名落在窗口外，而报错只会是含糊的签名失败。
 * 3. `UploadHosts` **每次可能不同**，必须用返回值，不能写死。
 */
const crypto = require('node:crypto');
const { sign, EMPTY_SHA256 } = require('./sigv4');
const { SOURCE_HEADER, randomState, queryOf } = require('./payload');

/** 参考图上传链路用到的 ServiceId（新加坡 region 的 veImageX 服务号）。 */
const STS_PATH = '/creative_bff_i18n/api/cue/upload/token';
const PROXY_PATH = '/creative/creativestudio/upload-proxy';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/** CRC32 十六进制小写 —— TOS 的 `Content-CRC32` 要求与实体内容一致。 */
function crc32hex(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0');
}

/** 业务请求的公共头（cookie / 来源头 —— 鉴权靠它们，不靠密钥）。 */
function baseHeaders(session, cfg) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    origin: cfg.origin,
    referer: cfg.referer,
    'user-agent': cfg.userAgent,
    'x-creative-source': SOURCE_HEADER,
    'x-csrftoken': session.x_csrftoken,
    cookie: session.cookie,
    'agw-js-conv': 'str',
  };
}

async function readJson(res) {
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text), text };
  } catch {
    return { status: res.status, json: null, text };
  }
}

/** ① 取 STS 临时凭据（有效期仅 5 分钟，过期要重取）。 */
async function getSts(session, cfg, log) {
  const url = `${cfg.origin}${STS_PATH}?${queryOf(session.device_id)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...baseHeaders(session, cfg), 'content-type': 'application/json' },
    body: '{}',
  });
  const { status, json, text } = await readJson(res);
  if (!json || json.code !== 0 || !json.data) {
    throw new Error(`取 STS 失败：HTTP ${status} code=${json && json.code} ${String(text).slice(0, 200)}`);
  }
  const d = json.data;
  for (const k of ['AccessKeyId', 'SecretAccessKey', 'SessionToken']) {
    if (!d[k]) throw new Error(`STS 响应缺少 ${k}`);
  }
  if (log) log(`    STS 有效期至 ${d.ExpiredTime}`);
  return d;
}

/** ② ApplyImageUpload —— 取 StoreUri / Auth / UploadHosts。 */
async function applyUpload(session, cfg, sts, fileSize, log) {
  const query = new URLSearchParams({
    Action: 'ApplyImageUpload',
    Version: '2018-08-01',
    ServiceId: cfg.serviceId,
    FileSize: String(fileSize),
    s: randomState(),
    device_platform: 'web',
  }).toString();

  const url = `${cfg.origin}${PROXY_PATH}?${query}`;
  const signed = sign({
    method: 'GET',
    url,
    headers: { host: new URL(url).host },
    payload: Buffer.alloc(0),
    accessKey: sts.AccessKeyId,
    secretKey: sts.SecretAccessKey,
    sessionToken: sts.SessionToken,
    // ⚠️ 用 STS 自己的时间，不用本机时钟（见文件头第 2 点）
    when: sts.CurrentTime ? new Date(sts.CurrentTime) : undefined,
    signContentSha256: false,
  });

  const res = await fetch(url, { method: 'GET', headers: { ...baseHeaders(session, cfg), ...signed } });
  const { status, json, text } = await readJson(res);
  const result = json && json.Result;
  const addr = result && result.UploadAddress;
  if (!addr || !addr.StoreInfos || !addr.StoreInfos.length) {
    throw new Error(`ApplyImageUpload 失败：HTTP ${status} ${String(text).slice(0, 300)}`);
  }
  const store = addr.StoreInfos[0];
  const host = (addr.UploadHosts || [])[0];
  if (!host) throw new Error('ApplyImageUpload 未返回 UploadHosts');
  if (log) log(`    StoreUri=${store.StoreUri.slice(0, 46)}…  UploadHost=${host}`);
  return { storeUri: store.StoreUri, auth: store.Auth, uploadHost: host, sessionKey: result.SessionKey };
}

/** ③ 真传字节到 TOS —— 只带 Auth JWT + CRC32，**无签名**。 */
async function putBytes(cfg, up, data, log) {
  const url = `https://${up.uploadHost}/upload/v1/${up.storeUri}`;
  const crc = crc32hex(data);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: up.auth,
      'Content-CRC32': crc,
      'X-Storage-U': 'ad_creative_tools_unknown_user',
      'Content-Type': 'application/octet-stream',
      // 前端拼串的 bug，照抄即可（服务端不校验）
      'Content-Disposition': 'attachment; filename="undefined"',
    },
    body: data,
  });
  const { status, json, text } = await readJson(res);
  // ⚠️ 成功码是 2000，不是 200
  if (!json || json.code !== 2000) {
    throw new Error(`TOS 上传失败：HTTP ${status} code=${json && json.code} ${String(text).slice(0, 200)}`);
  }
  if (log) log(`    已传 ${data.length} 字节（crc32=${crc}）`);
  return json;
}

/** ④ CommitImageUpload —— 让平台登记这条素材。 */
async function commitUpload(session, cfg, sts, sessionKey, log) {
  const query = new URLSearchParams({
    Action: 'CommitImageUpload',
    Version: '2018-08-01',
    ServiceId: cfg.serviceId,
  }).toString();
  const url = `${cfg.origin}${PROXY_PATH}?${query}`;
  const payload = Buffer.from(JSON.stringify({ SessionKey: sessionKey }), 'utf8');

  const signed = sign({
    method: 'POST',
    url,
    headers: { host: new URL(url).host },
    payload,
    contentSha256: crypto.createHash('sha256').update(payload).digest('hex'),
    accessKey: sts.AccessKeyId,
    secretKey: sts.SecretAccessKey,
    sessionToken: sts.SessionToken,
    when: sts.CurrentTime ? new Date(sts.CurrentTime) : undefined,
    // 这一条真实抓包里确实带了 X-Amz-Content-Sha256，所以照发照签
    signContentSha256: true,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...baseHeaders(session, cfg),
      'content-type': 'application/json',
      ...signed,
    },
    body: payload,
  });
  const { status, json, text } = await readJson(res);
  if (!json || !json.Result) {
    throw new Error(`CommitImageUpload 失败：HTTP ${status} ${String(text).slice(0, 300)}`);
  }
  const uri = ((json.Result.Results || [])[0] || {}).Uri || '';
  const meta = ((json.Result.PluginResult || [])[0] || {});
  if (log) log(`    已登记 ${meta.ImageWidth}×${meta.ImageHeight} ${meta.ImageFormat} ${meta.ImageSize}B`);
  return { uri, meta, raw: json };
}

/** ⑤ 拼成品图 URL —— **唯一需要记住的拼法**。 */
function cdnUrl(cfg, storeUri) {
  return `${cfg.cdnHost}/${storeUri}~tplv-${cfg.serviceId}-webp:1280:1280.image`;
}

/** 已经在 TikTok 自家图床上的地址不必重传（省一次往返，也避免二次压缩）。 */
function isNative(url, cfg) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return cfg.nativeHosts.some((h) => {
      const bare = h.replace(/^\./, '');
      return host === bare || host.endsWith(h.startsWith('.') ? h : `.${h}`);
    });
  } catch {
    return false;
  }
}

/**
 * 把一张公网图片传进 TikTok 图床，返回可用的 CDN URL。
 *
 * 已经是自家图床的直接原样返回 —— 这条捷径很重要：它让「复用一张已上传的图」
 * 不必重复消耗一次上传配额。
 */
async function uploadImage(session, cfg, imageUrl, log) {
  if (isNative(imageUrl, cfg)) {
    if (log) log('    已在 TikTok 图床，直接用');
    return imageUrl;
  }

  const res = await fetch(imageUrl, {
    headers: {
      'user-agent': cfg.userAgent,
      accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`参考图下载失败：HTTP ${res.status} ${imageUrl.slice(0, 90)}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.length) throw new Error(`参考图内容为空：${imageUrl.slice(0, 90)}`);
  if (log) log(`    下载 ${data.length} 字节`);

  const sts = await getSts(session, cfg, log);
  const up = await applyUpload(session, cfg, sts, data.length, log);
  await putBytes(cfg, up, data, log);
  await commitUpload(session, cfg, sts, up.sessionKey, log);
  const out = cdnUrl(cfg, up.storeUri);
  if (log) log(`    → ${out.slice(0, 100)}`);
  return out;
}

module.exports = {
  STS_PATH,
  PROXY_PATH,
  crc32hex,
  baseHeaders,
  getSts,
  applyUpload,
  putBytes,
  commitUpload,
  cdnUrl,
  isNative,
  uploadImage,
  EMPTY_SHA256,
};
