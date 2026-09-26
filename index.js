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
 * 浏览器只剩「每 ~3 天刷 cookie」这一个用途 —— 而那件事可以在任何地方做，
 * **今天就在号池控制台做**（见下）。
 *
 * 凭据来源（2026-09-20 改造）
 * --------------------------
 * 广告线会话 TTL 只有 3 天，「换 cookie」是**每 3 天一次的日常动作**，
 * 不是一次性的部署配置。所以凭据的持有者不在这个进程里 —— 号池持有、
 * 控制台切换，本进程按版本号按需索取（`lib/sessionruntime.js`）。
 * 换 cookie 不再需要碰这个节点的任何环境变量、更不需要重新部署。
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

const { cfg, loadSession, hasSession, validate, sessionStatus, sessionOrigin } = require('./lib/config');
const { normalizeSession, normalizeAiSession } = require('./lib/session');
const { createClient, PoolError } = require('./lib/pool');
const { buildPayload, buildImagePayload, clampDuration } = require('./lib/payload');
const { uploadImage, uploadVideo } = require('./lib/upload');
const sessionruntime = require('./lib/sessionruntime');
const tiktok = require('./lib/tiktok');
const failure = require('./lib/failure');
const aistudio = require('./lib/aistudio');

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
  active: new Map(),      // taskId → { taskId, phase, progress, startedAt, worker, account }
  lastTask: null,         // { taskId, ok, detail, at }
  lastError: null,
  poolOk: null,           // 最近一次号池自检结果
  presence: 'starting',
  skips: 0,               // peer 次数（观测用，确认取消检测真的在工作）
};

// ---------------------------------------------------------------------------
// 崩溃观测（2026-09-24）：进程若死于未捕获异常，stdout 只留在托管平台面板里、
// 重启后无处可查 —— 离线反复发作时根因永远成谜。把崩溃堆栈与启动计数持久化到
// 本地 logs/，并经 /status 远程可见。所有 IO 吞错：观测绝不能反过来弄死进程。
// ---------------------------------------------------------------------------
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const crashDir = nodePath.join(process.cwd(), 'logs');
const crashFile = nodePath.join(crashDir, 'crash.log');
const bootFile = nodePath.join(crashDir, 'boot-count');
function crashAppend(line) {
  try {
    nodeFs.mkdirSync(crashDir, { recursive: true });
    nodeFs.appendFileSync(crashFile, line + '\n');
    // 日志封顶：超过 512KB 只留最近一半，避免常年运行无限膨胀。
    const st = nodeFs.statSync(crashFile);
    if (st.size > 512 * 1024) {
      const lines = nodeFs.readFileSync(crashFile, 'utf8').trim().split('\n');
      nodeFs.writeFileSync(crashFile, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
  } catch { /* 观测失败不致命 */ }
}
let bootCount = 0;
let lastCrashLine = '';
try { bootCount = Number(nodeFs.readFileSync(bootFile, 'utf8').trim()) || 0; } catch { }
try { nodeFs.mkdirSync(crashDir, { recursive: true }); nodeFs.writeFileSync(bootFile, String(bootCount + 1)); } catch { }
crashAppend(`[${ts()}] BOOT v${require('./package.json').version} pid=${process.pid} boot#${bootCount + 1} node=${process.version}`);
try {
  const tailLines = nodeFs.readFileSync(crashFile, 'utf8').trim().split('\n');
  lastCrashLine = [...tailLines].reverse().find((line) => line.includes(' CRASH ')) || '';
} catch { }

/**
 * 会话的两块观测信息 —— **现算**，不做状态缓存。
 *
 * 为什么现算：凭据会在**运行中**被换掉（控制台改了 → 定时刷新拉到新的）。
 * 早先这两块是在启动时算一次就塞进 `state` 的，结果是热切换之后
 * `/status` 里的「还剩多久」和「验活结论」永远停在启动那一刻 ——
 * 一个**看起来在更新、其实是旧结论**的观测口，比没有更坏。
 */
function sessionView() {
  const st = sessionStatus();
  const s = sessionruntime.status();
  return {
    lifetime: st
      ? { level: st.level, note: st.note, remain: st.lifetime && st.lifetime.remain }
      : null,
    probe: s.probeAt
      ? { ok: s.probeOk, code: s.probeCode, at: s.probeAt }
      : null,
  };
}

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
    // 观测口绝不能 500（托管平台会把它当进程死了）。任何字段计算炸了都降级成
    // 200 + error 说明 —— 观测挂掉比观测缺一块更害人。
    try {
      const sess = sessionView();
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
      session_probe: sess.probe,
      // 「还剩多久」—— 广告线 TTL 只有 3 天，这是唯一能提前预警的字段
      session_lifetime: sess.lifetime,
      // 凭据是哪来的：'cache'（号池控制台）/'env'（托管面板）。
      // 决定了换 cookie 要去哪儿操作 —— 这两个地方的处置路径完全不同。
      session_source: cfg.sessionSource,
      session_origin: sessionOrigin(),
      session_backend: cfg.sessionBackend,
      session_pool: sessionruntime.status(),
      // 交付路径能不能用 —— 别等出片才发现收件端没配
      output_mode: cfg.outputMode,
      output_ready: cfg.outputMode !== 'mirror' || Boolean(cfg.mirrorUrl),
      mirror_url_set: Boolean(cfg.mirrorUrl),
      peek_seconds: cfg.peekSeconds,
      pool_ca_set: Boolean(cfg.poolCaFile) || Boolean(cfg.poolInsecure),
      presence: state.presence,
      // 并发观测（lease 版）：running = 正在执行的任务数，active = 每条的明细
      mode: 'lease',
      concurrency: cfg.maxConcurrent,
      running: state.active.size,
      active: [...state.active.values()],
      // 兼容旧观测口：取第一条在跑的
      current: state.active.size ? [...state.active.values()][0] : null,
      claims: state.claims,
      done: state.done,
      failed: state.failed,
      cancelled: state.cancelled,
      last_task: state.lastTask,
      last_error: state.lastError,
      // 崩溃观测（2026-09-24）：启动次数与最近一次崩溃原因 —— 离线复发时远程即可看根因
      boot_count: bootCount,
      last_crash: lastCrashLine || null,
      mem_rss_mb: Math.round(process.memoryUsage().rss / 1048576),
      });
    } catch (err) {
      json(res, 200, { ok: true, status_error: err.message,
        uptime_sec: Math.round((Date.now() - state.startedAt) / 1000) });
    }
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
// lease 版并发执行：心跳状态是**每任务一份**（hb 闭包在 beater 里），
// 状态变化同步写进 state.active 里那条的 phase/progress。
// ---------------------------------------------------------------------------
function makeBeater(taskId, active) {
  const hb = { last: 0, fails: 0, status: '' };
  return async function beat(status = null, progress = null) {
    const now = Date.now();
    const forced = Boolean(status) && status !== hb.status;
    if (!forced && now - hb.last < cfg.heartbeatSeconds * 1000) return;
    hb.last = now;

    if (status) {
      hb.status = status;
      active.phase = status;
    }
    if (progress !== null && progress !== undefined) active.progress = progress;

    try {
      await client.heartbeat(taskId, { status, progress, agentId: cfg.agentId });
      hb.fails = 0;
    } catch (err) {
      hb.fails += 1;
      // 心跳连续失败不立刻放弃任务：号池可能只是在重启。
      // 真掉太久它自己会按 agent_timeout 判失败，我们照常把活干完再回报。
      if (hb.fails === 3) log(`心跳连续失败，号池可能不可达；继续跑完并尝试回报`, 'warn');
      if (cfg.logLevel === 'debug') log(`  心跳失败：${err.message}`, 'debug');
    }
  };
}

