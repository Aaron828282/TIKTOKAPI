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
const { SESSION_REQUIRED, SESSION_OPTIONAL, normalizeSession, describe } = require('./session');
const sessioncache = require('./sessioncache');

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
  /**
   * 并发 worker 数 —— 也就是「节点同时执行的任务数」上限。
   *
   * 为什么默认 5：TikTok 单账号并发上限实测就是 5（Gitee number-pool 与
   * 上游 Bundle 双源一致），号池侧账号池的 `max_slots` 也默认 5。节点派
   * `maxConcurrent` 个 worker 各自 claim→租号→执行→还槽，单账号场景下
   * 并发就是 5；加了 N 个账号后池子总并发是「账号数 × 5」，此时把这个值
   * 调到 `账号数 × 5` 即可吃满（worker 们各自租各自的号，天然跨账号）。
   */
  maxConcurrent: Math.max(1, Math.min(16, Math.trunc(Number(env('RH_MAX_CONCURRENT', '5')) || 5))),
  /** 单任务本地执行上限。**必须小于号池的 agent_timeout（默认 900s）？不** ——
   *  执行期间我们持续打心跳，所以可以更长。
   *
   *  5100s = 1500s 正常生成期 + 3600s 额外等待期（2026-09-21 用户需求）。
   *  🔴 租约（并发槽）必须持有到**拿到真实成片 URL 或确定性失败**才归还：
   *  TikTok 的 5 并发包含「进度 100%、即将出片」的任务 —— 上游最后这段
   *  「almost there」往往比 0→100% 还慢，提前还槽会让控制台并发虚低、
   *  新任务挤进来后单账号实际并发超过 TikTok 上限 5。 */
  jobTimeoutSeconds: Number(env('RH_JOB_TIMEOUT_SECONDS', '5100')),
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
  /**
   * 凭据**来源策略** —— 2026-09-20 起凭据的持有者从节点搬到了号池控制台。
   *
   *   pool —— 只认号池下发的那份。号池没配就任务失败，**绝不偷偷用本地的**
   *           （否则会出现「我以为在控制台换了 cookie，其实节点还在用旧的」）
   *   env  —— 只用 RH_SESSION_JSON / RH_SESSION_FILE（改造前的行为）
   *   auto —— 号池优先，号池没有才回落 env（默认）
   *
   * ⚠️ 广告线 TTL 只有 3 天 ⟹ 换 cookie 是**每 3 天都要发生**的日常动作。
   *    这正是把它搬到控制台的原因：换一次不必再重部署节点。
   */
  sessionSource: env('RH_SESSION_SOURCE', 'auto').toLowerCase(),
  /**
   * 向号池问「凭据变了没」的间隔（秒）。
   *
   * 命中版本号时号池只回 `{changed:false}`（几百字节），所以这个值可以很小；
   * 600s 是「换完 cookie 最多 10 分钟生效」的意思。想立刻生效就重启节点，
   * 或者把 `/status` 里的 session_version 看一眼。
   */
  sessionRefreshSeconds: Number(env('RH_SESSION_REFRESH_SECONDS', '600')),
  /**
   * 验活间隔（秒）。默认 6 小时。
   *
   * 为什么不跟刷新同频：验活是对 `ads.tiktok.com` 发真请求，10 分钟一次就是
   * 一天 144 次；一个广告账号的 cookie 打出这种规律流量不太好看。
   * 而凭据寿命是 3 天量级，6 小时一次的粒度足够提前预警。
   * 拉取到**新**凭据时无论如何都会立刻验活一次（那个不需要等定时）。
   */
  sessionProbeSeconds: Number(env('RH_SESSION_PROBE_SECONDS', '21600')),
  /**
   * 账号池采集间隔（秒）。默认 30 分钟，**下限硬夹 5 分钟**。
   *
   * 采的是「每个号还剩多少积分 / 今日额度 / 并发上限」—— 号池在北京够不到
   * TikTok，控制台那几个数字全靠节点捎回去。一轮对每个账号打 4 个免费只读
   * 接口，所以频率不能太密；但也不能不做：刚加完号还没跑过任务的账号，
   * 不做采集的话积分栏会一直是空的。
   *
   * 设 0 或负数 = 关掉定时采集（启动那一轮仍然会跑）。
   */
  accountCollectSeconds: Number(env('RH_ACCOUNT_COLLECT_SECONDS', '1800')),
  /** 用哪个 backend 的凭据。留空 = 取 RH_BACKENDS 的第一个。 */
  sessionBackend: env('RH_SESSION_BACKEND', ''),
  /** env 兜底：直接给 JSON（可 base64）。改造后它不是主路径，但仍是最快的救急手段。 */
  sessionJson: env('RH_SESSION_JSON', ''),
  /** env 兜底：或者给一个文件路径（本地调试用）。 */
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

