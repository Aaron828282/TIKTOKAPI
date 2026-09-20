'use strict';
/**
 * 海外执行节点 —— 入口。
 *
 * 这是什么
 * --------
 * 号池（阿里云北京）**出不了墙**：`ads.tiktok.com` 被 DNS 污染成 2001::1，
 * TCP 永久超时。所以 TikTok 那条链路的数据面被外移到这里 ——
 *
 *     号池（控制面，只排活）
 *        ▲  claim / heartbeat / result        ← 出站拉活，节点不需要开任何入站端口
 *        │
 *     本进程（数据面，有墙外出口）
 *        └─► ads.tiktok.com / ibyteimg / tiktokcdn   （上传 → 提交 → 轮询 → 下载）
 *
 * 为什么同时开一个 HTTP 服务
 * --------------------------
 * 托管平台（Hostinger Web Apps / Render / Railway…）认为「一个监听端口的进程」
 * 才是活着的，会按它的存活情况重启或回收。所以进程 = HTTP 服务 + 后台取活循环：
 * 服务负责被平台看见（`/healthz`）、也顺手给运维一个 `/status` 观测口，
 * 循环负责真正干活。两者同进程、不互相阻塞（全异步 I/O）。
 *
 * 为什么不用浏览器
 * ----------------
 * 实测推翻了「必须靠页面签名」的旧结论：cookie + `x-creative-source` 直连
 * 就能建单、轮询、下载，参考图也能用 SigV4 自己签着传上去。
 * 浏览器只剩「每 ~3 天刷 cookie」这一个用途 —— 而那件事可以在任何地方做。
 *
 * 两个容易漏掉的职责
 * ------------------
 * 1. **取消检测**：号池 heartbeat 回的 `cancelled` 是硬编码 false 的桩，
 *    真正的判定在 `GET /api/v1/agent/task/{id}`。不问，控制台取消了任务
 *    节点也会跑到底 —— 白烧一次上游额度。见 executeTask 里的 peek。
 * 2. **成品转存**：TikTok 的 `MainUrl` 必须带 Referer、且小时级过期，下游
 *    归档不了。交付只能走 mirror（见 README「成品回传」）。
 *
 * 环境变量见 README.md；`node index.js` 直接启动，零 npm 依赖。
 * 改完先跑 `node selftest/offline.js`（假号池 + 假上游，不联网、零额度消耗）。
 */
const http = require('node:http');

const { cfg, loadSession, hasSession, validate } = require('./lib/config');
const { createClient, PoolError } = require('./lib/pool');
const { buildPayload, clampDuration } = require('./lib/payload');
const { uploadImage } = require('./lib/upload');
const tiktok = require('./lib/tiktok');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[cfg.logLevel] || LEVELS.info;

function ts() {
  return new Date().toISOString().slice(11, 19);
}

function log(msg, level = 'info') {
  if ((LEVELS[level] || 20) < MIN_LEVEL) return;
  const tag = level === 'error' ? 'ERR  ' : level === 'warn' ? 'WARN ' : '';
  process.stdout.write(`[${ts()}] ${tag}${msg}\n`);
}

// ---------------------------------------------------------------------------
// 运行态（供 /status 观测，绝不放任何凭据）
// ---------------------------------------------------------------------------
const state = {
  startedAt: Date.now(),
  claims: 0,
  done: 0,
  failed: 0,
  cancelled: 0,           // 被调用方取消（靠 peek 发现）
  current: null,          // { taskId, phase, progress, startedAt }
  lastTask: null,         // { taskId, ok, detail, at }
  lastError: null,
  poolOk: null,           // 最近一次号池自检结果
  presence: 'starting',
  session: null,          // { ok, code, message, at } —— 启动时那次会话探活
  skips: 0,               // peer 次数（观测用，确认取消检测真的在工作）
};

const client = createClient(cfg);

