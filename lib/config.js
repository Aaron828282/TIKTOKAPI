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
  /**
   * 轮询期间「问一句这活还要不要」的间隔（秒）。
   *
   * 号池侧 heartbeat 的 `cancelled` 是**硬编码 false 的桩**，真正的取消判定在
   * `GET /api/v1/agent/task/{id}`（见 agent_gateway.py 的 peek）。不问的话，
   * 控制台取消了任务，节点照样跑到底 —— 白烧一次上游额度（结果会被
   * `already_final` 丢弃，不出错，但钱花掉了）。0 = 关闭这个询问。
   */
  peekSeconds: Number(env('RH_PEEK_SECONDS', '20')),

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
   *           最省事，但下游会撞三道门（详见 README「成品回传」）：
   *           域名白名单、缺 Referer 的 403、小时级的 UrlExpire。
   *          **只适合人工验证，不能当生产交付路径。**
   * mirror —— 节点先带 Referer 把片子下载下来，再 POST 到 MIRROR_URL 换成
   *           一个稳定 URL 回报。需要下游提供一个接收端（网站侧专用令牌端点）。
   *
   * ⚠️ 默认值取 `mirror` 而不是 `cdn`，这是**故意 fail closed**：
   *    没配 RH_MIRROR_URL 时任务会带着一句明确的报错失败，而不是把一个
   *    下游注定归档不了的直链当成成功交出去（那正是 2026-09-19 线上事故的形态）。
   */
  outputMode: env('RH_OUTPUT_MODE', 'mirror').toLowerCase(),
  mirrorUrl: env('RH_MIRROR_URL', ''),
  mirrorToken: env('RH_MIRROR_TOKEN', ''),
  /** 收件端有体积闸门（网站侧 25MB）。超了不如就地报错，别传一半再被拒。 */
  mirrorMaxMb: Number(env('RH_MIRROR_MAX_MB', '24')),
  mirrorTimeoutSeconds: Number(env('RH_MIRROR_TIMEOUT_SECONDS', '300')),

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
 * 读取会话凭据，返回 { cookie, x_csrftoken, device_id, ... }。
 *
 * 三种来源，按优先级：RH_SESSION_JSON（原样或 base64）→ RH_SESSION_FILE。
 * 找不到就抛错 —— 早失败早清楚，别等真的要去提交时才报「鉴权失败」。
 *
 * ⚠️ **可选的字段必须原样透传**。`x_fp_id` / `user_agent` 在 `lib/tiktok.js`
 *    的 `headersOf()` 里是「有就带上」的（抓包里同源请求确实带 `x-fp-id`）。
 *    早先这里只挑出三个必需键、把其余全丢掉，于是那两个引用**永远是
 *    undefined** —— 不报错、不告警，只是悄悄少发两个头。少发头这轮可能没事，
 *    上游哪天收紧就是一次莫名其妙的 403。
 */
const SESSION_REQUIRED = ['cookie', 'x_csrftoken', 'device_id'];
/** 抓包里出现过的可选头，给了就带上。 */
const SESSION_OPTIONAL = ['x_fp_id', 'user_agent'];

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

function hasSession() {
  try {
    loadSession();
    return true;
  } catch {
    return false;
  }
}

/**
 * 配置自检 —— 返回 `{ fatal: [...], warn: [...] }`。
 *
 * 为什么在**启动时**就把话说全：这台机器上出问题时的可观测性很有限
 * （托管平台给的是一个日志面板，不是 shell）。把「缺什么、会以什么形式坏掉」
 * 在启动那 20 行里讲清楚，比等出片时才报一个 403 划算得多。
 *
 * `fatal` = 这个进程就算跑起来也干不成活；`warn` = 能跑，但某个能力是残的。
 */
function validate() {
  const fatal = [];
  const warn = [];

  if (!cfg.agentToken) {
    fatal.push('RH_AGENT_TOKEN 未配置 —— 号池会回 503 AGENT_DISABLED（它刻意 fail closed）');
  }
  if (!cfg.poolUrl.startsWith('http')) {
    fatal.push(`RH_POOL_URL 不是完整地址：${JSON.stringify(cfg.poolUrl)}`);
  }
  if (!hasSession()) {
    let why = '';
    try {
      loadSession();
    } catch (err) {
      why = err.message;
    }
    warn.push(`会话凭据不可用（${why}）—— 能接单但无法执行；补齐 RH_SESSION_JSON 后重启`);
  }

  // ---- 成品交付 ----
  if (!['cdn', 'mirror'].includes(cfg.outputMode)) {
    fatal.push(`RH_OUTPUT_MODE 只能是 cdn 或 mirror，现在是 ${JSON.stringify(cfg.outputMode)}`);
  } else if (cfg.outputMode === 'mirror' && !cfg.mirrorUrl) {
    // 不致命（进程该起来还是起来，控制台也要能看见它），但每个任务都会失败
    warn.push('RH_OUTPUT_MODE=mirror 但 RH_MIRROR_URL 为空 —— 每个任务都会在交付环节失败');
  } else if (cfg.outputMode === 'cdn') {
    warn.push('RH_OUTPUT_MODE=cdn：回报的是 TikTok CDN 直链（需 Referer 且小时级过期），'
      + '下游多半归档不了，仅适合人工验证');
  }

  // ---- 号池 TLS ----
  if (String(cfg.poolUrl).startsWith('https')) {
    if (cfg.poolInsecure) {
      warn.push('RH_POOL_INSECURE 开着：号池侧只加密、**不验身份**，'
        + '主动中间人可以冒充号池下发伪造任务。生产应改用 RH_POOL_CA_FILE');
    } else if (!cfg.poolCaFile) {
      warn.push('既没配 RH_POOL_CA_FILE 也没开 RH_POOL_INSECURE：号池是 IP 自签证书，'
        + '握手会直接失败。二选一（推荐前者）');
    }
  }
  return { fatal, warn };
}

module.exports = {
  cfg, loadSession, hasSession, validate,
  NATIVE_HOSTS, SESSION_REQUIRED, SESSION_OPTIONAL,
};
