'use strict';
/**
 * 离线集成自测 —— 把 `index.js` 的编排逻辑真跑一遍，不联网、不消耗任何额度。
 *
 * 为什么需要它
 * ------------
 * 这台节点的真实依赖有两个，两边都不适合拿来做回归：
 *   · TikTok 上游 —— 每次调用都烧账号额度，还不能重放；
 *   · 号池 —— 动它要改生产配置。
 * 于是「claim → 上传 → 提交 → 轮询 → 交付 → 回报」这段编排逻辑长期只能靠
 * 读代码确认。可这段恰恰是最容易悄悄坏掉的地方：
 *
 *   · 轮询期间**取消检测**没接上 → 控制台取消了，节点照跑到底，白烧额度；
 *   · mirror 的**上传标识**用错任务号 → 下游收到片子却查不到是谁的；
 *   · `output_variants` 被压成字符串数组 → 分辨率阶梯永久丢失。
 * 三种坏法都**不报错**，只是结果不对。所以这里用一个假号池 + 假上游
 * 把这段逻辑当真代码跑，用断言把它钉住。
 *
 * 做法：子进程起真的 `index.js`，把号池指向本文件里的假号池；
 * `lib/tiktok.js` 通过 require 缓存被换成假的（只替换上游 I/O，不碰编排）。
 *
 * 跑法：`node selftest/offline.js`
 */
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const NODE = process.execPath;
const ROOT = path.resolve(__dirname, '..');

const FAKE_SESSION = Buffer.from(JSON.stringify({
  cookie: 'c', x_csrftoken: 'x', device_id: 'd',
})).toString('base64');

const TASK = {
  task_id: 'selftest-task-0001',
  backend: 'tiktok_r2v',
  prompt: '一只黑色拉布拉多幼犬趴在浅色木地板上，抬头直视镜头。',
  image_urls: ['https://example.test/ref.png'],
  model_name: 'Dreamina Seedance 2.0 Fast',
  duration: 5,
  agent: { provider: 'tiktok_r2v', model_id: '2000012', model_key: 'seedance2_fast' },
};

/** 上游假实现返回的「出片结果」，两条变体用于验证分辨率阶梯不被压掉。 */
const FAKE_RESULT = {
  taskId: 'TIKTOK-SIDE-999',
  bestUrl: 'https://cdn.example.test/best.mp4',
  bestMeta: { Width: 1080, Height: 1920, Format: 'mp4', Size: 1500000 },
  bestExpire: '1789900000',
  variants: [
    Object.assign({}, { Width: 720, Height: 1280, Format: 'mp4', Codec: 'h264', Size: 400000, Definition: '720p', BizQualityType: 2 }, { url: 'https://cdn.example.test/v1.mp4', expire: '1789900000' }),
    Object.assign({}, { Width: 1080, Height: 1920, Format: 'mp4', Codec: 'h264', Size: 1500000, Definition: '1080p', BizQualityType: 3 }, { url: 'https://cdn.example.test/v2.mp4', expire: '1789900000' }),
  ],
  nVideos: 2,
  elapsedSec: 42,
};

let failures = 0;
function ok(name, good, detail = '') {
  if (!good) failures += 1;
  console.log(`  ${good ? '✓' : '✗'} ${name}${detail ? '  —— ' + detail : ''}`);
}

/**
 * 断言失败时把**节点子进程的日志**一起打出来。
 *
 * 离线自测里节点是黑盒（子进程 + 假号池 + 假上游），失败时只看到「没有回报」
 * 这类结论根本没法定位 —— 而真实原因几乎总在节点日志里（某一步抛了、
 * 或压根没走到回报）。让失败自带证据，别让人再去改脚本打日志。
 */
function dumpLogIfFailed(good, log) {
  if (good) return '';
  return '\n--- 节点日志（失败时自动附带）---\n' + String(log || '(空)').trimEnd()
    + '\n--- 日志结束 ---';
}