// `RH_SESSION_BACKEND` 留空就跟着 `RH_BACKENDS` 走。放在字面量外面是因为
// 对象字面量里没法引用自己的另一个字段。
cfg.sessionBackend = cfg.sessionBackend || cfg.backends[0] || 'tiktok_r2v';

/**
 * 读取会话凭据，返回 `{ cookie, x_csrftoken, device_id, ... }`。
 *
 * 顺序（2026-09-20 改造后）：
 *   ① **运行时缓存**（号池下发，`lib/sessionruntime.js` 定时拉）
 *   ② `RH_SESSION_JSON`（原样或 base64）→ `RH_SESSION_FILE`（env 兜底）
 *
 * `RH_SESSION_SOURCE=env` 时跳过 ①，`=pool` 时跳过 ②（号池没有就抛错，
 * **不回落** —— 见 cfg.sessionSource 的说明）。抛错要早、要具体：
 * 别等真的要去提交时才报一个「鉴权失败」。
 *
 * ⚠️ **可选的字段必须原样透传**。`x_fp_id` / `user_agent` 在 `lib/tiktok.js`
 *    的 `headersOf()` 里是「有就带上」的（抓包里同源请求确实带 `x-fp-id`）。
 *    早先这里只挑出三个必需键、把其余全丢掉，于是那两个引用**永远是
 *    undefined** —— 不报错、不告警，只是悄悄少发两个头。少发头这轮可能没事，
 *    上游哪天收紧就是一次莫名其妙的 403。
 */

/** env 兜底路径。独立出来是因为「有没有兜底」本身就是一个要观测的事实。 */
function loadEnvSession() {
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
  return normalizeSession(sess);
}

/** 探测 env 兜底能力，不抛错。 */
function envSessionState() {
  try {
    return { session: loadEnvSession(), error: '' };
  } catch (err) {
    return { session: null, error: err.message };
  }
}

/** 缓存里有没有可用的一份（不做 env 回落，用于区分「号池给的」和「本地兜的」）。 */
function cachedSession(backend) {
  return sessioncache.get(backend || cfg.sessionBackend);
}

function loadSession(backend) {
  const key = backend || cfg.sessionBackend;

  if (cfg.sessionSource !== 'env' && sessioncache.has(key)) {
    return sessioncache.get(key);
  }
  if (cfg.sessionSource === 'pool') {
    // 刻意不回落 env：pool 模式下「用的是哪一份」必须唯一可判。
    // 混用会让「控制台换了 cookie 却没生效」变成常态。
    const st = envSessionState();
    throw new Error(
      '号池还没有下发会话凭据（RH_SESSION_SOURCE=pool 时不回落环境变量）'
      + (st.session ? '；本地 RH_SESSION_JSON 明明配了，说明节点还没从号池拉到' : '')
      + ' —— 到号池控制台的「TikTok 会话凭据」里粘贴一份，或把 RH_SESSION_SOURCE 改成 auto');
  }
  if (cfg.sessionSource === 'env') {
    return loadEnvSession();
  }

  // auto：号池优先、env 兜底。**两条路都没有**时的报错要说清两条路 ——
  // 而且第一句得是「去控制台」，因为那才是改造后的常规动作；
  // 只回一句「设 RH_SESSION_JSON」会把人引回托管面板重部署，白跑一趟。
  try {
    return loadEnvSession();
  } catch (err) {
    throw new Error(
      `${err.message}；号池那边也没有下发（RH_SESSION_SOURCE=auto）。`
      + '推荐到号池控制台的「TikTok 会话凭据」粘贴一份 —— 不用改这个节点的'
      + '环境变量、也不用重新部署；或仍按老办法设 RH_SESSION_JSON');
  }
}

