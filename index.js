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
 * 环境变量见 README.md；`node index.js` 直接启动，零 npm 依赖。
 */
const http = require('node:http');

const { cfg, loadSession, hasSession } = require('./lib/config');
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
  current: null,          // { taskId, phase, progress, startedAt }
  lastTask: null,         // { taskId, ok, detail, at }
  lastError: null,
  poolOk: null,           // 最近一次号池自检结果
  presence: 'starting',
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
      version: require('./package.json').version,
      uptime_sec: Math.round((Date.now() - state.startedAt) / 1000),
      agent_id: cfg.agentId,
      backends: cfg.backends,
      pool_url: cfg.poolUrl,
      pool_reachable: state.poolOk,
      // ⚠️ 只回布尔，不回令牌本身
      agent_token_set: Boolean(cfg.agentToken),
      session_ready: hasSession(),
      output_mode: cfg.outputMode,
      presence: state.presence,
      claims: state.claims,
      done: state.done,
      failed: state.failed,
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
  const result = await tiktok.poll(session, cfg, submitted.taskId, {
    timeoutMs: cfg.jobTimeoutSeconds * 1000,
    intervalMs: 8000,
    log,
    onTick: (progress) => {
      // 轮询期间给号池打心跳；同时问一句「这活还要不要」
      beat('AGENT_RUNNING', progress);
      return null;
    },
  });

  const meta = result.bestMeta || {};
  log(`  出片 ${result.elapsedSec}s · 最佳档 ${meta.Width}×${meta.Height} ` +
    `(${meta.Format || '?'}, ${meta.Size || '?'}B) · ${result.nVideos} 个变体`);

  // ---- 交付 ----
  let outputUrl = result.bestUrl;
  if (cfg.outputMode === 'mirror') {
    if (!cfg.mirrorUrl) {
      throw new Error('RH_OUTPUT_MODE=mirror 但没配 RH_MIRROR_URL');
    }
    log('  下载成片并转存（mirror 模式）…');
    const bytes = await tiktok.download(result.bestUrl, cfg);
    outputUrl = await mirror(bytes, `${result.taskId}.mp4`);
    log(`  已转存 → ${outputUrl.slice(0, 100)}`);
  }

  return {
    ok: true,
    output_url: outputUrl,
    output_type: 'video',
    output_size: String(meta.Size || ''),
    expire_time: String(result.bestExpire || ''),
    remote_task_id: submitted.taskId,
    // ⚠️ 与既有 agent 保持一致：给**字符串数组**（号池按 JSON 文本落库）
    output_variants: (result.variants || []).map((v) => v.url).filter(Boolean),
    // TikTok 侧扣的是账号额度，拿不到现金价 —— 记 0，别编一个数
    fee: 0,
  };
}

/** 把成片字节交给下游换一个稳定 URL。 */
async function mirror(bytes, filename) {
  const res = await fetch(cfg.mirrorUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...(cfg.mirrorToken ? { Authorization: 'Bearer ' + cfg.mirrorToken } : {}),
    },
    body: bytes,
  });
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
  // ---- 启动自检：令牌不对就别空转 ----
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

  if (!hasSession()) {
    log('⚠️ 未提供会话凭据（RH_SESSION_JSON / RH_SESSION_FILE）—— ' +
      '节点能接单但无法执行。补齐后重启即可。', 'warn');
  } else {
    try {
      const probe = await tiktok.probeSession(loadSession(), cfg);
      log(probe.alive
        ? `会话探活通过（code=${probe.code}）`
        : `🔴 会话已失效（code=${probe.code} ${probe.message}）—— 需要刷新 cookie`, probe.alive ? 'info' : 'error');
    } catch (err) {
      log(`会话探活异常：${err.message}`, 'warn');
    }
  }

  log(`节点启动 agent_id=${cfg.agentId} · 轮询间隔 ${cfg.pollSeconds}s · 输出模式 ${cfg.outputMode}`);

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
      outcome = { ok: false, error: `${err.name || 'Error'}: ${err.message}`.slice(0, 500) };
    }

    if (outcome.ok) {
      state.done += 1;
      log(`  ✅ ${outcome.output_url.slice(0, 110)}`);
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

if (!cfg.agentToken) {
  log('⚠️ 未配置 RH_AGENT_TOKEN —— 号池侧会回 503。请两侧配成同一个值。', 'warn');
}

server.listen(cfg.port, cfg.host, () => {
  log(`HTTP 服务监听 ${cfg.host}:${cfg.port}（/healthz · /status）`);
  loop().catch((err) => log(`取活循环意外退出：${err && err.stack || err}`, 'error'));
});
