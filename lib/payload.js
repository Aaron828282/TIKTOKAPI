'use strict';
/**
 * TikTok Creative Studio「Reference to Video」请求体的构造（唯一真相源）。
 *
 * ⚠️ 本文件是 `reference/r2v_payload.py` 的移植。协议一旦变动，两边都要改。
 *
 * 协议要点
 * --------
 * - `settings` 是**字符串**（JSON-in-JSON），只有 4 个键：
 *   `images / prompt / aiModel / duration` —— 页面内部的 `ai_model`、`avatar_id`、
 *   `sub_app` 只进埋点，不进 wire。
 * - `model`（顶层）与 `settings.aiModel` **都**要填模型数字 ID，取值相同；平台读后者，
 *   但前者不一致时会被前端逻辑改写。
 * - 参考图只需给 `origin`：服务端自己回填带 `refresh_token` + `x-signature` 的
 *   avif/webp 变体，客户端多写反而容易踩签名过期。
 * - `mentions[].id` 与图片的 origin URL 相同（type=1 表示图片）。
 * - 时长 4~15 秒（seedance2 / seedance2Mini / seedance2Fast 三者共用同一套字段定义）。
 */

/** 页面自身的公开查询串（aid/app_name 是产品级常量，不是用户凭据）。 */
const QUERY_AID = 'aid=585599&app_name=creative_aio_client&device_platform=web';

/** 提交时带的来源头。少它会 403 —— 它是「客户端自报」而非密钥。 */
const SOURCE_HEADER = 'CreativeStudio/MiniApp/ImageToVideo';

/** 时长边界（bundle 权威：{duration:{defaultValue:5,min:4,max:15,step:1}}）。 */
const DURATION_MIN = 4;
const DURATION_MAX = 15;
const DURATION_DEFAULT = 5;

/** 把时长夹进 4~15 的合法区间；解析不出来用默认 5。 */
function clampDuration(value) {
  const n = Math.trunc(Number.parseFloat(String(value ?? '').trim()));
  if (!Number.isFinite(n)) return DURATION_DEFAULT;
  return Math.max(DURATION_MIN, Math.min(DURATION_MAX, n));
}

/**
 * 一张参考图的 wire 形态。
 *
 * `id` 用固定 UUID 写法（客户端自己生成即可，平台不校验其含义）；
 * 给不同图片不同 id，避免平台按 id 去重时把第二张吃掉。
 */
function imageEntry(url, index = 1) {
  return {
    fileType: 'image',
    id: `8f1a2b3c-0000-4000-8000-${String(index).padStart(12, '0')}`,
    imageSrcSet: { origin: url },
    label: `image ${index}`,
    name: `${index}.png`,
    previewUrl: url,
    previewUrlSrcSet: { origin: url },
  };
}

/**
 * 一条参考视频的 wire 形态（2026-09-23 真实抓包实锤，网站打码链路）。
 *
 * 与图片条目并列放在 settings.images[] 里，形态差异：
 * - `fileType: 'video'`，带 `vid`（TikTok 视频库 ID，上传链 CommitVideoUpload 返回）
 * - `previewUrl` 是**签名视频 CDN 直链**（会过期，提交时有效即可）
 * - `postUrl` 是封面图（ibyteimg，可缺省 —— 服务端大概率自己取首帧）
 * - mentions 里视频是 `{type: 2, id: vid}`（图片是 type 1 + URL）
 */
function videoEntry(ref, index = 1) {
  const entry = {
    id: ref.id || `8f1a2b3c-0000-4000-9000-${String(index).padStart(12, '0')}`,
    fileType: 'video',
    vid: ref.vid,
    postUrl: ref.postUrl || '',
    previewUrl: ref.previewUrl,
  };
  if (!entry.postUrl) delete entry.postUrl;
  return entry;
}

/**
 * 拼出 `POST /creative_bff_i18n/api/cue/i2v/gen_r2v_video` 的请求体。
 *
 * imageUrls 为空数组 = 纯文生视频（2026-09-21 起为一等公民：网站允许不传参考图，
 * 生产已实测出片）。非空时走标准 R2V。
 *
 * videoRefs（2026-09-23）：参考视频数组 [{vid, previewUrl, postUrl?}]，
 * 由 uploadVideo() 上传后传入；空数组 = 不带视频参考（行为与旧版完全一致）。
 *
 * ⚠️ 键顺序有意义（顶层 prompt → duration → model → settings → mentions，
 * settings 内 images → prompt → aiModel → duration）。JS 对象保持插入顺序，
 * 且我们用 JSON.stringify，顺序会原样落到 wire 上。
 */
function buildPayload(prompt, imageUrls, modelId, duration = DURATION_DEFAULT, videoRefs = []) {
  const urls = (imageUrls || []).map((u) => String(u)).filter(Boolean);
  const vids = (videoRefs || []).filter((r) => r && r.vid && r.previewUrl);
  const secs = clampDuration(duration);
  const images = [
    ...urls.map((u, i) => imageEntry(u, i + 1)),
    ...vids.map((r, i) => videoEntry(r, i + 1)),
  ];
  const settings = {
    images,
    prompt,
    aiModel: String(modelId),
    duration: secs,
  };
  return {
    prompt,
    duration: secs,
    model: String(modelId),
    settings: JSON.stringify(settings),
    mentions: [
      ...urls.map((u) => ({ type: 1, id: u })),
      ...vids.map((r) => ({ type: 2, id: r.vid })),
    ],
  };
}

/**
 * 拼出 `POST /creative_bff_i18n/api/cue/i2v/gen_i2i_image`（Nano Banana 生图）的请求体。
 *
 * 协议（2026-09-23 从页面抓包实锤）：
 * - 顶层 4 个键：`images / prompt / model / settings`；**没有 duration**。
 * - `settings` 仍是 JSON-in-JSON 字符串，只有 3 个键：`images / prompt / aiModel`。
 * - `model` 与 `settings.aiModel` 都填 `"gemini"`（页面把 Nano Banana 叫 gemini）。
 * - `images` 为空数组 = 纯文生图（页面实测可过）；带参考图时形态与 R2V 的
 *   imageEntry 相同（origin 即可，服务端自带回签名变体）。
 * - 输出固定 9:16、一次 4 张 —— 每张是 history 里的一条 draft（miniAppType=I2I_IMAGE）。
 * - 键顺序照页面原样：顶层 images → prompt → model → settings。
 */
function buildImagePayload(prompt, imageUrls, modelId = 'gemini') {
  const urls = (imageUrls || []).map((u) => String(u)).filter(Boolean);
  const images = urls.map((u, i) => imageEntry(u, i + 1));
  const settings = {
    images,
    prompt,
    aiModel: String(modelId),
  };
  return {
    images,
    prompt,
    model: String(modelId),
    settings: JSON.stringify(settings),
  };
}

/** 生成 8 位随机串（`s` 参数，疑似防重放）。 */
function randomState() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** 查询串（`did` / `device_id` 取会话里的值）。 */
function queryOf(deviceId) {
  const did = String(deviceId || '');
  return `${QUERY_AID}&did=${encodeURIComponent(did)}&device_id=${encodeURIComponent(did)}`;
}

module.exports = {
  QUERY_AID,
  SOURCE_HEADER,
  DURATION_MIN,
  DURATION_MAX,
  DURATION_DEFAULT,
  clampDuration,
  imageEntry,
  videoEntry,
  buildPayload,
  buildImagePayload,
  randomState,
  queryOf,
};
