'use strict';
/**
 * 会话运行时 —— 节点侧「按需从号池取凭据」的全部逻辑。
 *
 * 为什么凭据要放在号池
 * --------------------
 * 广告线会话 **TTL 只有 3 天**（通用线 180 天），也就是说「换 cookie」
 * 是每 3 天就要发生一次的**日常动作**，不是一次性的部署配置。原先它躺在节点的
 * `RH_SESSION_JSON` 环境变量里 ⟹ 每换一次都要改托管面板 + 重新部署。
 * 改成号池持有、控制台切换之后，换 cookie 变成一个网页上的粘贴动作。
 *
 * 协议（对齐 server/app/agent_gateway.py）
 * ---------------------------------------
 *   GET  /agent/session?backend=&since=<本地版本号>&agent_id=
 *        → {configured:false}                  号池没配 → 回落 env
 *        → {changed:false}                     本地那份就是最新的（不传凭据）
 *        → {changed:true, version, session}    新的一份
 *        → 5xx / 网络错                          故障 → **保留旧凭据**并告警
 *   POST /agent/session/report {backend, ok, code, message, agent_id}
 *
 * 三条容易写错的铁律
 * ------------------
 * 1. **号池报错 ≠ 号池没配**。前者要保留旧凭据 + 告警，后者才降级到 env。
 *    混为一谈的后果：号池抖一下，节点就悄悄退到一份过期几天的本地 cookie，
 *    然后一直到出片才以 `10001106` 炸出来 —— 那时客户已经在等片子了。
 * 2. **验活结论只能由节点给**。号池在北京，`ads.tiktok.com` 的 DNS 被污染，
 *    它自己够不到。不回报的话控制台只能显示「已配置」，而「已配置、其实是死的」
 *    正是最坏的状态：界面全绿，订单一来就 10001106。
 * 3. **只有「提交」阶段允许因 10001106 重试一次**。轮询期间会话失效绝不能
 *    重新提交 —— 那时上游生成任务**已经建好了**，重提等于建第二单、
 *    白烧一次额度。这条与 Dify 提交节点不许开自动重试是同一个教训。
 */
const { cfg, loadSession, envSessionState, sessioncache } = require('./config');
const { normalizeSession, describe } = require('./session');

/** 号池判定「会话已失效」的业务码。 */
const LOGIN_REQUIRED_CODE = 10001106;

/** 模块级运行态，供 `/status` 观测（**绝不放凭据本体**）。 */
const last = {
  at: 0,            // 最后一次向号池询问的时间
  ok: null,         // 最近一次询问成功与否
  changed: null,    // 那次询问是否带回了新凭据
  error: '',        // 最近一次失败原因
  version: 0,       // 最近一次拿到的版本号
  probeAt: 0,       // 最近一次验活时间
  probeOk: null,    // 验活结论
  probeCode: null,
  reason: '',       // 触发这次刷新的原因（启动 / 定时 / 10001106）
};

let inflight = null;   // 并发保护：定时与强制刷新撞车时只发一次请求
let timer = null;
let probeTimer = null;
let clientRef = null;
let logRef = () => {};

/** 错误文案里出现失效码 ⟹ 这份 cookie 死了。 */
function isAuthExpired(err) {
  const m = String((err && err.message) || err || '');
  return new RegExp(`\\b${LOGIN_REQUIRED_CODE}\\b`).test(m) || /Login\s*Required/i.test(m);
}

function status() {
  return { ...last, source: cfg.sessionSource, backend: cfg.sessionBackend };
}

/**
 * 验活并回报给号池。
 *
 * 探活用 `lib/tiktok.js` 的 `probeSession`（发空体看业务码），**不消耗额度**。
 * 回报失败不算致命：号池下次还会问，但要在日志里留痕。
 *
 * ⚠️ 回报要带上**它验的是哪个版本**。号池侧是「后到覆盖先到」的，
 *    一个慢吞吞的旧探活结果理论上能覆盖掉新的 —— 实测同一进程内不会乱序，
 *    但版本号留在回报里，出问题时至少能对上账。
 */
async function probeAndReport(client, log, { backend = cfg.sessionBackend, reason = '' } = {}) {
  const tiktok = require('./tiktok');
  let session;
  try {
    session = loadSession(backend);
  } catch (err) {
    return { ok: false, alive: null, error: err.message };
  }

  let probe;
  try {
    probe = await tiktok.probeSession(session, cfg);
  } catch (err) {
    // 探活**自身**出错（网络不通）与「探活说 cookie 死了」是两件事，
    // 别把网络问题回报成「凭据失效」—— 那会让人去换一份根本没问题 cookie。
    log(`会话验活异常（不改判结论）：${err.message}`, 'warn');
    last.probeAt = Date.now();
    last.probeOk = null;
    return { ok: null, alive: null, error: err.message };
  }

  last.probeAt = Date.now();
  last.probeOk = probe.alive;
  last.probeCode = probe.code;

  const meta = sessioncache.info(backend);
  try {
    await client.reportSession({
      backend,
      ok: probe.alive,
      code: probe.code,
      message: String(probe.message || '').slice(0, 300),
      agent_id: cfg.agentId,
      version: meta ? meta.version : 0,
    });
  } catch (err) {
    log(`会话验活结果回报失败（不影响本地使用）：${err.message}`, 'warn');
  }

  if (probe.alive) {
    log(`会话验活通过（code=${probe.code}）`, 'info');
  } else {
    log(`🔴 会话已失效（code=${probe.code} ${probe.message}）—— `
      + `到号池控制台的「TikTok 会话凭据」换一份，本地无需重部署`, 'error');
  }
  return {
    ok: probe.alive, alive: probe.alive, code: probe.code,
    message: probe.message, status: probe.status,
  };
}

