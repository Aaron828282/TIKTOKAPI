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

/**
 * 取本次请求要用的 fetch。
 *
 * 默认全局 `fetch`（节点在墙外直连）。留出 `opts.fetchImpl` 是为了**墙内开发机
 * 能经代理跑同一条链路**——与 `lib/tiktok.js` 的只读采集同一个理由：验的是
 * 同一段代码，而不是另写一份「差不多的」实现。
 */
function pickFetch(opts) {
  return (opts && opts.fetchImpl) || fetch;
}

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
async function getSts(session, cfg, log, opts) {
  const url = `${cfg.origin}${STS_PATH}?${queryOf(session.device_id)}`;
  const res = await pickFetch(opts)(url, {
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

/** ② ApplyImageUpload / ApplyVideoUpload —— 取 StoreUri / Auth / UploadHosts。 */
async function applyUpload(session, cfg, sts, fileSize, log, opts = {}) {
  const query = new URLSearchParams({
    Action: opts.action || 'ApplyImageUpload',
    Version: '2018-08-01',
    ServiceId: opts.serviceId || cfg.serviceId,
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

  const res = await pickFetch(opts)(url, { method: 'GET', headers: { ...baseHeaders(session, cfg), ...signed } });
  const { status, json, text } = await readJson(res);
  const result = json && json.Result;
  const addr = result && result.UploadAddress;
  if (!addr || !addr.StoreInfos || !addr.StoreInfos.length) {
    throw new Error(`ApplyImageUpload 失败：HTTP ${status} ${String(text).slice(0, 300)}`);
  }
  const store = addr.StoreInfos[0];
  // ⚠️ 两个来源都要试：`UploadHosts[0]` 有时是字符串、有时是 `{UploadHost}`
  //    对象（2026-09-18 抓包确认过两种形态都出现过）。写死取字符串会在
  //    对象形态下把 host 变成 `[object Object]`，请求直接打不出去。
  const host = pickUploadHost(addr, store);
  if (!host) throw new Error('ApplyImageUpload 未返回 UploadHosts: ' + String(text).slice(0, 200));
  if (log) log(`    StoreUri=${store.StoreUri.slice(0, 46)}…  UploadHost=${host}`);
  return {
    storeUri: store.StoreUri, auth: store.Auth, uploadHost: host,
    // 🔴 SessionKey 在 **UploadAddress** 里，不在 Result 顶层。
    //    取错位置会静默拿到 `undefined` —— `JSON.stringify({SessionKey: undefined})`
    //    序列化成 `{}`，服务端收不到会话，commit 回一个含糊的
    //    `604033 Upload internal error`（看着像平台故障，其实是自己没带参数）。
    //    2026-09-20 实测：本机与海外节点都稳定复现，改这里即好。
    sessionKey: addr.SessionKey || result.SessionKey || '',
    raw: json,
  };
}

/** 从 Apply 响应里挑上传主机（StoreInfos[0].UploadHost → UploadHosts[0]）。 */
function pickUploadHost(addr, storeInfo) {
  const cands = [];
  if (storeInfo && storeInfo.UploadHost) cands.push(storeInfo.UploadHost);
  const hosts = (addr && addr.UploadHosts) || [];
  if (hosts.length) {
    const h0 = hosts[0];
    cands.push(typeof h0 === 'string' ? h0 : (h0 && (h0.UploadHost || h0.Host)));
  }
  const inner = (addr && addr.InnerUploadAddress && addr.InnerUploadAddress.UploadNodes) || [];
  if (inner.length) cands.push(inner[0] && inner[0].UploadHost);
  return cands.find((c) => typeof c === 'string' && c) || '';
}

/** ③ 真传字节到 TOS —— 只带 Auth JWT + CRC32，**无签名**。 */
async function putBytes(cfg, up, data, log, opts) {
  const url = `https://${up.uploadHost}/upload/v1/${up.storeUri}`;
  const crc = crc32hex(data);
  const res = await pickFetch(opts)(url, {
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

/** ④ CommitImageUpload / CommitVideoUpload —— 让平台登记这条素材。 */
async function commitUpload(session, cfg, sts, sessionKey, log, opts = {}) {
  const query = new URLSearchParams({
    Action: opts.action || 'CommitImageUpload',
    Version: '2018-08-01',
    ServiceId: opts.serviceId || cfg.serviceId,
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

  const res = await pickFetch(opts)(url, {
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
async function uploadImage(session, cfg, imageUrl, log, opts) {
  if (isNative(imageUrl, cfg)) {
    if (log) log('    已在 TikTok 图床，直接用');
    return imageUrl;
  }

  const res = await pickFetch(opts)(imageUrl, {
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

  const sts = await getSts(session, cfg, log, opts);
  const up = await applyUpload(session, cfg, sts, data.length, log, opts);
  await putBytes(cfg, up, data, log, opts);
  await commitUpload(session, cfg, sts, up.sessionKey, log, opts);
  const out = cdnUrl(cfg, up.storeUri);
  if (log) log(`    → ${out.slice(0, 100)}`);
  return out;
}

/**
 * 把一条公网视频传进 TikTok 视频库（VOD），返回视频参考条目所需的
 * `{ vid, previewUrl, postUrl? }`（2026-09-23，网站打码链路）。
 *
 * 协议（从 Creative Studio 前端 SDK 抓包还原，与图片五步链同构但走 **VOD**）：
 * - Apply：`Action=ApplyUploadInner, Version=2020-11-19, SpaceName=<视频空间>,
 *   FileType=video, IsInner=1, FileSize, device_platform=web`，签名服务名 **vod**，
 *   发到独立网关 `cfg.videoHost`（不是 upload-proxy —— imagex 网关没有该操作）
 * - 字节上传与图片同款（TOS，Auth JWT + CRC32）
 * - Commit：`Action=CommitUploadInner, Version=2020-11-19, SpaceName`，
 *   body `{SessionKey, Functions:[]}`
 * - Commit 响应取 `Vid`（v0d…/v10033… 形态）与播放地址，按多候选路径兜
 *
 * 🔴 `RH_VIDEO_HOST` / `RH_VIDEO_SPACE` 必须由真实抓包填入（ApplyUploadInner
 *    的请求 URL 与 SpaceName 只有 UI 运行时才知道）。没配就明确报错。
 *
 * ⚠️ 上传/提交**不创建生成订单**，可以放心试错；只有 gen_r2v_video 才计费。
 */
async function uploadVideo(session, cfg, videoUrl, log, opts) {
  if (!cfg.videoHost || !cfg.videoSpace) {
    throw new Error('参考视频上传未配置：缺 RH_VIDEO_HOST / RH_VIDEO_SPACE'
      + '（需要一份「UI 上传参考视频」的抓包来填 ApplyUploadInner 的网关与空间名）');
  }
  const res = await pickFetch(opts)(videoUrl, {
    headers: { 'user-agent': cfg.userAgent, accept: 'video/mp4,video/*;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`参考视频下载失败：HTTP ${res.status} ${videoUrl.slice(0, 90)}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.length) throw new Error(`参考视频内容为空：${videoUrl.slice(0, 90)}`);
  if (data.length > 200 * 1024 * 1024) throw new Error(`参考视频超过 200MB 上限：${data.length} 字节`);
  if (log) log(`    下载视频 ${data.length} 字节`);

  const sts = await getSts(session, cfg, log, opts);

  // ApplyUploadInner（vod 网关）
  const applyQuery = new URLSearchParams({
    Action: 'ApplyUploadInner', Version: '2020-11-19',
    SpaceName: cfg.videoSpace, FileType: 'video', IsInner: '1',
    FileSize: String(data.length), device_platform: 'web', s: randomState(),
  }).toString();
  const applyUrl = `${cfg.videoHost}?${applyQuery}`;
  const applySigned = sign({
    method: 'GET', url: applyUrl, headers: { host: new URL(applyUrl).host },
    payload: Buffer.alloc(0),
    // 🔴 2026-09-23 实测：upload-proxy 网关按 Credential 里的服务名路由
    //    （`i18n/vod/aws4_request` → vod 后端）。漏传 service 会签成默认的
    //    imagex，网关把请求递给 imagex，回 404 InvalidActionOrVersion
    //    （响应里 Service:"imagex" 就是证据）。Apply/Commit 都必须是 vod。
    region: 'i18n', service: 'vod',
    accessKey: sts.AccessKeyId, secretKey: sts.SecretAccessKey,
    sessionToken: sts.SessionToken,
    when: sts.CurrentTime ? new Date(sts.CurrentTime) : undefined,
    signContentSha256: false,
  });
  const applyRes = await pickFetch(opts)(applyUrl, {
    method: 'GET', headers: { ...baseHeaders(session, cfg), ...applySigned },
  });
  const { status, json, text } = await readJson(applyRes);
  const result = json && (json.Result || json.result);
  // 🔴 2026-09-23 真实抓包：Inner 形态 Result.UploadAddress=null，
  //    StoreUri/Auth/UploadID/SessionKey/Vid/UploadHost 全在
  //    Result.InnerUploadAddress.UploadNodes[0]（可能有多个候选节点）。
  //    顶层 UploadAddress 形态保留兼容（万一上游切回旧结构）。
  const innerNode = result && result.InnerUploadAddress
    && Array.isArray(result.InnerUploadAddress.UploadNodes)
    && result.InnerUploadAddress.UploadNodes[0];
  const addr = result && (result.UploadAddress || result.upload_address);
  const storeInfo = innerNode
    ? (innerNode.StoreInfos && innerNode.StoreInfos[0])
    : (addr && ((addr.StoreInfos && addr.StoreInfos[0]) || (addr.store_infos && addr.store_infos[0])));
  if (!storeInfo || !storeInfo.StoreUri) {
    throw new Error(`ApplyUploadInner 失败：HTTP ${status} ${String(text).slice(0, 300)}`);
  }
  const sessionKey = (innerNode && innerNode.SessionKey)
    || (addr && addr.SessionKey) || addr && addr.session_key
    || (result && result.SessionKey) || '';
  // Apply 响应直接就带 Vid（2026-09-23 抓包）—— commit 若拿不到就用它兜底
  const vidFromApply = (innerNode && innerNode.Vid) || '';
  const up = {
    storeUri: storeInfo.StoreUri,
    auth: storeInfo.Auth || storeInfo.auth || '',
    uploadHost: (innerNode && innerNode.UploadHost) || pickUploadHost(addr, storeInfo) || '',
    sessionKey,
    raw: json,
  };
  if (!up.uploadHost) throw new Error('ApplyUploadInner 未返回 UploadHosts: ' + String(text).slice(0, 200));
  if (log) log(`    StoreUri=${up.storeUri.slice(0, 60)}… UploadHost=${up.uploadHost}`);
  await putBytes(cfg, up, data, log, opts);

  // CommitUploadInner（vod 网关）
  const commitQuery = new URLSearchParams({
    Action: 'CommitUploadInner', Version: '2020-11-19', SpaceName: cfg.videoSpace,
  }).toString();
  const commitUrl = `${cfg.videoHost}?${commitQuery}`;
  const commitBody = Buffer.from(JSON.stringify({ SessionKey: sessionKey, Functions: [] }), 'utf8');
  const commitSigned = sign({
    method: 'POST', url: commitUrl, headers: { host: new URL(commitUrl).host },
    payload: commitBody,
    contentSha256: crypto.createHash('sha256').update(commitBody).digest('hex'),
    region: 'i18n', service: 'vod',
    accessKey: sts.AccessKeyId, secretKey: sts.SecretAccessKey,
    sessionToken: sts.SessionToken,
    when: sts.CurrentTime ? new Date(sts.CurrentTime) : undefined,
    signContentSha256: true,
  });
  const commitRes = await pickFetch(opts)(commitUrl, {
    method: 'POST',
    headers: { ...baseHeaders(session, cfg), 'content-type': 'application/json', ...commitSigned },
    body: commitBody,
  });
  const committed = await readJson(commitRes);
  const raw = committed.json || {};
  const cResult = raw.Result || raw.result || {};
  const vid = cResult.Vid || cResult.vid
    || ((cResult.Results || [])[0] || {}).Vid || ((cResult.Results || [])[0] || {}).vid
    || (cResult.VideoInfo || {}).Vid || vidFromApply || '';
  let previewUrl = cResult.VideoUrl || cResult.PlayUrl || cResult.MainUrl
    || (cResult.VideoInfo || {}).VideoUrl || (cResult.VideoInfo || {}).MainUrl || '';
  if (!previewUrl && up.storeUri) {
    previewUrl = `${cfg.videoCdnHost || cfg.cdnHost}/${up.storeUri}`;
  }
  if (!vid) {
    throw new Error(`CommitUploadInner 未返回 Vid：${JSON.stringify(raw).slice(0, 400)}`);
  }
  if (log) log(`    → vid=${vid} preview=${String(previewUrl).slice(0, 90)}`);
  return { vid, previewUrl, postUrl: '', raw };
}

module.exports = {
  STS_PATH,
  PROXY_PATH,
  crc32hex,
  baseHeaders,
  getSts,
  applyUpload,
  pickUploadHost,
  putBytes,
  commitUpload,
  cdnUrl,
  isNative,
  uploadImage,
  uploadVideo,
  EMPTY_SHA256,
};