// ---------------------------------------------------------------------------
// 单个任务的执行
// ---------------------------------------------------------------------------
async function executeTask(task, session, beat, { lease = false, accountId = null } = {}) {
  const backend = task.backend || cfg.sessionBackend;

  // AI Studio 生图（backend=aistudio_image）：完全不同的执行面 ——
  // Playwright 常驻会话内 UI 提交（令牌绑定提示词，必须页面现签），
  // 与 TikTok 的「直连 + 轮询」没有可复用的提交/轮询代码，整体分流。
  if (backend === 'aistudio_image') {
    return executeAistudio(task, session, beat, { lease, accountId });
  }

  const spec = task.agent || {};
  const modelId = String(spec.model_id || '');
  if (!modelId) {
    // 提前 return 也要带分类 —— 否则这类失败在号池里又是「FAILED 但 error_kind 为空」，
    // 等于把刚补上的「分不清」问题在另一条分支上重新打开。
    return failure.localFailure(failure.KIND.PARAM,
      `任务 ${task.task_id} 没带 agent.model_id，无法执行`);
  }

  const prompt = task.prompt || '';
  const images = (task.image_urls || []).filter(Boolean);
  // 参考视频（2026-09-23，网站打码链路）：号池把 params.video_urls 带回在
  // task.video_urls —— 打码+静音后的对标视频直链，上传 TikTok 视频库后作为
  // R2V 视频参考进生成请求体（mentions type=2）。
  const videoRefs = (task.video_urls || []).filter(Boolean);
  const duration = clampDuration(task.duration);
  // Nano Banana 生图（2026-09-23 接入）：号池不下发 kind 字段，节点按
  // model_key 认（config.json external_backends.tiktok_r2v 里的 key）。
  // 与视频共用同一 backend / 账号池 / 槽位 —— 差异只在提交路径与结果形态。
  const isImageJob = String(spec.kind || '') === 'i2i_image'
    || String(spec.model_key || '').toLowerCase() === 'nano_banana';

  log(`  模型 ${task.model_name || spec.model_key}（${modelId}）· ${duration}s · `
    + (isImageJob ? '生图模式（一次多张）· '
      : '')
    + (images.length ? `${images.length} 张参考图` : '无参考图')
    + (videoRefs.length ? ` · ${videoRefs.length} 条参考视频` : ''));

  // 生图：prompt 必填、参考图可空（实测 images:[] 即纯文生图）。
  // 视频：prompt 与参考图不能同时为空。
  if (isImageJob ? !prompt.trim() : (!prompt.trim() && !images.length)) {
    return failure.localFailure(failure.KIND.PARAM,
      isImageJob ? '生图任务提示词不能为空' : '提示词与参考图不能同时为空：至少填写提示词，或上传参考图');
  }

  // ---- 参考图 + 提交 ----
  //
  // 这一段被包在 withSubmitRetry 里：**只有这里**允许因会话失效（10001106）
  // 强刷凭据后重来一次 —— 因为此时上游还没有建单，重试不会造成第二次消耗。
  // 轮询阶段（下面）绝不重试，理由见那里。
  const uploadAndSubmit = async () => {
    // legacy 模式：每次**重新读一遍**全局会话缓存 —— 10001106 强刷后 withSubmitRetry
    //    的重试路径必须拿到新凭据，用闭包里捕获的旧 session 会让「重试」变成原样再撞一次墙。
    // lease 模式：会话随租约绑定账号（task.session），重读全局缓存反而会拿到**别的号**。
    const sess = lease ? session : loadSession(backend);

    await beat('UPLOADING', 2);
    const resolved = [];
    for (let i = 0; i < images.length; i += 1) {
      log(`  参考图 ${i + 1}/${images.length}`);
      resolved.push(await uploadImage(sess, cfg, images[i], log));
    }
    // 参考视频：先传 TikTok 视频库拿 vid/previewUrl，再进 wire（硬失败——
    // 打码链路的视频传不上去就该让任务失败，而不是悄悄退化成无参考生成）。
    const videoMeta = [];
    for (let i = 0; i < videoRefs.length; i += 1) {
      log(`  参考视频 ${i + 1}/${videoRefs.length}`);
      videoMeta.push(await uploadVideo(sess, cfg, videoRefs[i], log));
    }

    const payload = isImageJob
      ? buildImagePayload(prompt, resolved, modelId)
      : buildPayload(prompt, resolved, modelId, duration, videoMeta);
    await beat('SUBMITTING', 5);
    log(`  提交中（body ${Buffer.byteLength(JSON.stringify(payload))} 字节）…`);
    return {
      submitted: isImageJob
        ? await tiktok.submitImage(sess, cfg, payload, log)
        : await tiktok.submit(sess, cfg, payload, log),
      session: sess,
    };
  };

  // legacy：唯一允许的会话失效重试点（强刷全局凭据后重试一次，此时上游未建单，安全）。
  // lease：会话绑定账号，全局强刷毫无意义 —— 失效直接往外抛，由 runTask 做换号重试。
  const submitOutcome = lease
    ? await uploadAndSubmit()
    : await sessionruntime.withSubmitRetry(uploadAndSubmit, { client, log, backend });
  const { submitted, session: pollSession } = submitOutcome;

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

  // 轮询 onTick：心跳 + 取消检测，生图与视频共用一套（peek 逻辑见下）。
  const imageOrVideoTick = () => (progress) => {
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
  };

  let result;
  try {
    result = await (isImageJob
      ? tiktok.pollImage(pollSession, cfg, submitted.taskId, submitted.expectedDrafts, {
        timeoutMs: cfg.jobTimeoutSeconds * 1000,
        intervalMs: 6000,
        log,
        onTick: imageOrVideoTick(),
      })
      : tiktok.poll(pollSession, cfg, submitted.taskId, {
        timeoutMs: cfg.jobTimeoutSeconds * 1000,
        intervalMs: 8000,
        log,
        onTick: imageOrVideoTick(),
      }));
  } catch (err) {
    // 🔴 无论哪种失败，先把**上游任务号**挂上再往外抛。
    //    能走到这里说明建单已经成功、上游额度已经扣了 —— 失败路径上一旦丢掉
    //    `remote_task_id`，事后既没法跟 TikTok 侧对账、也没法申诉。
    //    改造前只有成功路径带它，失败任务在号池里是一片空白（连上游号都没有）。
    if (err && !err.remoteTaskId && submitted && submitted.taskId) {
      err.remoteTaskId = submitted.taskId;
    }
    if (!sessionruntime.isAuthExpired(err)) throw err;

    // 🔴 轮询期间会话失效 —— **绝不重新提交**。
    // 上游的生成任务此刻已经建好了（钱已经花了），重提等于建第二单：
    // 白烧一次额度，而号池那边因为已有终态会把第二次结果直接丢掉 ——
    // 花了钱、连个报错都看不见。这与「Dify 提交节点不许开自动重试」同源。
    // lease 模式没有「全局强刷」可做（会话绑定账号，cookie 死了只能换号或换 cookie）。
    log('轮询期间会话失效 —— '
      + (lease ? '该账号的 cookie 已失效' : '向号池刷新凭据并回报状态') + '；'
      + '**不重新提交**（上游任务已建单，重提只会造成第二次消耗）', 'warn');
    if (!lease) {
      await sessionruntime.refresh(client, log, {
        force: true, reason: 'poll-10001106', probe: true, backend,
      });
    }
    const e = new Error(`${err.message} —— 上游任务已建单，未重新提交（避免重复消耗）。`
      + (lease ? '请到号池控制台给对应账号更换 cookie' : '请到号池控制台换一份会话凭据')
      + '，这条订单需要重新发起');
    e.cause = err;
    // 把上游任务号与业务码**带过这一层**：新造的错误默认什么都不继承，
    // 漏掉就等于把「上游已经建单」这个事实又丢了一次。
    e.remoteTaskId = err.remoteTaskId;
    e.upstreamCode = err.upstreamCode;
    throw e;
  }

  // ---- 生图交付（与视频分叉）----
  //
  // TikTok 图片 CDN 在国内被 DNS 污染（2026-09-23 实测
  // p16-ad-site-sign-sg.tiktokcdn.com 解析到 Dropbox 的 IP），下游网站直抓
  // **必然失败** —— 与视频同理，mirror 转存是唯一可行交付路径。
  // 节点逐张下载后上传收件端（X-Relay-Part-Index 标序号），换回站内签名 URL
  // 回报；任一张转存失败则整单降级直链交付（链路可达性由下游自负）。
  if (isImageJob) {
    const urls = result.urls || [];
    log(`  出图 ${result.elapsedSec}s · ${urls.length} 张`);
    let outputUrls = urls;
    let archived = false;
    let archiveNote = '';
    if (cfg.outputMode === 'mirror' && cfg.mirrorUrl) {
      try {
        const mirrored = [];
        for (let i = 0; i < urls.length; i += 1) {
          const bytes = await tiktok.downloadImage(urls[i], cfg);
          log(`  转存 ${i + 1}/${urls.length}（${(bytes.length / 1048576).toFixed(2)}MB）…`);
          mirrored.push(await mirror(bytes, `${task.task_id}-${i + 1}.png`, task.task_id, {
            partIndex: i + 1,
            contentType: 'image/png',
          }));
        }
        outputUrls = mirrored;
        archived = true;
      } catch (err) {
        archiveNote = `图片转存失败（${err.message}）—— 已降级为直链交付`;
        log('  ⚠️ ' + archiveNote, 'warn');
      }
    } else {
      archiveNote = 'mirror 未配置 —— 已降级为直链交付（下游直抓 TikTok 图片 CDN 会被 DNS 污染挡住）';
      log('  ⚠️ ' + archiveNote, 'warn');
    }
    return {
      ok: true,
      output_url: outputUrls[0] || '',
      output_type: 'image',
      output_size: '',
      expire_time: '',
      remote_task_id: submitted.taskId,
      output_variants: urls.map((direct, i) => ({
        url: outputUrls[i] || direct,
        direct_url: direct,
        archived: Boolean(outputUrls[i] && archived),
      })),
      archived,
      archive_note: archiveNote,
      // TikTok 侧扣的是账号生图额度，拿不到现金价 —— 记 0，别编一个数
      fee: 0,
    };
  }

  const meta = result.bestMeta || {};
  log(`  出片 ${result.elapsedSec}s · 最佳档 ${meta.Width}×${meta.Height} ` +
    `(${meta.Format || '?'}, ${meta.Size || '?'}B) · ${result.nVideos} 个变体`);

  // ---- 交付 ----
  //
  // 🔴 交付失败 ≠ 任务失败。走到这里片子已经生成、上游额度**已经扣了**，
  //    因为「搬不回自己的存储」就把整条任务判失败，是最差的结果：
  //    钱花了、成品丢了、连上游任务号都没回报，事后无法追溯。
  //    所以两个失败分支（没配 RH_MIRROR_URL / 收件端拒绝）都**降级为直链交付**，
  //    任务照常成功，只是 `archived=false`。
  let outputUrl = result.bestUrl;
  let archived = false;
  let archiveNote = '';
  if (cfg.outputMode === 'mirror') {
    if (!cfg.mirrorUrl) {
      archiveNote = 'RH_OUTPUT_MODE=mirror 但未配 RH_MIRROR_URL —— 已降级为直链交付；'
        + '下游归档会失败（域名白名单 / 缺 Referer / 小时级过期），请补 RH_MIRROR_URL';
      log('  ⚠️ ' + archiveNote, 'warn');
    } else {
      try {
        log('  下载成片并转存（mirror 模式）…');
        const bytes = await tiktok.download(result.bestUrl, cfg);
        log(`  已下载 ${(bytes.length / 1048576).toFixed(2)}MB，POST 给收件端 …`);
        // ⚠️ 文件名必须用**号池任务号**（`task.task_id`），不是 `result.taskId`。
        // `result.taskId` 是 TikTok 侧的任务号（也就是回报里的 remote_task_id），
        // 号池把它对客户隐藏，网站拿不到、无法反查用户 —— 收件方按它落库会变成孤儿资产。
        // 号池任务号 = 网站 generation_jobs.upstream_task_id，收件方可以据此确认归属。
        outputUrl = await mirror(bytes, `${task.task_id}.mp4`, task.task_id);
        archived = true;
        log(`  已转存 → ${outputUrl.slice(0, 100)}`);
      } catch (err) {
        archiveNote = `转存失败（${err.message}）—— 已降级为直链交付，任务仍算成功`;
        log('  ⚠️ ' + archiveNote, 'warn');
      }
    }
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
    // 归档状态单独报出来：号池据此能区分「成品在自己存储里」与「只是个会过期的直链」。
    // 号池侧若不认这个键会直接忽略，不影响兼容。
    archived,
    archive_note: archiveNote,
    // TikTok 侧扣的是账号额度，拿不到现金价 —— 记 0，别编一个数
    fee: 0,
  };
}