/** 真正向号池要一次凭据。并发保护 + 全部失败分支都落到返回值里，不抛。 */
async function fetchOnce(client, log, { force, reason, probe, backend }) {
  const key = backend || cfg.sessionBackend;
  const before = sessioncache.info(key);
  const since = force ? 0 : (before ? before.version : 0);

  let r;
  try {
    r = await client.session(key, since, cfg.agentId);
  } catch (err) {
    last.at = Date.now();
    last.ok = false;
    last.changed = false;
    last.error = err.message;
    last.reason = reason;
    // ★ 号池不可达 ⟹ **保留旧凭据**。网络抖一下就把缓存清掉，只会让
    //   正在跑的任务凭空多一次失败机会；旧 cookie 只要没过期就还能用。
    // 404 单独说一句：那几乎一定是**号池镜像太旧**（还没这条端点），
    // 和「号池挂了」是两回事，处置也完全不同（升级号池 vs 等它恢复）。
    if (err && err.status === 404) {
      log('号池没有 /api/v1/agent/session 这条端点（HTTP 404）—— '
        + '多半是号池镜像还是旧版；升级号池后即可在控制台切换会话凭据', 'warn');
    } else {
      log(`会话凭据拉取失败（${err.message}）`
        + (before ? `—— 继续用本地缓存 v${before.version}` : '—— 本地也没有缓存'), 'warn');
    }
    return { ok: false, unreachable: true, error: err.message, kept: Boolean(before) };
  }

  last.at = Date.now();
  last.ok = true;
  last.error = '';
  last.reason = reason;

  // ---- 号池还没配 ----
  if (!r || r.configured === false) {
    if (cfg.sessionSource === 'pool') {
      // pool 模式刻意不回落：两份凭据互相冒充比「没得用」更难排查
      last.ok = false;
      last.error = 'SESSION_NOT_CONFIGURED';
      log('号池未配置会话凭据（configured=false），且 RH_SESSION_SOURCE=pool —— '
        + '任务无法执行；到号池控制台粘贴一份', 'error');
      return { ok: false, notConfigured: true, note: '号池未配置' };
    }
    const envSt = envSessionState();
    if (envSt.session) {
      log('号池未配置会话凭据（configured=false）—— 按 RH_SESSION_SOURCE=auto 回落本地凭据。'
        + '⚠️ 这份是本地的，控制台换了也不会影响它', 'warn');
      return { ok: true, source: 'env', fallback: true, version: 0 };
    }
    last.ok = false;
    last.error = 'SESSION_NOT_CONFIGURED';
    log('号池未配置会话凭据，本地也没有可用的 —— 任务无法执行', 'error');
    return { ok: false, notConfigured: true, note: '号池未配置且本地为空' };
  }

  // ---- 没变：一个字节的凭据都没传 ----
  if (r.changed === false) {
    last.changed = false;
    last.version = Number(r.version) || 0;
    // 刻意**不验活**：这一句的语义是「本地那份就是最新的」，不是「那份是活的」。
    // 每次轮询都顺手打一枪 ads.tiktok.com，规律流量比一个过期的结论更难看。
    // 定时验活交给 startProbeTimer。
    return { ok: true, changed: false, version: last.version, source: 'cache' };
  }

  // ---- 有新的一份 ----
  let session;
  try {
    session = normalizeSession(r.session);
  } catch (err) {
    // 号池发的凭据结构不对（不该发生）。**不覆盖**本地那份 —— 坏凭据顶掉好凭据
    // 会让「本来还能跑」变成「立刻不能跑」。号池侧日志里能看到 SESSION_UNREADABLE。
    last.ok = false;
    last.error = `号池下发的凭据不可用：${err.message}`;
    log(`🔴 号池下发的会话凭据结构不对（${err.message}）—— 保留本地原有那份`, 'error');
    return { ok: false, invalid: err.message, kept: Boolean(before) };
  }

  const entry = sessioncache.set(key, session, {
    version: Number(r.version) || 0, source: 'pool', from: '号池控制台',
  });
  last.changed = true;
  last.version = entry.version;

  const d = describe(session);
  const tag = d.level === 'dead' ? '🔴' : (d.level === 'warn' ? '⚠️' : '✓');
  log(`${tag} 已从号池领取会话凭据 v${entry.version}`
    + (before && before.version !== entry.version ? `（原 v${before.version}）` : '')
    + ` · ${d.note} · cookie ${d.cookieKeys.length} 键`,
  d.level === 'ok' ? 'info' : 'warn');

  if (probe) await probeAndReport(client, log, { backend: key, reason });
  return { ok: true, changed: true, version: entry.version, lifetime: d, source: 'pool' };
}

