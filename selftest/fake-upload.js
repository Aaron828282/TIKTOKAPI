'use strict';
/**
 * 自测用的假参考图上传 —— 真实实现要五次往返 TikTok 图床（STS → Apply →
 * TOS → Commit → CDN），自测里没必要，直接原样返回输入地址。
 */
async function uploadImage(_session, _cfg, imageUrl, log) {
  if (log) log(`    [fake] 跳过真实上传：${String(imageUrl).slice(0, 60)}`);
  return imageUrl;
}

module.exports = { uploadImage, isNative: () => true };