// ---------------------------------------------------------------------------
// AI Studio 生图执行（backend=aistudio_image）
//
// 执行面 = Playwright 常驻会话（每账号一个持久 profile + 至多 aistudioTabs 个
// 工作页）。令牌绑定提示词 ⟹ 页面现签；令牌不绑配置 ⟹ 拦截器在途改写 4K。
// 产物是原始字节（无上游 URL），交付复用 mirror 通道换站内稳定 URL。
// ---------------------------------------------------------------------------
const aistudioPool = new aistudio.AistudioPool(cfg, log);

async function executeAistudio(task, session, beat, { lease = false, accountId = null } = {}) {
  const prompt = String(task.prompt || '').trim();
  if (!prompt) {
    return failure.localFailure(failure.KIND.PARAM, '生图任务提示词不能为空');
  }
  if (!lease || !accountId) {
    // legacy 回落（账号池为空时借用全局会话）对 AI Studio 没有意义：
    // 没有账号 id 就没有 profile 目录与额度归属。fail fast 让号池把原因记下来。
    return failure.localFailure(failure.KIND.PARAM,
      'AI Studio 生图必须走账号租约执行（号池账号池为空，未配置 Google 账号）');
  }

  const cookieStr = (session && session.cookie) || '';
  const acct = aistudioPool.get(accountId, cookieStr);

  await beat('AGENT_RUNNING', 5);
  log(`  [ai#${accountId}] 提交页面生成：prompt=${prompt.slice(0, 50)}…`);
  let images;
  try {
    images = await acct.generate({ prompt });
  } catch (err) {
    // cookie 失效要让号池看见（控制台标红 + 换号重试）。AuthExpiredError 带
    // upstreamCode=10001106，runTask 的 failover 会认出并走换号路径。
    if (err.authExpired) {
      log(`  [ai#${accountId}] Google cookie 失效：${err.message}`, 'warn');
    }
    throw err;
  }

  // 响应含 预览图 + 4K 成图 —— 交付最大的那张（用户口径：1 次调用 = 1 张 4K）
  const best = images.slice().sort((a, b) => b.base64.length - a.base64.length)[0];
  const bytes = Buffer.from(best.base64, 'base64');
  log(`  [ai#${accountId}] 出图 ${images.length} 张，取最大 ${(bytes.length / 1048576).toFixed(2)}MB 转存…`);

  await beat('UPLOADING', 92);
  const ext = /png/i.test(best.contentType) ? 'png' : 'jpg';
  // 与视频同理：mirror 未配置时降级等于成品丢失（字节在本地内存里没有 URL 可给），
  // 所以这里对 mirror 失败**不降级**，直接报错 —— fail closed。
  if (!cfg.mirrorUrl) {
    return failure.localFailure(failure.KIND.UPSTREAM_ERROR,
      '图已生成但 RH_MIRROR_URL 未配置，成品无处转存 —— 请在节点环境补齐交付端点');
  }
  const outputUrl = await mirror(bytes, `${task.task_id}.${ext}`, task.task_id, {
    contentType: best.contentType,
  });
  log(`  [ai#${accountId}] 已转存 → ${outputUrl.slice(0, 100)}`);

  return {
    ok: true,
    output_url: outputUrl,
    output_type: 'image',
    output_size: String(bytes.length),
    archived: true,
    archive_note: '',
    // 生图无上游远端任务号（同步 RPC），别编 —— 留空
    remote_task_id: '',
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
async function mirror(bytes, filename, taskId = '', { partIndex = 0, contentType = 'video/mp4' } = {}) {
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
        'Content-Type': contentType,
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="${filename}"`,
        ...(taskId ? { 'X-Relay-Task-Id': String(taskId) } : {}),
        ...(partIndex >= 1 ? { 'X-Relay-Part-Index': String(partIndex) } : {}),
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

  // ---- 启动自检 2：会话凭据 —— 先向号池取，再验活 ----
  //
  // 取 / 验 / 回报三步都在 sessionruntime 里，这里只把结论写进启动日志。
  // 顺序很重要：**先取**。凭据的持有者是号池，本地环境变量只是兜底，
  // 所以「本地没配」在 auto/pool 模式下不是问题，「号池也没有」才是。
  const sr = await sessionruntime.start(client, log);

  if (!hasSession()) {
    if (cfg.sessionSource === 'env') {
      log('⚠️ RH_SESSION_SOURCE=env，且本地没有可用凭据 —— 节点能接单但无法执行。',
        'warn');
    } else {
      log(`⚠️ 号池没有可用的会话凭据${sr && sr.note ? `（${sr.note}）` : ''} —— `
        + '节点能接单但无法执行。到号池控制台的「TikTok 会话凭据」粘贴一份即可，'
        + '不需要改这个节点的环境变量、更不用重新部署。', 'warn');
    }
  } else {
    // 先把「还剩多久」讲清楚。广告线 TTL 只有 3 天，这个数字比「探活通过」
    // 更早预警 —— 探活只告诉你「现在还活着」，剩 2 小时它也这么说。
    const st = sessionStatus();
    const origin = sessionOrigin();
    if (st) {
      const tag = st.level === 'dead' ? '🔴' : (st.level === 'warn' ? '⚠️' : '·');
      log(`${tag} ${st.note}（cookie ${st.cookieKeys.length} 键 · 来源 ${origin === 'cache'
        ? '号池控制台' : '本地环境变量'}）`,
      st.level === 'ok' ? 'info' : (st.level === 'warn' ? 'warn' : 'error'));
    }

    // 拿到新凭据时 start() 内部已经验活并回报过；只有「没换、纯重启」时才补一次，
    // 否则控制台上那个「有效 / 已失效」的结论会一直停在上次的时点。
    // （结论不在这里落状态 —— /status 是现算的，见 sessionView()。）
    if (!(sr && sr.changed)) {
      await sessionruntime.probeAndReport(client, log, { reason: 'startup' });
    }
  }

  log(`节点启动 agent_id=${cfg.agentId} · 轮询间隔 ${cfg.pollSeconds}s · `
    + `输出模式 ${cfg.outputMode} · 取消检测 ${cfg.peekSeconds ? `${cfg.peekSeconds}s` : '关闭'}`);
  log(`会话凭据：来源策略 ${cfg.sessionSource} · 当前来自 `
    + `${sessionOrigin() === 'cache' ? '号池控制台' : '本地环境变量'} · `
    + `每 ${cfg.sessionRefreshSeconds}s 向号池问一次变更 · 每 `
    + `${Math.round(cfg.sessionProbeSeconds / 3600)}h 验活一次`);

  // ---- 并发取活 ----
  //
  // lease 版：maxConcurrent 个 worker 各自「claim → 租号 → 执行 → 还槽 → 回报」。
  // 每个任务在 lease 那一刻绑定一个账号（占一个槽位），同一账号最多
  // max_slots 个任务同时跑 —— 号池控制台的「账号槽位」「并发槽位」两块
  // 显示的就是这套租约的实时状态。
  log(`并发 worker × ${cfg.maxConcurrent}（RH_MAX_CONCURRENT 可调；`
    + `单账号并发上限 5，多账号时建议设为 账号数 × 5）`);
  const workers = [];
  for (let i = 1; i <= cfg.maxConcurrent; i += 1) {
    workers.push(workerLoop(i));
  }
  await Promise.all(workers);
}

/** 单个 worker：空闲时轮询 claim，领到就交给 runTask 串完整条生命周期。 */
async function workerLoop(workerId) {
  while (!stopping) {
    let task = null;
    try {
      const got = await client.claim(cfg.agentId, cfg.backends);
      task = got && got.task;
    } catch (err) {
      state.lastError = err.message;
      log(`[${workerId}] 领取任务失败：${err.message}`, 'warn');
      await tiktok.sleep(cfg.pollSeconds * 1000);
      continue;
    }

    if (!task) {
      await tiktok.sleep(cfg.pollSeconds * 1000);
      continue;
    }

    await runTask(task, workerId);
  }
}

/**
 * 执行单个任务的完整生命周期：租号 → 执行 → 还槽 → 回报。
 *
 * 租号语义（对齐 agent_gateway.py 的 /session/lease）：
 *   · ok:false = 池子空或全忙，**不是错误** —— 等一会儿再试，任务不能判失败；
 *   · 池子里一个号都没有（pool.total === 0）→ 回落 legacy 全局会话模式，
 *     与旧版节点行为一致（单凭据 + withSubmitRetry）；
 *   · 提交阶段命中 10001106 且上游未建单 → 标记该账号失效、还槽、
 *     **换号重试一次**（exclude 排除刚失败的号）。
 */
async function runTask(task, workerId) {
  const tid = task.task_id;
  const backend = task.backend || cfg.sessionBackend;
  state.claims += 1;

  const active = {
    taskId: tid, phase: 'claimed', progress: 0,
    startedAt: Date.now(), worker: workerId, account: '',
  };
  state.active.set(tid, active);
  state.presence = 'busy';
  const beat = makeBeater(tid, active);

  log(`[${workerId}] 领到任务 ${tid} · ${task.model_name} · ${task.duration}s · `
    + `prompt=${String(task.prompt || '').slice(0, 40)}…`);

  // ---- 租一个账号（占槽位）。幂等：同 task 再租返回原账号。 ----
  const LEASE_WAIT_MS = 15 * 60 * 1000;   // 全忙时的最长等待；超时按执行失败处理
  let account = null;                      // { id, label }
  let session = null;                      // 租约带来的账号会话
  let lease = false;
  {
    const deadline = Date.now() + LEASE_WAIT_MS;
    while (!stopping) {
      let r = null;
      try {
        r = await client.leaseSession({ backend, taskId: tid });
      } catch (err) {
        // 404 = 号池镜像还是旧版（没有 lease 端点）→ 与「池子为空」同路：
        // 回落 legacy 全局会话。其余错误（网络抖动/5xx）与 claim 同策略，等一轮再试。
        if (err && err.status === 404) {
          log(`[${workerId}] 号池没有 /session/lease 端点（旧版镜像）—— `
            + `回落全局会话（legacy 模式）执行任务 ${tid}`, 'warn');
          break;
        }
        log(`[${workerId}] 租号请求失败：${err.message}`, 'warn');
      }
      if (r && r.ok && r.session) {
        try {
          // AI Studio 的 Google cookie 不带 device_id/x_csrftoken —— 按后端分档校验
          session = backend === 'aistudio_image'
            ? normalizeAiSession(r.session)
            : normalizeSession(r.session);
        } catch (err) {
          log(`[${workerId}] 租到的账号凭据结构不对（${err.message}）—— 放弃执行`, 'error');
          await report(tid, failure.localFailure(failure.KIND.PARAM,
            `账号 #${(r.account && r.account.id) || '?'} 的凭据结构不对：${err.message}`));
          state.active.delete(tid);
          state.presence = state.active.size ? 'busy' : 'idle';
          return;
        }
        account = { id: r.account.id, label: r.account.label || '' };
        active.account = account.label || `#${account.id}`;
        lease = true;
        log(`[${workerId}] 任务 ${tid} 租到账号 ${active.account} `
          + `（并发 ${r.account.running}/${r.account.max_slots}）`);
        break;
      }
      // 租不到：池子空 → legacy 回落；全忙 → 等下一轮
      const total = r && r.pool ? (Number(r.pool.total) || 0) : -1;
      if (total === 0) {
        log(`[${workerId}] 账号池为空 —— 回落全局会话（legacy 模式）执行任务 ${tid}`, 'warn');
        break;
      }
      if (Date.now() > deadline) {
        log(`[${workerId}] 任务 ${tid} 等了 ${Math.round(LEASE_WAIT_MS / 60000)} 分钟仍租不到账号`, 'error');
        await report(tid, failure.localFailure(failure.KIND.UPSTREAM_ERROR,
          `等待可用账号超时（${Math.round(LEASE_WAIT_MS / 60000)} 分钟）—— `
          + '账号池全忙或凭据均失效；请检查控制台账号状态'));
        state.active.delete(tid);
        state.presence = state.active.size ? 'busy' : 'idle';
        return;
      }
      log(`[${workerId}] 账号全忙，租不到号 —— ${cfg.pollSeconds}s 后再试（任务 ${tid} 不判失败）`, 'warn');
      await tiktok.sleep(cfg.pollSeconds * 1000);
    }
  }
  if (stopping) {
    state.active.delete(tid);
    return;
  }

  // ---- 执行（lease 模式提交阶段失效会换号重试一次） ----
  const failover = async () => {
    try {
      return await executeTask(task, session, beat, { lease });
    } catch (err) {
      // 只有「提交阶段会话失效且上游未建单」才值得换号重试 ——
      // 带着 remoteTaskId 说明单已建、钱已花，换号重提等于第二单。
      if (!lease || !account || !sessionruntime.isAuthExpired(err) || err.remoteTaskId) throw err;
      const deadId = account.id;
      log(`[${workerId}] 账号 #${deadId} 凭据失效（提交阶段）—— 标记失效并尝试换号重试一次`, 'warn');
      try {
        await client.reportAccount({
          agent_id: cfg.agentId, account_id: deadId,
          ok: false, code: sessionruntime.LOGIN_REQUIRED_CODE,
          message: String(err.message).slice(0, 300),
        });
      } catch (e2) { log(`[${workerId}] 失效标记回报失败：${e2.message}`, 'warn'); }
      try { await client.releaseSession({ taskId: tid, accountId: deadId }); } catch { /* 幂等 */ }
      let r2 = null;
      try {
        r2 = await client.leaseSession({ backend, taskId: tid, exclude: [deadId] });
      } catch (e3) { log(`[${workerId}] 换号租约失败：${e3.message}`, 'warn'); }
      if (!(r2 && r2.ok && r2.session)) throw err;
      try {
        session = backend === 'aistudio_image'
          ? normalizeAiSession(r2.session)
          : normalizeSession(r2.session);
      } catch (e4) { throw err; }
      account = { id: r2.account.id, label: r2.account.label || '' };
      active.account = account.label || `#${account.id}`;
      log(`[${workerId}] 已换到账号 ${active.account}，重试提交（此时上游未建单，安全）`, 'info');
      return executeTask(task, session, beat, { lease: true });
    }
  };

  let outcome;
  try {
    outcome = await failover();
  } catch (err) {
    // 失败也要**说清性质**：号池靠 error_kind 把「内容不合规」与
    // 「会话过期」「节点掉线」分开 —— 三者处置方式完全不同，而改造前
    // 在控制台上完全一样（都是 FAILED + 一段英文原文）。
    outcome = failure.outcomeOf(err);
  }

  if (outcome.ok) {
    state.done += 1;
    log(`[${workerId}]   ✅ ${outcome.output_url.slice(0, 110)}`);
  } else if (outcome.cancelled) {
    // 取消不是故障：调用方已经自己把任务标成终态，号池会回 already_final。
    state.cancelled += 1;
    log(`[${workerId}]   ⏹ 已按调用方要求停止：${outcome.error}`, 'warn');
  } else {
    state.failed += 1;
    const d = failure.describe(outcome.error_kind);
    log(`[${workerId}]   ❌ 失败[${d.label}${outcome.error_code ? ` ${outcome.error_code}` : ''}]：`
      + `${outcome.error}`, 'error');
    // 不可重发的失败要**显式说一句** —— 这是运营最容易踩的坑：
    // 「重发一次试试」在这种场景下每次都真的烧掉一次上游额度。
    if (outcome.retryable === false) log(`     ↳ ${d.advice}`, 'warn');
  }

  state.lastTask = {
    taskId: tid,
    ok: outcome.ok,
    detail: outcome.ok ? outcome.output_url.slice(0, 160) : outcome.error,
    kind: outcome.error_kind || '',
    at: Date.now(),
  };
  await report(tid, outcome);

  // ---- 还槽：成功、失败、取消都要还；漏一次就永久少一个槽位 ----
  if (account) {
    try {
      const rr = await client.releaseSession({ taskId: tid, accountId: account.id });
      log(`[${workerId}] 已归还账号槽位 ${active.account}`
        + `${rr && rr.released === false ? '（号池侧已释放，幂等）' : ''}`);
    } catch (err) {
      // 还槽失败不致命：号池有 reap_agent_leases 按 30 分钟兜底回收僵尸租约
      log(`[${workerId}] 归还槽位失败（号池会按超时回收）：${err.message}`, 'warn');
    }
  }

  // ---- 任务后积分快照：控制台「积分合计」跟着每次消耗即时走 ----
  // 只在 lease 模式（知道账号 id）下做；失败不影响任何结果，见
  // sessionruntime.refreshAccountInfo 的注释。fire-and-forget：别拖住下一个任务。
  if (lease && account && session && !stopping) {
    sessionruntime.refreshAccountInfo(client, session, account.id, log)
      .catch(() => {});
  }
  state.active.delete(tid);
  state.presence = state.active.size ? 'busy' : 'idle';
}