/**
 * 刷新一次。
 *
 * `force=true` ⟹ `since=0`，号池无论版本是否变化都会把当前那份发回来。
 * 用在「本地已知这份坏了」的场合（命中 10001106）。
 */
function refresh(client, log, opts = {}) {
  const {
    force = false, reason = 'timer', probe = true, backend = cfg.sessionBackend,
  } = opts;
  if (cfg.sessionSource === 'env') {
    return Promise.resolve({ ok: false, skipped: 'RH_SESSION_SOURCE=env', source: 'env' });
  }
  if (inflight) return inflight;   // 定时与强制刷新撞车 → 共用一次请求

  inflight = fetchOnce(client, log, { force, reason, probe: Boolean(probe), backend })
    .catch((err) => {
      // fetchOnce 内部已兜住所有已知失败；走到这里说明是它自己的 bug，
      // 不能让它冒泡把取活循环带崩。
      log(`会话刷新内部错误：${err && err.stack || err}`, 'error');
      return { ok: false, error: String(err && err.message || err) };
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * 启动 + 定时刷新，并在拿到凭据后验活回报。
 *
 * 返回首次拉取的结果（调用方据此决定启动日志怎么写）。
 */
async function start(client, log) {
  clientRef = client;
  logRef = log || (() => {});

  const first = await refresh(client, log, { force: true, reason: 'startup', probe: true });

  if (timer) clearInterval(timer);
  const sec = Math.max(30, Number(cfg.sessionRefreshSeconds) || 600);
  timer = setInterval(() => {
    refresh(clientRef, logRef, { reason: 'timer', probe: true })
      .catch((err) => logRef(`定时刷新会话出错：${err.message}`, 'warn'));
  }, sec * 1000);
  if (timer.unref) timer.unref();

  startProbeTimer(client, log);
  return first;
}

/**
 * 定时验活（默认 6 小时一次）。
 *
 * 为什么不跟刷新同频（10 分钟）：探活是对 `ads.tiktok.com` 发真请求，
 * 每 10 分钟一次 = 一天 144 次，一个广告账号的 cookie 打出这种规律流量不太好看。
 * 而凭据本身的寿命是 3 天量级，6 小时一次的粒度足够提前预警了。
 */
function startProbeTimer(client, log, seconds) {
  const sec = Math.max(300, Number(seconds || cfg.sessionProbeSeconds) || 21600);
  if (probeTimer) clearInterval(probeTimer);
  probeTimer = setInterval(() => {
    probeAndReport(client, log, { reason: 'timer' })
      .catch((err) => log(`定时验活出错：${err.message}`, 'warn'));
  }, sec * 1000);
  if (probeTimer.unref) probeTimer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
}

/**
 * 「提交」阶段的 10001106 重试包装。
 *
 * ⚠️ **只准包提交，绝不准包轮询**。轮询期间命中 10001106 时上游生成任务
 *    已经建好了，重提 = 建第二单 = 白烧一次额度（结果还会被号池的
 *    `already_final` 丢掉，连报错都不给你看）。这条和 Dify 提交节点
 *    不许开自动重试是同一个教训。
 */
async function withSubmitRetry(fn, { client, log, backend = cfg.sessionBackend } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!isAuthExpired(err)) throw err;

    log(`提交命中 ${LOGIN_REQUIRED_CODE}（会话失效）—— 向号池强刷一次再重试`, 'warn');
    const before = sessioncache.info(backend);
    const r = await refresh(client, log, {
      force: true, reason: 'submit-10001106', probe: true, backend,
    });

    if (!r.ok) {
      const e = new Error(`会话已失效（${LOGIN_REQUIRED_CODE}），且号池没能提供新的：`
        + `${r.error || r.note || '未配置'} —— 请到号池控制台粘贴一份新的凭据`);
      e.cause = err;
      throw e;
    }

    const after = sessioncache.info(backend);
    if (before && after && before.version === after.version) {
      // 号池那份**没变**，说明控制台里还是同一份失效凭据 —— 再重试也是白搭，
      // 直接给一句能指路的话，比让它再炸一次 10001106 有用。
      const e = new Error(`会话已失效（${LOGIN_REQUIRED_CODE}），而号池那份没变`
        + `（还是 v${after.version}）—— 请到号池控制台的「TikTok 会话凭据」`
        + '粘贴一份新的；本地重试没有意义');
      e.cause = err;
      throw e;
    }

    log(`已换到 v${after ? after.version : '?'}，重试提交（此时上游还没有建单，安全）`, 'info');
    return await fn();
  }
}

module.exports = {
  LOGIN_REQUIRED_CODE,
  isAuthExpired,
  refresh,
  probeAndReport,
  start,
  startProbeTimer,
  stop,
  status,
  withSubmitRetry,
};