function hasSession(backend) {
  try {
    loadSession(backend);
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
  // ---- 会话凭据来源 ----
  if (!['auto', 'pool', 'env'].includes(cfg.sessionSource)) {
    fatal.push(`RH_SESSION_SOURCE 只能是 auto / pool / env，现在是 ${JSON.stringify(cfg.sessionSource)}`);
  }
  const envState = envSessionState();
  if (cfg.sessionSource === 'env') {
    if (!envState.session) {
      warn.push(`会话凭据不可用（${envState.error}）—— 能接单但无法执行；`
        + 'RH_SESSION_SOURCE=env，只能靠 RH_SESSION_JSON / RH_SESSION_FILE');
    }
  } else {
    if (envState.session) {
      warn.push(`RH_SESSION_SOURCE=${cfg.sessionSource}，但 RH_SESSION_JSON/FILE 也配了 —— `
        + '号池下发的那份优先，env 只是兜底。（「在控制台换了 cookie 却没生效」'
        + '多半就是这个：env 里那份旧的还在，看着像没换。）');
    }
    if (cfg.sessionSource === 'pool' && !envState.session) {
      warn.push('RH_SESSION_SOURCE=pool：不使用环境变量凭据，一切以号池为准。'
        + '号池没配的话任务一律失败 —— 这是刻意的，免得两份凭据互相冒充。');
    }
  }
  // ⚠️ 这里**不判断**「现在有没有可用凭据」：auto/pool 模式下凭据是启动
  //    之后才从号池拉的（见 index.js 的「启动自检 2」）。在这判断只会得到
  //    一个必然的假告警。
  const bootSess = cachedSession();
  if (bootSess) {
    const d = describe(bootSess);
    if (d.level === 'dead') {
      warn.push(`TikTok 会话：${d.note} —— 每个任务都会在上游拿 10001106，`
        + '必须到号池控制台换一份');
    } else if (d.level === 'warn') {
      warn.push(`TikTok 会话：${d.note} —— 建议现在就换，别等它变成 10001106`);
    }
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

/** 会话的一行摘要（含剩余寿命），没配就返回 `null`。启动日志与自检共用。 */
function sessionStatus(backend) {
  try {
    return describe(loadSession(backend));
  } catch {
    return null;
  }
}

/**
 * 当前这份凭据**是从哪来的** —— `'cache' | 'env' | null`。
 *
 * 单列一个函数是因为它决定了运维动作：`cache` 要去号池控制台换，
 * `env` 要去托管面板改环境变量重部署。两者的处置路径完全不同。
 */
function sessionOrigin(backend) {
  const key = backend || cfg.sessionBackend;
  if (cfg.sessionSource !== 'env' && sessioncache.has(key)) return 'cache';
  if (cfg.sessionSource === 'pool') return null;
  return envSessionState().session ? 'env' : null;
}

module.exports = {
  cfg, loadSession, loadEnvSession, envSessionState, hasSession,
  validate, sessionStatus, sessionOrigin, sessioncache,
  NATIVE_HOSTS, SESSION_REQUIRED, SESSION_OPTIONAL,
};