// ---------------------------------------------------------------------------
// 假号池 —— 同时兼任 mirror 收件端
// ---------------------------------------------------------------------------
function startFakePool(scenario) {
  const seen = { claims: 0, heartbeats: [], peeks: 0, results: [], mirrors: [] };
  const server = http.createServer((req, res) => {
    const p = (req.url || '').split('?')[0];
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (code, obj) => {
        const b = Buffer.from(JSON.stringify(obj), 'utf8');
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': String(b.length) });
        res.end(b);
      };
      if (p === '/api/v1/agent/stats') return send(200, { ok: true, backends: ['tiktok_r2v'], pending_agent: 1, agent_running: 0 });
      if (p === '/api/v1/agent/claim') {
        seen.claims += 1;
        // 只给一次活，之后空转 —— 免得自测里反复领到同一个任务
        return send(200, seen.claims === 1 ? { task: TASK } : { task: null });
      }
      if (p === '/api/v1/agent/heartbeat') {
        seen.heartbeats.push(JSON.parse(body.toString() || '{}'));
        // ⚠️ 号池这个字段是**硬编码 false 的桩**，真取消判定在 peek。故意一直回 false。
        return send(200, { ok: true, cancelled: false });
      }
      if (p.startsWith('/api/v1/agent/task/')) {
        seen.peeks += 1;
        return send(200, { task_id: TASK.task_id, status: scenario.cancel ? 'CANCEL' : 'AGENT_RUNNING', cancelled: Boolean(scenario.cancel) });
      }
      if (p === '/api/v1/agent/result') {
        const r = JSON.parse(body.toString() || '{}');
        seen.results.push(r);
        return send(200, { ok: true, status: r.ok ? 'SUCCESS' : 'FAILED' });
      }
      if (p === '/mirror') {
        seen.mirrors.push({ headers: req.headers, bytes: body.length });
        return send(200, { url: 'https://site.example.test/assets/' + TASK.task_id + '.mp4' });
      }
      send(404, { detail: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

// ---------------------------------------------------------------------------
// 起一个真的 index.js 子进程，上游用假的
// ---------------------------------------------------------------------------
function startNode({ poolPort, childPort, mode, oversize, noMirrorUrl, upstreamFail }) {
  const env = Object.assign({}, process.env, {
    RH_SELFTEST_RESULT: Buffer.from(JSON.stringify(FAKE_RESULT)).toString('base64'),
    RH_SELFTEST_OVERSIZE: oversize ? '1' : '',
    // 让假上游在轮询阶段直接抛「上游终态拒绝」，用来验失败分类的回报契约。
    RH_SELFTEST_UPSTREAM_FAIL: upstreamFail
      ? Buffer.from(JSON.stringify(upstreamFail)).toString('base64') : '',
    RH_POOL_URL: `http://127.0.0.1:${poolPort}`,
    RH_AGENT_TOKEN: 'selftest-token',
    RH_AGENT_ID: 'selftest-node',
    RH_POLL_SECONDS: '1',
    RH_HEARTBEAT_SECONDS: '1',
    RH_PEEK_SECONDS: '1',
    RH_OUTPUT_MODE: mode,
    RH_MIRROR_URL: noMirrorUrl ? '' : `http://127.0.0.1:${poolPort}/mirror`,
    RH_SESSION_JSON: FAKE_SESSION,
    RH_LOG_LEVEL: 'debug',
    PORT: String(childPort),
    HOST: '127.0.0.1',
  });
  // 号池地址是 http，不需要 CA；清掉避免 http 分支被误导
  delete env.RH_POOL_CA_FILE;
  delete env.RH_POOL_INSECURE;
  const child = spawn(NODE, [path.join(ROOT, 'selftest', 'boot.js')], { env, cwd: ROOT });
  const out = [];
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => out.push(d.toString()));
  return { child, log: () => out.join('') };
}

function waitFor(fn, timeoutMs = 20000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    (function tick() {
      let v = null;
      try { v = fn(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return resolve(null);
      setTimeout(tick, 100);
    })();
  });
}

async function scenario(name, opts, check) {
  console.log(`\n■ ${name}`);
  const { server, seen, port } = await startFakePool(opts);
  const childPort = port + 1;
  const node = startNode({
    poolPort: port,
    childPort,
    mode: opts.mode,
    oversize: opts.oversize,
    noMirrorUrl: opts.noMirrorUrl,
    upstreamFail: opts.upstreamFail,
  });
  try {
    const got = await waitFor(() => (seen.results.length ? seen.results[0] : null), 25000);
    await check({ seen, result: got, log: node.log() });
  } finally {
    node.child.kill('SIGKILL');
    server.close();
  }
}

// ---------------------------------------------------------------------------
(async () => {
  console.log('='.repeat(70));
  console.log('海外执行节点 —— 离线集成自测（假号池 + 假上游，不联网、零额度消耗）');
  console.log('='.repeat(70));

  // ---- 场景 1：调用方取消 → 节点必须停，且不能碰上游交付 ----
  await scenario('场景 1 · mirror 模式下任务被取消', { mode: 'mirror', cancel: true }, ({ seen, result, log }) => {
    ok('节点领到了任务', seen.claims >= 1, `claim ${seen.claims} 次`);
    ok('轮询期间真的去问了「这活还要不要」', seen.peeks >= 1, `peek ${seen.peeks} 次`);
    ok('停止后回报了失败（不覆盖调用方终态）', Boolean(result) && result.ok === false,
      (result ? String(result.error).slice(0, 60) : '没有回报') + dumpLogIfFailed(Boolean(result), log));
    ok('取消时**没有**调用上游交付', seen.mirrors.length === 0, `mirror ${seen.mirrors.length} 次`);
    ok('日志里明确说了是取消', /取消/.test(log));
  });

  // ---- 场景 2：cdn 模式正常出片 → 变体必须保留分辨率阶梯 ----
  await scenario('场景 2 · cdn 模式正常出片', { mode: 'cdn' }, ({ seen, result }) => {
    ok('回报成功', Boolean(result) && result.ok === true);
    const v = (result && result.output_variants) || [];
    ok('output_variants 是数组且有 2 条', Array.isArray(v) && v.length === 2, `实际 ${JSON.stringify(v).slice(0, 60)}`);
    ok('变体带原始 VideoMeta 字段（Width/Height/Definition）',
      v[0] && v[0].Width === 720 && v[0].Height === 1280 && v[0].Definition === '720p',
      JSON.stringify(v[0]));
    ok('变体带 url 与 expire', Boolean(v[0] && v[0].url) && Boolean(v[0] && v[0].expire));
    ok('cdn 模式不触发 mirror', seen.mirrors.length === 0);
    ok('回报 output_url 用的是上游直链', result.output_url === FAKE_RESULT.bestUrl, result.output_url);
    ok('未把 TikTok 侧任务号当成交付标识泄漏出去（只留 remote_task_id）',
      result.remote_task_id === FAKE_RESULT.taskId);
  });

  // ---- 场景 3：mirror 模式正常出片 → 标识必须是号池任务号 ----
  await scenario('场景 3 · mirror 模式正常出片', { mode: 'mirror' }, ({ seen, result }) => {
    ok('回报成功', Boolean(result) && result.ok === true);
    ok('确实调了一次收件端', seen.mirrors.length === 1, `实际 ${seen.mirrors.length}`);
    const m = seen.mirrors[0] || { headers: {} };
    ok('X-Relay-Task-Id 用的是**号池任务号**',
      m.headers['x-relay-task-id'] === TASK.task_id, String(m.headers['x-relay-task-id']));
    ok('文件名用的是号池任务号（不是 TikTok 侧任务号）',
      String(m.headers['content-disposition'] || '').includes(TASK.task_id)
      && !String(m.headers['content-disposition'] || '').includes(FAKE_RESULT.taskId),
      String(m.headers['content-disposition']));
    ok('按视频字节流提交（不是 multipart）',
      m.headers['content-type'] === 'video/mp4')
    ok('带了 Content-Length', Number(m.headers['content-length']) > 0);
    ok('回报的是收件端给的稳定 URL', result.output_url === 'https://site.example.test/assets/' + TASK.task_id + '.mp4', result.output_url);
    ok('本地已把片子下载下来（字节数对得上）', m.bytes === 1500000, `${m.bytes} 字节`);
  });

  // ---- 场景 4：体积超闸门 → 不浪费上传，但仍交付直链 ----
  //
  // 契约变更（2026-09-20）：**交付失败不再连坐成任务失败**。
  // 片子这时已经生成、上游额度已经扣了，因为「搬不回自己的存储」就把整条
  // 任务判失败，等于钱花了、成品丢了、上游任务号也没回报。现在统一降级为
  // 直链交付，用 `archived=false` + `archive_note` 把「没归档」这件事讲清楚。
  await scenario('场景 4 · 成片超过收件端体积闸门', { mode: 'mirror', oversize: true }, ({ seen, result }) => {
    ok('任务仍然成功（已生成的片子不能因交付连坐）', Boolean(result) && result.ok === true);
    ok('降级交付的是直链', /^https?:/.test(String(result && result.output_url)),
      String(result && result.output_url).slice(0, 70));
    ok('archived=false 表明没进下游存储', Boolean(result) && result.archived === false);
    ok('说明里点明体积与闸门', /MB/.test(String(result && result.archive_note))
      && /25MB|上限/.test(String(result && result.archive_note)),
      String(result && result.archive_note).slice(0, 100));
    ok('没有真的发起上传', seen.mirrors.length === 0);
    ok('仍然回报了上游任务号（可追溯）', Boolean(result && result.remote_task_id),
      String(result && result.remote_task_id));
  });

  // ---- 场景 5：没配收件端的 mirror → 降级直链，并在说明里点出要补哪个变量 ----
  await scenario('场景 5 · mirror 但没配 RH_MIRROR_URL', { mode: 'mirror', noMirrorUrl: true }, ({ result }) => {
    ok('任务仍然成功', Boolean(result) && result.ok === true);
    ok('交付的是直链（人工仍可取回）', /^https?:/.test(String(result && result.output_url)),
      String(result && result.output_url).slice(0, 70));
    ok('archived=false', Boolean(result) && result.archived === false);
    ok('说明里写清了要补哪个变量', /RH_MIRROR_URL/.test(String(result && result.archive_note)),
      String(result && result.archive_note).slice(0, 100));
    ok('仍然回报了上游任务号（可追溯）', Boolean(result && result.remote_task_id),
      String(result && result.remote_task_id));
  });

  // ---- 场景 6：上游以「内容不合规」拒绝 → 必须报出可区分的分类，且带上游任务号 ----
  //
  // 这是本次改造的核心验收。用户的原话是「**肯定是不能去一直重复测试、重复尝试
  // 这条失败的任务**，因为本身用户上传的内容就不合规」。
  // 系统里**本来就没有任何自动重试**（唯一的重试点在提交阶段的 10001106，
  // 与内容无关），所以这一条要验的是另一件事：**让运营看得出「这条不该重发」**。
  // 改造前三者在控制台上完全一样（都是 FAILED + 一段英文原文），谁也分不清。
  await scenario('场景 6 · 上游内容不合规拒绝', {
    mode: 'mirror',
    upstreamFail: { code: 10043300, message: 'This content may violate our Community Guidelines. Try generating again.' },
  }, ({ seen, result, log }) => {
    ok('回报了失败', Boolean(result) && result.ok === false);
    ok('分类为 CONTENT_MODERATION（控制台据此显示「内容不合规」）',
      result && result.error_kind === 'CONTENT_MODERATION', String(result && result.error_kind));
    ok('原样带回上游错误码', String(result && result.error_code) === '10043300',
      String(result && result.error_code));
    ok('标记 retryable=false（同素材重发必再失败且照扣额度）',
      result && result.retryable === false, String(result && result.retryable));
    ok('**失败也带上游任务号**（改造前这里是一片空白，无法对账/申诉）',
      Boolean(result && result.remote_task_id), String(result && result.remote_task_id));
    ok('error 保留上游原文（不是把中文结论落库）',
      /Community Guidelines/.test(String(result && result.error)));
    ok('输出里不含上游英文的"已成功"字段（确认走的是失败分支）',
      !result.output_url);
    ok('节点日志明确点出「不该重发」（防运营盲重发）',
      /重发会被同样拒绝/.test(log), '');
  });

  console.log('\n' + '='.repeat(70));
  console.log(failures ? `${failures} 项断言未通过` : '离线集成自测全部通过 ✓');
  process.exit(failures ? 1 : 0);
})();