// ---------------------------------------------------------------------------
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  sessionruntime.stop();
  aistudioPool.stop().catch(() => {});
  log(`收到 ${signal}，停止取活并退出 …`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log(`未处理的 Promise 拒绝：${err}`, 'error'));
// 未捕获异常：落盘崩溃堆栈（重启后 /status 可查根因）再退出，交给托管平台拉起。
process.on('uncaughtException', (err) => {
  const detail = String((err && err.stack) || err);
  crashAppend(`[${ts()}] CRASH uptime=${Math.round((Date.now() - state.startedAt) / 1000)}s running=${state.active.size} ${detail}`);
  try { process.stderr.write(`[${ts()}] FATAL ${detail}\n`); } catch { }
  setTimeout(() => process.exit(1), 250).unref();
});
// 低频心跳：内存与在跑任务数进 stdout，抓 OOM 趋势（离线复发时先看是不是内存顶到托管上限）。
setInterval(() => {
  const m = process.memoryUsage();
  log(`heartbeat mem rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}MB `
    + `uptime=${Math.round((Date.now() - state.startedAt) / 1000)}s running=${state.active.size}`);
}, 5 * 60_000).unref();

log(`tiktok-exec-node v${require('./package.json').version} · Node ${process.version} · `
  + `主机 ${require('node:os').hostname()}`);

server.listen(cfg.port, cfg.host, () => {
  log(`HTTP 服务监听 ${cfg.host}:${cfg.port}（/healthz · /status）`);
  loop().catch((err) => log(`取活循环意外退出：${err && err.stack || err}`, 'error'));
});