// ---------------------------------------------------------------------------
// HTTP 服务 —— 让托管平台认为进程活着，并给运维一个观测口
// ---------------------------------------------------------------------------
function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (path === '/healthz' || path === '/health') {
    // 平台探活：只要进程还在、配置没缺，就回 200
    json(res, 200, { ok: true, uptime: Math.round((Date.now() - state.startedAt) / 1000) });
    return;
  }

  if (path === '/status') {
    json(res, 200, {
      ok: true,
      node: 'tiktok-exec-node',
      node_version: process.version,
      version: require('./package.json').version,
      uptime_sec: Math.round((Date.now() - state.startedAt) / 1000),
      agent_id: cfg.agentId,
      backends: cfg.backends,
      pool_url: cfg.poolUrl,
      pool_reachable: state.poolOk,
      // ⚠️ 只回布尔，不回令牌本身
      agent_token_set: Boolean(cfg.agentToken),
      session_ready: hasSession(),
      session_probe: state.session,
      // 交付路径能不能用 —— 别等出片才发现收件端没配
      output_mode: cfg.outputMode,
      output_ready: cfg.outputMode !== 'mirror' || Boolean(cfg.mirrorUrl),
      mirror_url_set: Boolean(cfg.mirrorUrl),
      peek_seconds: cfg.peekSeconds,
      pool_ca_set: Boolean(cfg.poolCaFile) || Boolean(cfg.poolInsecure),
      presence: state.presence,
      claims: state.claims,
      done: state.done,
      failed: state.failed,
      cancelled: state.cancelled,
      current: state.current,
      last_task: state.lastTask,
      last_error: state.lastError,
    });
    return;
  }

  if (path === '/') {
    json(res, 200, {
      service: 'tiktok-exec-node',
      endpoints: ['/healthz', '/status'],
      note: '执行节点无对外业务接口；任务由号池派发，本节点出站拉活。',
    });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
});

// ---------------------------------------------------------------------------
// 心跳节流
//
// 号池侧 agent_timeout 默认 900s，30 秒一次足够。但**状态变化必须立刻上报**
// —— 卡在 SUBMITTING 半小时不动的任务，在看板上看不出是在跑还是挂了。
// ---------------------------------------------------------------------------
let hb = { last: 0, fails: 0, tid: '', status: '' };

async function beat(status = null, progress = null) {
  const now = Date.now();
  const forced = Boolean(status) && status !== hb.status;
  if (!forced && now - hb.last < cfg.heartbeatSeconds * 1000) return;
  hb.last = now;

  const body = { task_id: hb.tid, agent_id: cfg.agentId };
  if (status) {
    body.status = status;
    hb.status = status;
    state.current = { ...(state.current || {}), phase: status };
  }
  if (progress !== null && progress !== undefined) {
    body.progress = progress;
    state.current = { ...(state.current || {}), progress };
  }

  try {
    await client.heartbeat(hb.tid, { status, progress, agentId: cfg.agentId });
    hb.fails = 0;
  } catch (err) {
    hb.fails += 1;
    // 心跳连续失败不立刻放弃任务：号池可能只是在重启。
    // 真掉太久它自己会按 agent_timeout 判失败，我们照常把活干完再回报。
    if (hb.fails === 3) log(`心跳连续失败，号池可能不可达；继续跑完并尝试回报`, 'warn');
    if (cfg.logLevel === 'debug') log(`  心跳失败：${err.message}`, 'debug');
  }
}

