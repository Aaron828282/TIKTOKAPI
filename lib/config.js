'use strict';
/**
 * 节点配置 —— **全部来自环境变量**，一个配置文件都不读。
 *
 * 为什么坚持只用环境变量
 * ----------------------
 * 这个节点要跑在托管平台上（Hostinger Web Apps / Docker），
 * 托管平台的持久磁盘不可靠、配置文件更容易被误提交进公开仓库。
 * 环境变量既能在面板里改，又天然不进版本库。
 *
 * 本地调试时把 `.env.example` 复制成 `.env` 并 `export $(cat .env | xargs)`，
 * 或者直接 `node index.js` 前 export 几个变量。
 */

const os = require('node:os');

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === null || v === '' ? fallback : String(v);
}

function envInt(name, fallback) {
  const n = Number.parseInt(env(name, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback = false) {
  const v = env(name, '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function envList(name, fallback) {
  const v = env(name, '');
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 参考图重传时要「认出来是自家图床」的后缀；命中就不必重传。 */
const NATIVE_HOSTS = ['.ibyteimg.com', '.tiktokcdn.com', '.tiktokcdn-us.com'];

const cfg = {
  // ---- 号池 ----
  // ⚠️ 用 IP 字面量：IP 不发 SNI，正好绕过阿里云对「未接入备案域名」的 SNI 拦截。
  poolUrl: env('RH_POOL_URL', 'https://39.96.66.94').replace(/\/+$/, ''),
  agentToken: env('RH_AGENT_TOKEN', ''),
  /** 号池 443 是自签证书。给它一份 CA 文件即可把身份钉死（比关校验安全得多）。 */
  poolCaFile: env('RH_POOL_CA_FILE', ''),
  /** 最后手段：完全不校验。仅在临时联调时用，生产不要开。 */
  poolInsecure: envBool('RH_POOL_INSECURE', false),

  // ---- 身份 ----
  agentId: env('RH_AGENT_ID', os.hostname().slice(0, 64)),
  backends: envList('RH_BACKENDS', ['tiktok_r2v']),
  pollSeconds: Number(env('RH_POLL_SECONDS', '8')),
  heartbeatSeconds: Number(env('RH_HEARTBEAT_SECONDS', '30')),
  /** 单任务本地执行上限。**必须小于号池的 agent_timeout（默认 900s）？不** ——
   *  执行期间我们持续打心跳，所以可以更长；用 1500s 与既有 agent 对齐。 */
  jobTimeoutSeconds: Number(env('RH_JOB_TIMEOUT_SECONDS', '1500')),

  // ---- HTTP 服务 ----
  // 托管平台会注入 PORT，并期望进程监听它 —— 这也是让进程「活着」的方式。
  port: envInt('PORT', 8080),
  host: env('HOST', '0.0.0.0'),

  // ---- 会话凭据（TikTok 登录态）----
  /** 直接给 JSON（可 base64）。优先级最高——托管平台没有持久盘，推荐用这个。 */
  sessionJson: env('RH_SESSION_JSON', ''),
  /** 或者给一个文件路径。 */
  sessionFile: env('RH_SESSION_FILE', ''),

  // ---- 成品交付 ----
  /**
   * cdn    —— 直接把 TikTok CDN 直链回报给号池（+ 变体 + 过期时间）。
   *           最省事，但那条直链**必须有 `Referer` 才下得动**、且会过期，
   *           下游要自己处理。
   * mirror —— 节点先带 Referer 把片子下载下来，再 POST 到 MIRROR_URL 换成
   *           一个稳定 URL 回报。需要下游提供一个接收端。
   */
  outputMode: env('RH_OUTPUT_MODE', 'cdn').toLowerCase(),
  mirrorUrl: env('RH_MIRROR_URL', ''),
  mirrorToken: env('RH_MIRROR_TOKEN', ''),

  // ---- TikTok 上游（一般不用改）----
  cdnHost: env('RH_CDN_HOST', 'https://p19-creative-tool-sg.ibyteimg.com'),
  serviceId: env('RH_SERVICE_ID', 'n2703mo9gi'),
  referer: env('RH_REFERER', 'https://ads.tiktok.com/creative/creativestudio/image-to-video'),
  origin: env('RH_ORIGIN', 'https://ads.tiktok.com'),
  userAgent: env('RH_USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'),
  nativeHosts: envList('RH_NATIVE_HOSTS', NATIVE_HOSTS),

  logLevel: env('RH_LOG_LEVEL', 'info').toLowerCase(),
};

/**
 * 读取会话凭据，返回 { cookie, x_csrftoken, device_id }。
 *
 * 三种来源，按优先级：RH_SESSION_JSON（原样或 base64）→ RH_SESSION_FILE。
 * 找不到就抛错 —— 早失败早清楚，别等真的要去提交时才报「鉴权失败」。
 */
function loadSession() {
  const fs = require('node:fs');

  let raw = cfg.sessionJson;
  if (!raw && cfg.sessionFile) {
    if (!fs.existsSync(cfg.sessionFile)) {
      throw new Error(`会话文件不存在：${cfg.sessionFile}`);
    }
    raw = fs.readFileSync(cfg.sessionFile, 'utf8');
  }
  if (!raw) {
    throw new Error('未提供会话凭据：设 RH_SESSION_JSON（推荐）或 RH_SESSION_FILE');
  }

  let text = raw.trim();
  // 不像 JSON 就当成 base64 —— 托管平台的环境变量里塞多行 JSON 很别扭
  if (!text.startsWith('{')) {
    text = Buffer.from(text, 'base64').toString('utf8').trim();
  }

  let sess;
  try {
    sess = JSON.parse(text);
  } catch (err) {
    throw new Error(`会话凭据不是合法 JSON（base64 解出来也不是）：${err.message}`);
  }

  const missing = ['cookie', 'x_csrftoken', 'device_id'].filter((k) => !sess[k]);
  if (missing.length) throw new Error(`会话凭据缺少必需字段：${missing.join(', ')}`);
  return {
    cookie: String(sess.cookie),
    x_csrftoken: String(sess.x_csrftoken),
    device_id: String(sess.device_id),
  };
}

function hasSession() {
  try {
    loadSession();
    return true;
  } catch {
    return false;
  }
}

module.exports = { cfg, loadSession, hasSession, NATIVE_HOSTS };