// ---------------------------------------------------------------------------
// 单个任务的执行
// ---------------------------------------------------------------------------
async function executeTask(task) {
  const spec = task.agent || {};
  const modelId = String(spec.model_id || '');
  if (!modelId) {
    return { ok: false, error: `任务 ${task.task_id} 没带 agent.model_id，无法执行` };
  }

  const session = loadSession();
  const prompt = task.prompt || '';
  const images = (task.image_urls || []).filter(Boolean);
  const duration = clampDuration(task.duration);

  log(`  模型 ${task.model_name || spec.model_key}（${modelId}）· ${duration}s · ${images.length} 张参考图`);

  if (!images.length) {
    return {
      ok: false,
      error: '外部后端需要参考图，且必须是节点能取到的公网地址：请用控制台的「参考图」'
        + '上传本地图片（会先托管到公网），或直接填一个公网可访问的图片地址',
    };
  }

  // ---- 参考图：不在 TikTok 图床的一律重传（上游只收自家素材）----
  await beat('UPLOADING', 2);
  const resolved = [];
  for (let i = 0; i < images.length; i += 1) {
    log(`  参考图 ${i + 1}/${images.length}`);
    resolved.push(await uploadImage(session, cfg, images[i], log));
  }

  // ---- 提交 ----
  const payload = buildPayload(prompt, resolved, modelId, duration);
  await beat('SUBMITTING', 5);
  log(`  提交中（body ${Buffer.byteLength(JSON.stringify(payload))} 字节）…`);
  const submitted = await tiktok.submit(session, cfg, payload, log);

  // ---- 轮询 ----
  await beat('AGENT_RUNNING', 8);
  log('  等待出片 …');

  // 取消检测。
  //
  // ⚠️ 号池 `/agent/heartbeat` 回的 `cancelled` 是**硬编码 false 的桩**
  //    （agent_gateway.py），真正的判定在 `GET /api/v1/agent/task/{id}`。
  //    所以这里必须自己问 —— 不问的话，控制台取消了任务，节点照样跑到底，
  //    白烧一次上游额度（结果会被 `already_final` 丢掉，不出错，但钱花了）。
  //
  // `tiktok.poll` 的 onTick 是同步调用的，所以 peek 用「发出去、下一轮再看」
  // 的写法：不阻塞轮询，也让取消最多晚一个 interval 被发现。
  let cancelFlag = false;
  let peeking = false;
  let lastPeek = 0;

  const result = await tiktok.poll(session, cfg, submitted.taskId, {
    timeoutMs: cfg.jobTimeoutSeconds * 1000,
    intervalMs: 8000,
    log,
    onTick: (progress) => {
      // 轮询期间给号池打心跳（号池按 agent_timeout 给任务收尸，心跳停不得）
      beat('AGENT_RUNNING', progress);

      if (cfg.peekSeconds > 0 && !peeking && Date.now() - lastPeek >= cfg.peekSeconds * 1000) {
        lastPeek = Date.now();
        peeking = true;
        client.peek(task.task_id)
          .then((r) => {
            state.skips += 1;
            if (r && r.cancelled) {
              cancelFlag = true;
              log(`  号池标记该任务不再需要（status=${r.status}）—— 停止轮询`, 'warn');
            }
          })
          .catch((err) => { if (cfg.logLevel === 'debug') log(`  peek 失败：${err.message}`, 'debug'); })
          .finally(() => { peeking = false; });
      }
      return cancelFlag ? { stop: true } : null;
    },
  });

  const meta = result.bestMeta || {};
  log(`  出片 ${result.elapsedSec}s · 最佳档 ${meta.Width}×${meta.Height} ` +
    `(${meta.Format || '?'}, ${meta.Size || '?'}B) · ${result.nVideos} 个变体`);

  // ---- 交付 ----
  let outputUrl = result.bestUrl;
  if (cfg.outputMode === 'mirror') {
    if (!cfg.mirrorUrl) {
      throw new Error('RH_OUTPUT_MODE=mirror 但没配 RH_MIRROR_URL —— '
        + '下游归档不了 TikTok 直链（域名白名单 + 缺 Referer + 小时级过期），'
        + '所以这条任务只能失败；请在节点上补 RH_MIRROR_URL');
    }
    log('  下载成片并转存（mirror 模式）…');
    const bytes = await tiktok.download(result.bestUrl, cfg);
    log(`  已下载 ${(bytes.length / 1048576).toFixed(2)}MB，POST 给收件端 …`);
    // ⚠️ 文件名必须用**号池任务号**（`task.task_id`），不是 `result.taskId`。
    // `result.taskId` 是 TikTok 侧的任务号（也就是回报里的 remote_task_id），
    // 号池把它对客户隐藏，网站拿不到、无法反查用户 —— 收件方按它落库会变成孤儿资产。
    // 号池任务号 = 网站 generation_jobs.upstream_task_id，收件方可以据此确认归属。
    outputUrl = await mirror(bytes, `${task.task_id}.mp4`, task.task_id);
    log(`  已转存 → ${outputUrl.slice(0, 100)}`);
  } else {
    log('  ⚠️ cdn 模式：回报的是 TikTok CDN 直链（需 Referer、小时级过期）。'
      + '下游多半归档不了，这条路径只适合人工验证。', 'warn');
  }

  return {
    ok: true,
    output_url: outputUrl,
    output_type: 'video',
    output_size: String(meta.Size || ''),
    expire_time: String(result.bestExpire || ''),
    remote_task_id: submitted.taskId,
    // 带完整 VideoMeta 的变体数组（号池按 JSON 文本落库、原样取回）。
    // ⚠️ 别压成字符串数组：分辨率阶梯是这条记录唯一的分析价值。
    output_variants: result.variants || [],
    // TikTok 侧扣的是账号额度，拿不到现金价 —— 记 0，别编一个数
    fee: 0,
  };
}

/**
 * 把成片字节交给下游换一个稳定 URL（`RH_OUTPUT_MODE=mirror`）。
 *
 * 为什么必须走这条路，而不是直接把 `MainUrl` 回报上去
 * --------------------------------------------------
 * 号池那边的下游（生视频网站）有三道门，直链一条都过不去：
 *   ① 归档有**域名白名单**（`server/media-hosts.js`），TikTok 的
 *      `v16-ad-creative.tiktokcdn-row.com` 不在里面 → 直接抛错；
 *   ② 归档只发 `Accept`、**不带 `Referer`` → TikTok 必 403；
 *   ③ `UrlExpire` 是**小时级**的，而归档有重试 → 过期后重试永久失败。
 * 所以「把字节搬到下游自己的存储」不是优化，是唯一可行解。
 *
 * `taskId` 是**号池任务号**（= 下游 `generation_jobs.upstream_task_id`），
 * 同时放进 `X-Relay-Task-Id` 头 —— 文件名可能被中间层改写，头更可靠。
 * 收件方应校验这个号确实是它自己下过单的任务，**再由它自己决定落点**
 * （别让上传方指定存储路径，否则等于把别人资产的开写权限交出去）。
 */
async function mirror(bytes, filename, taskId = '') {
  const maxBytes = cfg.mirrorMaxMb * 1024 * 1024;
  if (bytes.length > maxBytes) {
    // 就地失败比传一半被 413 打回好：前者错误信息完整，后者连日志都看不全
    throw new Error(`成片 ${(bytes.length / 1048576).toFixed(2)}MB 超过收件端上限 `
      + `${cfg.mirrorMaxMb}MB —— 收件端有体积闸门（网站侧 25MB），`
      + '调 RH_MIRROR_MAX_MB 前先确认对方也放开了');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(10, cfg.mirrorTimeoutSeconds) * 1000);
  let res;
  try {
    res = await fetch(cfg.mirrorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="${filename}"`,
        ...(taskId ? { 'X-Relay-Task-Id': String(taskId) } : {}),
        ...(cfg.mirrorToken ? { Authorization: 'Bearer ' + cfg.mirrorToken } : {}),
      },
      body: bytes,
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(`转存请求失败（${cfg.mirrorUrl}）：${err.name === 'AbortError'
      ? `超过 ${cfg.mirrorTimeoutSeconds}s 未完成` : err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`转存失败 HTTP ${res.status}：${text.slice(0, 200)}`);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 允许纯文本 URL */ }
  const url = typeof parsed === 'string' ? parsed
    : (parsed && (parsed.output_url || parsed.url)) || (/^https?:\/\/\S+$/.test(text.trim()) ? text.trim() : '');
  if (!url) throw new Error(`转存响应里找不到 URL：${text.slice(0, 200)}`);
  return url;
}

async function report(taskId, payload) {
  try {
    const r = await client.result({ task_id: taskId, ...payload });
    log(`  回报完成 → ${r.status}${r.already_final ? '（号池已有终态，未覆盖）' : ''}`);
    return r;
  } catch (err) {
    // 回报失败不重试循环：号池侧有 agent_timeout 兜底，且 result 本身幂等，
    // 下一次任务完成时会自然被发现。但要留痕。
    log(`  回报失败：${err.message}`, 'error');
    return null;
  }
}

// ---------------------------------------------------------------------------
// 取活循环
// ---------------------------------------------------------------------------
let stopping = false;

async function loop() {
  // ---- 启动自检 0：配置 ----
  // 先把「缺什么、会以什么形式坏掉」一次说全。这台机器上可观测性有限
  // （托管平台只给一个日志面板），别让人靠猜。
  const v = validate();
  for (const m of v.fatal) log(`🔴 配置致命：${m}`, 'error');
  for (const m of v.warn) log(`⚠️ 配置提示：${m}`, 'warn');
  if (v.fatal.length) log('（进程继续运行以便控制台看得见，但上面的问题不解决就干不成活）', 'error');

  // ---- 启动自检 1：令牌对不对 ----
  try {
    const st = await client.stats();
    state.poolOk = true;
    state.presence = 'idle';
    log(`号池在线 ${cfg.poolUrl} · 后端 ${JSON.stringify(st.backends)} · ` +
      `待接单 ${st.pending_agent} · 执行中 ${st.agent_running}`);
  } catch (err) {
    state.poolOk = false;
    state.presence = 'pool_error';
    state.lastError = err.message;
    log(`号池自检失败：${err.message}`, 'error');
    if (err instanceof PoolError) {
      if (err.status === 503) {
        log('  号池未配置 agent_token（AGENT_DISABLED）—— 先在号池侧 config.json 配上再重试。', 'error');
      } else if (err.status === 401) {
        log('  令牌不匹配（AGENT_UNAUTHORIZED）—— 本节点与号池的 agent_token 必须一致。', 'error');
      }
    }
    // 不退出：号池侧可能还在配置中。平台会把我们拉起来，保持监听并重试更稳。
  }

  // ---- 启动自检 2：会话还活着吗 ----
  if (!hasSession()) {
    log('⚠️ 未提供会话凭据（RH_SESSION_JSON / RH_SESSION_FILE）—— ' +
      '节点能接单但无法执行。补齐后重启即可。', 'warn');
  } else {
    try {
      const probe = await tiktok.probeSession(loadSession(), cfg);
      state.session = { ok: probe.alive, code: probe.code, message: probe.message, at: Date.now() };
      log(probe.alive
        ? `会话探活通过（code=${probe.code}）`
        : `🔴 会话已失效（code=${probe.code} ${probe.message}）—— 需要刷新 cookie`, probe.alive ? 'info' : 'error');
    } catch (err) {
      state.session = { ok: null, code: null, message: err.message, at: Date.now() };
      log(`会话探活异常：${err.message}`, 'warn');
    }
  }

  log(`节点启动 agent_id=${cfg.agentId} · 轮询间隔 ${cfg.pollSeconds}s · `
    + `输出模式 ${cfg.outputMode} · 取消检测 ${cfg.peekSeconds ? `${cfg.peekSeconds}s` : '关闭'}`);

  while (!stopping) {
    let task = null;
    try {
      const got = await client.claim(cfg.agentId, cfg.backends);
      task = got && got.task;
    } catch (err) {
      state.lastError = err.message;
      log(`领取任务失败：${err.message}`, 'warn');
      await tiktok.sleep(cfg.pollSeconds * 1000);
      continue;
    }

    if (!task) {
      await tiktok.sleep(cfg.pollSeconds * 1000);
      continue;
    }

    const tid = task.task_id;
    state.claims += 1;
    state.presence = 'busy';
    state.current = { taskId: tid, phase: 'claimed', progress: 0, startedAt: Date.now() };
    hb = { last: 0, fails: 0, tid, status: '' };

    log(`领到任务 ${tid} · ${task.model_name} · ${task.duration}s · ` +
      `prompt=${String(task.prompt || '').slice(0, 40)}…`);

    let outcome;
    try {
      outcome = await executeTask(task);
    } catch (err) {
      outcome = {
        ok: false,
        cancelled: Boolean(err && err.cancelled),
        error: `${err.name || 'Error'}: ${err.message}`.slice(0, 500),
      };
    }

    if (outcome.ok) {
      state.done += 1;
      log(`  ✅ ${outcome.output_url.slice(0, 110)}`);
    } else if (outcome.cancelled) {
      // 取消不是故障：调用方已经自己把任务标成终态，号池会回 already_final。
      state.cancelled += 1;
      log(`  ⏹ 已按调用方要求停止：${outcome.error}`, 'warn');
    } else {
      state.failed += 1;
      log(`  ❌ 失败：${outcome.error}`, 'error');
    }

    state.lastTask = {
      taskId: tid,
      ok: outcome.ok,
      detail: outcome.ok ? outcome.output_url.slice(0, 160) : outcome.error,
      at: Date.now(),
    };
    await report(tid, outcome);
    state.current = null;
    state.presence = 'idle';
  }
}

// ---------------------------------------------------------------------------
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，停止取活并退出 …`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log(`未处理的 Promise 拒绝：${err}`, 'error'));

log(`tiktok-exec-node v${require('./package.json').version} · Node ${process.version} · `
  + `主机 ${require('node:os').hostname()}`);

server.listen(cfg.port, cfg.host, () => {
  log(`HTTP 服务监听 ${cfg.host}:${cfg.port}（/healthz · /status）`);
  loop().catch((err) => log(`取活循环意外退出：${err && err.stack || err}`, 'error'));
});
