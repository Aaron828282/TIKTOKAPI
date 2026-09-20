'use strict';
/**
 * 会话凭据「号池持有、控制台切换、节点按需索取」的离线自测。
 *
 * 为什么值得单独一个文件
 * ----------------------
 * 这条链路有**三种失败方式都不会报错，只会让结果不对**：
 *
 *   ① 把「号池没配」当成「号池报错」→ 静默退到一份过期几天的本地 cookie，
 *      一直到出片才以 10001106 炸出来（那时客户已经在等片子了）；
 *   ② 把「号池报错」当成「号池没配」→ 看起来在跑，其实用的是没人记得的旧凭据；
 *   ③ 号池下发一份结构不对的凭据 → 覆盖掉本地那份好的，把「本来能跑」变成
 *      「立刻不能跑」。
 *
 * 所以这里两段都跑：
 *   A 段 —— 进程内直调 `lib/sessionruntime.js`，把上面三种分支连同
 *           `since` 协议、`10001106` 重试策略逐条钉住；
 *   B 段 —— 子进程起真的 `index.js` 打一个假号池，验证接线（启动取用、
 *           `/status` 可观、验活回报到号池、凭据不外泄）。
 *
 * 全程不联网、不消耗额度、可重放。
 * 跑法：`node selftest/sessionpool.js`
 */
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const NODE = process.execPath;
const ROOT = path.resolve(__dirname, '..');
const STUB = path.resolve(__dirname, 'probe-stub.js');
const LIB = (n) => path.resolve(__dirname, '..', 'lib', n);

let failures = 0;
function ok(name, good, detail = '') {
  if (!good) failures += 1;
  console.log(`  ${good ? '✓' : '✗'} ${name}${detail ? '  —— ' + detail : ''}`);
}
function section(t) {
  console.log(`\n${t}`);
}

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------
const COOKIE_SENTINEL = 'SELFTEST-COOKIE-VALUE-DO-NOT-LEAK-8f3a1';

/** 造一份结构完整、寿命新鲜的凭据（广告线 TTL 3 天）。 */
function sess(deviceId, { remainSec = 3 * 86400, cookie = '' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const issue = now - (3 * 86400 - remainSec);
  const cookieStr = cookie
    || `sessionid_ads=${deviceId}-${COOKIE_SENTINEL}; `
     + `sid_guard_ads=${deviceId}|${issue}|259200|${issue + 259200}; msToken=abc`;
  return {
    cookie: cookieStr,
    x_csrftoken: `csrf-${deviceId}`,
    device_id: deviceId,
    x_fp_id: `fp-${deviceId}`,
  };
}

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假号池客户端：记录每一次调用，响应由 handler 决定。 */
function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    of: (kind) => calls.filter((c) => c.kind === kind),
    session: async (backend, since, agentId) => {
      calls.push({ kind: 'session', backend, since, agentId });
      return handler({ backend, since, agentId, n: calls.length });
    },
    reportSession: async (body) => {
      calls.push({ kind: 'report', ...body });
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// A 段 · 协议层（进程内）
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  'RH_SESSION_SOURCE', 'RH_SESSION_JSON', 'RH_SESSION_FILE', 'RH_POOL_URL',
  'RH_AGENT_TOKEN', 'RH_SESSION_REFRESH_SECONDS', 'RH_SESSION_PROBE_SECONDS',
  'RH_BACKENDS', 'RH_SESSION_BACKEND', 'RH_AGENT_ID', 'RH_OUTPUT_MODE',
];

/**
 * 用指定环境变量**重新加载** config / sessionruntime。
 *
 * `cfg` 是模块加载时从 env 快照出来的，所以要换一套环境就得清 require 缓存。
 * （`lib/tiktok.js` 不依赖 config，所以不需要跟着清。）
 */
function loadFresh(env = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  for (const p of [LIB('sessionruntime.js'), LIB('sessioncache.js'), LIB('config.js')]) {
    delete require.cache[p];
  }
  const config = require('../lib/config');
  const runtime = require('../lib/sessionruntime');
  const cache = require('../lib/sessioncache');
  return { config, cfg: config.cfg, runtime, cache };
}

const BASE_ENV = {
  RH_POOL_URL: 'https://pool.selftest',
  RH_AGENT_TOKEN: 'selftest-token',
  RH_BACKENDS: 'tiktok_r2v',
  RH_SESSION_REFRESH_SECONDS: '600',
};

async function partA() {
  // 把上游探活换成可控的打桩（sessionruntime 是延迟 require 它的）
  const tiktokMod = require('../lib/tiktok');
  let probeCalls = 0;
  let probeImpl = async () => ({ alive: true, code: 0, status: 200, message: '' });
  tiktokMod.probeSession = async (...a) => { probeCalls += 1; return probeImpl(...a); };

  // =========================================================================
  section('A1 · 号池有凭据 → 领到就用，并立刻验活回报');
  {
    const { config, runtime, cache } = loadFresh(BASE_ENV);
    const client = fakeClient(() => ({
      ok: true, backend: 'tiktok_r2v', configured: true, changed: true,
      version: 7, session: sess('dev-pool-v7'),
    }));
    const r = await runtime.refresh(client, () => {}, { force: true, reason: 'test', probe: true });

    ok('刷新成功', r.ok === true);
    ok('判定为「拿到了新凭据」', r.changed === true);
    ok('版本号原样保留（号池的版本号，不是本地计数器）', r.version === 7, String(r.version));
    ok('凭据已落到运行时缓存', config.loadSession().device_id === 'dev-pool-v7');
    ok('来源标记为 cache', config.sessionOrigin() === 'cache');
    ok('hasSession 为真', config.hasSession() === true);
    ok('缓存里记的是 pool 来源', cache.info('tiktok_r2v').source === 'pool');
    ok('可选字段 x_fp_id 被原样透传（不能被挑掉）',
      config.loadSession().x_fp_id === 'fp-dev-pool-v7');
    ok('验活跑了一次', probeCalls === 1, String(probeCalls));
    ok('验活结论回报给号池了', client.of('report').length === 1);
    ok('回报里带了版本号（号池据此对账）', client.of('report')[0].version === 7);
    ok('回报里带了 agent_id', client.of('report')[0].agent_id === config.cfg.agentId);
    ok('回报结论是「有效」', client.of('report')[0].ok === true);
    ok('寿命被正确解析出来（不是「读不出到期时间」）',
      /还剩 2 天|还剩 3 天/.test(config.sessionStatus().note), config.sessionStatus().note);

    // ---- 观测面不得含凭据 ----
    const st = JSON.stringify(runtime.status());
    ok('status() 不含 cookie 值', !st.includes(COOKIE_SENTINEL));
    ok('status() 不含 cookie 名', !st.includes('sessionid_ads='));

    // =======================================================================
    section('A2 · 版本号命中 → 一个字节的凭据都不过线，也不重复验活');
    {
      const probeBefore = probeCalls;
      // 故意**不返回 session 字段** —— 命中时号池本来就不该发凭据
      const c2 = fakeClient(() => ({
        ok: true, configured: true, changed: false, version: 7,
      }));
      const r2 = await runtime.refresh(c2, () => {}, { reason: 'timer', probe: true });
      ok('带上了本地版本号去问', c2.of('session')[0].since === 7, String(c2.of('session')[0].since));
      ok('号池回「没变」', r2.ok === true && r2.changed === false);
      ok('本地凭据没被清掉', config.loadSession().device_id === 'dev-pool-v7');
      ok('没变时**不**重复验活（别对 ads.tiktok.com 打规律流量）',
        probeCalls === probeBefore, `${probeBefore} → ${probeCalls}`);
    }

    // =======================================================================
    section('A3 · force 时重新要一份完整的（since 归零）');
    {
      const c3 = fakeClient(() => ({
        ok: true, configured: true, changed: true, version: 8, session: sess('dev-pool-v8'),
      }));
      await runtime.refresh(c3, () => {}, { force: true, reason: 'test' });
      ok('since=0 表示「别管版本，把当前那份发来」', c3.of('session')[0].since === 0);
      ok('已切到 v8', config.loadSession().device_id === 'dev-pool-v8');
      ok('版本号已更新', runtime.status().version === 8, String(runtime.status().version));
    }

    // =======================================================================
    section('A4 · 号池不可达 → **保留**旧凭据，不清缓存、不抛异常');
    {
      const { PoolError } = require('../lib/pool');
      const c4 = fakeClient(() => { throw new PoolError(502, { detail: 'bad gateway' }); });
      const r4 = await runtime.refresh(c4, () => {}, { force: true, reason: 'timer' });
      ok('返回失败但不抛（不能把取活循环带崩）', r4.ok === false && r4.unreachable === true);
      ok('明确标注「保留了旧凭据」', r4.kept === true);
      ok('旧凭据仍在（网络抖一下不该让本地空手）',
        config.loadSession().device_id === 'dev-pool-v8');
      ok('版本号没被清零', cache.info('tiktok_r2v').version === 8);
    }

    // =======================================================================
    section('A5 · 号池下发结构不对的凭据 → 不覆盖本地那份好的');
    {
      const c5 = fakeClient(() => ({
        ok: true, configured: true, changed: true, version: 99,
        session: { cookie: 'sessionid_ads=x' },   // 缺 x_csrftoken / device_id
      }));
      const r5 = await runtime.refresh(c5, () => {}, { force: true, reason: 'test' });
      ok('判定为失败', r5.ok === false && Boolean(r5.invalid), r5.invalid || '');
      ok('本地那份**没被顶掉**（坏凭据不能挤走好凭据）',
        config.loadSession().device_id === 'dev-pool-v8');
      ok('版本号也没被推进', cache.info('tiktok_r2v').version === 8);
    }
  }

  // =========================================================================
  section('A6 · 号池还没配 + 本地有 → 回落 env（auto 模式）');
  {
    const { config, runtime, cache } = loadFresh({
      ...BASE_ENV, RH_SESSION_JSON: b64(sess('dev-env-01')),
    });
    const client = fakeClient(() => ({
      ok: true, backend: 'tiktok_r2v', configured: false, version: 0, session: null,
    }));
    const r = await runtime.refresh(client, () => {}, { force: true, reason: 'startup' });
    ok('整体算「可用」', r.ok === true);
    ok('标记为回落路径', r.fallback === true && r.source === 'env');
    ok('用的是环境变量那份', config.loadSession().device_id === 'dev-env-01');
    ok('来源如实报成 env（**不是** cache —— 否则会让人以为控制台换了就生效）',
      config.sessionOrigin() === 'env');
    ok('缓存里没有东西', cache.info('tiktok_r2v') === null);
  }

  // =========================================================================
  section('A7 · 号池还没配 + 本地也没有 → 明确失败，且给得出下一步');
  {
    const { config, runtime } = loadFresh(BASE_ENV);
    const client = fakeClient(() => ({
      ok: true, configured: false, version: 0, session: null,
    }));
    const r = await runtime.refresh(client, () => {}, { force: true, reason: 'startup' });
    ok('判定为失败', r.ok === false && r.notConfigured === true);
    ok('hasSession 为假', config.hasSession() === false);
    let msg = '';
    try { config.loadSession(); } catch (err) { msg = err.message; }
    ok('取用时报错', msg.length > 0);
    ok('报错里写了去哪配（控制台）', /控制台/.test(msg), msg.slice(0, 70));
  }

  // =========================================================================
  section('A8 · RH_SESSION_SOURCE=pool → 不回落 env（两份凭据不许互相冒充）');
  {
    const { config, runtime, cache } = loadFresh({
      ...BASE_ENV, RH_SESSION_SOURCE: 'pool', RH_SESSION_JSON: b64(sess('dev-env-02')),
    });
    const client = fakeClient(() => ({
      ok: true, configured: false, version: 0, session: null,
    }));
    const r = await runtime.refresh(client, () => {}, { force: true, reason: 'startup' });
    ok('判定为失败', r.ok === false && r.notConfigured === true);
    ok('缓存空', cache.has('tiktok_r2v') === false);
    let msg = '';
    try { config.loadSession(); } catch (err) { msg = err.message; }
    ok('本地明明有 env 凭据也**不**用', config.loadSession !== undefined && msg.length > 0);
    ok('报错点明「不回落环境变量」', /不回落/.test(msg), msg.slice(0, 80));
  }

  // =========================================================================
  section('A9 · RH_SESSION_SOURCE=env → 完全不问号池（老路径保持原样）');
  {
    const { config, runtime } = loadFresh({
      ...BASE_ENV, RH_SESSION_SOURCE: 'env', RH_SESSION_JSON: b64(sess('dev-env-03')),
    });
    const client = fakeClient(() => { throw new Error('不该被调用'); });
    const r = await runtime.refresh(client, () => {}, { force: true, reason: 'timer' });
    ok('直接跳过', r.ok === false && r.skipped === 'RH_SESSION_SOURCE=env');
    ok('一次请求都没发', client.calls.length === 0, String(client.calls.length));
    ok('照常能用 env 那份', config.loadSession().device_id === 'dev-env-03');
  }

  // =========================================================================
  section('A10 · 失效判定：只认 10001106，不误伤别的报错');
  {
    const { runtime } = loadFresh(BASE_ENV);
    const hit = [
      '建单失败：HTTP 200 code=10001106 message=Login Required',
      '会话在轮询期间失效（10001106 Login Required）—— 需要刷新 cookie',
      'Login Required',
    ];
    const miss = [
      '建单失败：HTTP 200 code=10001107 message=something else',
      '上游生成失败 [2001] invalid param',
      'HTTP 502: bad gateway',
      '会话凭据解出来不是对象',
      '',
    ];
    for (const m of hit) ok(`认得出：${m.slice(0, 40)}`, runtime.isAuthExpired(new Error(m)) === true);
    for (const m of miss) ok(`不误伤：${m.slice(0, 40) || '(空)'}`, runtime.isAuthExpired(new Error(m)) === false);
    ok('失效码常量与 TikTok 侧一致', runtime.LOGIN_REQUIRED_CODE === 10001106);
  }

  // =========================================================================
  section('A11 · withSubmitRetry：换到了新版本 → 允许重试一次');
  {
    const { runtime, config } = loadFresh(BASE_ENV);
    // 先用 v1 起手
    const c0 = fakeClient(() => ({
      ok: true, configured: true, changed: true, version: 1, session: sess('dev-v1'),
    }));
    await runtime.refresh(c0, () => {}, { force: true, reason: 'seed' });
    ok('起手版本 v1', config.loadSession().device_id === 'dev-v1');

    // 提交失败 → 强刷拿到 v2 → 重试成功
    let n = 0;
    const c1 = fakeClient(() => ({
      ok: true, configured: true, changed: true, version: 2, session: sess('dev-v2'),
    }));
    const r = await runtime.withSubmitRetry(async () => {
      n += 1;
      if (n === 1) throw new Error('建单失败：HTTP 200 code=10001106 message=Login Required');
      return { ok: true, used: config.loadSession().device_id };
    }, { client: c1, log: () => {} });

    ok('确实重试了（共调用 2 次）', n === 2, String(n));
    ok('重试时用的是**新**凭据', r.used === 'dev-v2', String(r.used));
    ok('确实是强制取（since=0）', c1.of('session')[0].since === 0);
  }

  // =========================================================================
  section('A12 · withSubmitRetry：号池那份没变 → 不重试，直接给一句能照做的报错');
  {
    const { runtime, config } = loadFresh(BASE_ENV);
    const c0 = fakeClient(() => ({
      ok: true, configured: true, changed: true, version: 5, session: sess('dev-v5'),
    }));
    await runtime.refresh(c0, () => {}, { force: true, reason: 'seed' });

    let n = 0;
    // 号池回的版本号**还是 5** —— 说明控制台里压根没换
    const c1 = fakeClient(() => ({
      ok: true, configured: true, changed: true, version: 5, session: sess('dev-v5'),
    }));
    let msg = '';
    try {
      await runtime.withSubmitRetry(async () => {
        n += 1;
        throw new Error('建单失败：code=10001106 Login Required');
      }, { client: c1, log: () => {} });
    } catch (err) { msg = err.message; }

    ok('只调了一次，不做无意义的重复提交', n === 1, String(n));
    ok('抛错而不是静默成功', msg.length > 0);
    ok('报错点名「号池那份没变」', /没变/.test(msg), msg.slice(0, 60));
    ok('报错给出下一步：去控制台换', /控制台/.test(msg));
  }

  // =========================================================================
  section('A13 · withSubmitRetry：非鉴权错误原样抛出，不触发刷新');
  {
    const { runtime } = loadFresh(BASE_ENV);
    const c = fakeClient(() => { throw new Error('不该被调用'); });
    let n = 0;
    let msg = '';
    try {
      await runtime.withSubmitRetry(async () => {
        n += 1;
        throw new Error('建单失败：HTTP 500 internal');
      }, { client: c, log: () => {} });
    } catch (err) { msg = err.message; }
    ok('只调了一次', n === 1);
    ok('错误原文保留（别把无关故障也说成会话问题）', /HTTP 500/.test(msg), msg);
    ok('没有向号池要凭据', c.of('session').length === 0);
  }

  // =========================================================================
  section('A14 · 探活自身网络故障 → 不得回报成「凭据失效」');
  {
    const { runtime } = loadFresh(BASE_ENV);
    const c = fakeClient(() => ({
      ok: true, configured: true, changed: true, version: 3, session: sess('dev-v3'),
    }));
    probeImpl = async () => { throw new Error('ECONNRESET'); };
    const r = await runtime.refresh(c, () => {}, { force: true, reason: 'test', probe: true });
    ok('刷新本身仍算成功（凭据拿到了）', r.ok === true);
    ok('探活结论为「未知」而不是「失效」', runtime.status().probeOk === null);
    ok('**没有**回报失效（否则会让人去换一份根本没问题 cookie）',
      c.of('report').length === 0, String(c.of('report').length));
    probeImpl = async () => ({ alive: true, code: 0, status: 200, message: '' });
  }

  // =========================================================================
  section('A15 · 结构守卫：轮询阶段绝不允许重新提交（会重复消耗额度）');
  {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    const retryAt = src.indexOf('withSubmitRetry(');
    const pollAt = src.indexOf('tiktok.poll(');
    ok('withSubmitRetry 只出现一次', (src.match(/withSubmitRetry\(/g) || []).length === 1);
    ok('它被包在提交段（早于 poll）', retryAt > 0 && retryAt < pollAt, `${retryAt} < ${pollAt}`);
    // poll 的 catch 分支里不许出现 tiktok.submit
    const tail = src.slice(pollAt);
    const catchIdx = tail.indexOf('catch (err)');
    const catchBody = catchIdx >= 0 ? tail.slice(catchIdx, tail.indexOf('throw e;', catchIdx)) : '';
    ok('poll 的 catch 分支里没有 tiktok.submit', !/tiktok\.submit\(/.test(catchBody));
    ok('poll 失败时的注释写明了「不重新提交」', /不重新提交|不重提/.test(catchBody));
  }
}

// ---------------------------------------------------------------------------
// B 段 · 接线（子进程起真 index.js + 假号池）
// ---------------------------------------------------------------------------
function startFakePool(mode) {
  const seen = { sessions: [], reports: [], claims: 0, stats: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const send = (code, obj) => {
        const b = Buffer.from(JSON.stringify(obj), 'utf8');
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': String(b.length) });
        res.end(b);
      };

      if (u.pathname === '/api/v1/agent/stats') {
        seen.stats += 1;
        return send(200, {
          ok: true, backends: ['tiktok_r2v'], pending_agent: 0, agent_running: 0,
        });
      }
      if (u.pathname === '/api/v1/agent/claim') {
        seen.claims += 1;
        return send(200, { ok: true, task: null });
      }
      if (u.pathname === '/api/v1/agent/session') {
        seen.sessions.push({
          backend: u.searchParams.get('backend'),
          since: Number(u.searchParams.get('since') || 0),
          agent_id: u.searchParams.get('agent_id') || '',
        });
        if (mode === 'boom') return send(500, { detail: 'selftest: 号池内部错误' });
        if (mode === 'unconfigured') {
          return send(200, {
            ok: true, backend: 'tiktok_r2v', configured: false, version: 0,
            session: null, server_ts: 1,
          });
        }
        return send(200, {
          ok: true, backend: 'tiktok_r2v', configured: true, changed: true,
          version: 1, expires_ts: 0, session: sess('dev-pool-b1'), server_ts: 1,
        });
      }
      if (u.pathname === '/api/v1/agent/session/report') {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* 保持空对象 */ }
        seen.reports.push(body);
        return send(200, { ok: true, verify_ok: body.ok ? 1 : 0, server_ts: 1 });
      }
      if (u.pathname.startsWith('/api/v1/agent/heartbeat')
        || u.pathname.startsWith('/api/v1/agent/result')) {
        return send(200, { ok: true });
      }
      return send(404, { detail: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, port: server.address().port });
    });
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function getJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** 起一个真进程的节点，stdout/stderr 全部留档（既要断言，也要做泄漏扫描）。 */
function runNode(env, probeMode = 'alive') {
  const child = spawn(NODE, ['-r', STUB, 'index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RH_LOG_LEVEL: 'info',
      SELFTEST_PROBE: probeMode,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const buf = { out: '', err: '' };
  child.stdout.on('data', (c) => { buf.out += c.toString('utf8'); });
  child.stderr.on('data', (c) => { buf.err += c.toString('utf8'); });
  const closed = new Promise((r) => child.on('close', () => r()));
  return { child, buf, closed, all: () => buf.out + buf.err };
}

async function waitReady(port, pred, ms = 12000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const r = await getJson(`http://127.0.0.1:${port}/status`);
      last = r.json;
      if (r.status === 200 && pred(r.json)) return last;
    } catch { /* 还没起来 */ }
    await sleep(120);
  }
  throw new Error('等待 /status 超时；最后一份：' + JSON.stringify(last));
}

async function stopNode(h) {
  h.child.kill('SIGKILL');
  await Promise.race([h.closed, sleep(3000)]);
}

/**
 * 跑一个接线场景。
 * `env` 里**不要**放 RH_POOL_URL / PORT —— 由这里统一注入。
 */
async function scenario(title, { mode, probe = 'alive', env = {}, readyPred, check }) {
  section(title);
  const pool = await startFakePool(mode);
  const port = await freePort();
  const h = runNode({
    RH_POOL_URL: `http://127.0.0.1:${pool.port}`,
    RH_AGENT_TOKEN: 'selftest-token',
    PORT: String(port),
    HOST: '127.0.0.1',
    RH_POLL_SECONDS: '2',
    RH_SESSION_REFRESH_SECONDS: '600',
    RH_MIRROR_URL: 'http://127.0.0.1:1/collect',
    ...env,
  }, probe);

  let status = null;
  let err = null;
  try {
    status = await waitReady(port, readyPred || ((s) => s.session_pool && s.session_pool.at > 0));
  } catch (e) { err = e; }
  await sleep(250);

  const ctx = {
    status, err, pool, out: h.all(),
    reports: pool.seen.reports, sessions: pool.seen.sessions, buf: h.buf,
  };
  try {
    if (err) { ok('节点在预期时间内就绪', false, err.message.slice(0, 160)); } else { check(ctx); }
  } finally {
    await stopNode(h);
    await new Promise((r) => pool.server.close(r));
  }
}

async function partB() {
  // =========================================================================
  await scenario('B1 · 号池已配 → 启动即领取、验活、回报（且凭据不出现在任何观测面）', {
    mode: 'configured',
    readyPred: (s) => s.session_origin === 'cache'
      && s.session_probe && s.session_probe.ok === true,
    check: (ctx) => {
      const s = ctx.status;
      ok('节点活着', s && s.ok === true);
      ok('凭据已就绪', s.session_ready === true);
      ok('来源是号池缓存（不是本地环境变量）', s.session_origin === 'cache', String(s.session_origin));
      ok('暴露了号池版本号', s.session_pool.version === 1, String(s.session_pool.version));
      ok('标记录到「拿到了新凭据」', s.session_pool.changed === true);
      ok('来源策略如实暴露', s.session_source === 'auto', String(s.session_source));
      ok('backend 也暴露出来', s.session_backend === 'tiktok_r2v');
      ok('探活结论写进了 /status', s.session_probe && s.session_probe.ok === true,
        JSON.stringify(s.session_probe));
      ok('节点带上了自己的版本号去问（首轮为 0）', ctx.sessions[0].since === 0);
      ok('节点带了 agent_id（号池日志要认人）',
        ctx.sessions[0].agent_id === s.agent_id, ctx.sessions[0].agent_id);
      ok('验活结论回报到了号池', ctx.reports.length === 1, String(ctx.reports.length));
      ok('回报结论为「有效」', ctx.reports[0] && ctx.reports[0].ok === true);
      ok('回报带了版本号 v1', ctx.reports[0] && ctx.reports[0].version === 1);
      ok('回报带了失效码字段', ctx.reports[0] && 'code' in ctx.reports[0]);

      // ---- 泄漏扫描（本段最值钱的一条）----
      ok('stdout 里没有凭据值', !ctx.out.includes(COOKIE_SENTINEL));
      ok('/status 里没有凭据值', !JSON.stringify(s).includes(COOKIE_SENTINEL));
      ok('stdout 里没有 cookie 明文片段', !ctx.out.includes('sessionid_ads='));
      ok('日志确实说了「从号池领取」',
        /已从号池领取会话凭据 v1/.test(ctx.out), '');
      ok('日志点明了来源是控制台', /来源 号池控制台/.test(ctx.out));
    },
  });

  // =========================================================================
  await scenario('B2 · 号池那份其实是死的 → 结论回报为「已失效」，节点不许崩', {
    mode: 'configured',
    probe: 'dead',
    readyPred: (s) => s.session_probe && s.session_probe.ok === false,
    check: (ctx) => {
      const s = ctx.status;
      ok('进程没崩，/status 仍然可读', s && s.ok === true);
      ok('验活结论是「失效」', s.session_probe.ok === false);
      ok('带上了业务码 10001106', s.session_probe.code === 10001106, String(s.session_probe.code));
      ok('失效结论回报到了号池（控制台据此变红）',
        ctx.reports.length === 1 && ctx.reports[0].ok === false);
      ok('回报里带了失效码', ctx.reports[0].code === 10001106);
      ok('日志给出了下一步（去控制台换，不用重部署）',
        /控制台/.test(ctx.out) && /无需重部署|不用动这个节点/.test(ctx.out), '');
    },
  });

  // =========================================================================
  await scenario('B3 · 号池没配 + 本地有 → 回落 env，并如实标注来源', {
    mode: 'unconfigured',
    env: { RH_SESSION_JSON: b64(sess('dev-env-b3')) },
    readyPred: (s) => s.session_ready === true && s.session_origin === 'env'
      && s.session_probe && s.session_probe.at > 0,
    check: (ctx) => {
      const s = ctx.status;
      ok('照常可用（没被号池的空配置拖死）', s.session_ready === true);
      ok('来源如实标成 env', s.session_origin === 'env', String(s.session_origin));
      ok('号池版本号保持 0（因为是本地那份）', s.session_pool.version === 0);
      ok('日志明确说了是回落，且提醒「控制台换了也不影响它」',
        /回落本地凭据/.test(ctx.out) && /控制台换了也不会影响/.test(ctx.out), '');
    },
  });

  // =========================================================================
  await scenario('B4 · 号池没配 + 本地也没有 → 明确不可用，并指向控制台', {
    mode: 'unconfigured',
    readyPred: (s) => s.session_pool && s.session_pool.at > 0,
    check: (ctx) => {
      const s = ctx.status;
      ok('进程仍然活着（能接单，只是干不了活）', s && s.ok === true);
      ok('凭据不可用', s.session_ready === false);
      ok('日志说了「号池没有可用的会话凭据」', /号池没有可用的会话凭据/.test(ctx.out));
      ok('日志指向控制台而不是环境变量',
        /号池控制台的「TikTok 会话凭据」/.test(ctx.out), '');
      ok('日志点明不需要重新部署', /不用重新部署/.test(ctx.out));
    },
  });

  // =========================================================================
  await scenario('B5 · 号池 500 → 保留本地那份继续用，不崩、不静默降级', {
    mode: 'boom',
    env: { RH_SESSION_JSON: b64(sess('dev-env-b5')) },
    readyPred: (s) => s.session_pool && s.session_pool.at > 0 && s.session_pool.ok === false,
    check: (ctx) => {
      const s = ctx.status;
      ok('进程没崩', s && s.ok === true);
      ok('本地那份照常可用', s.session_ready === true);
      ok('来源是 env（号池坏了不等于没配）', s.session_origin === 'env', String(s.session_origin));
      ok('号池状态记为失败', s.session_pool.ok === false);
      ok('失败原因被记下来了', String(s.session_pool.error).length > 0);
      ok('日志说了拉取失败并标注「继续用本地缓存/本地凭据」',
        /会话凭据拉取失败/.test(ctx.out), '');
    },
  });

  // =========================================================================
  await scenario('B6 · RH_SESSION_SOURCE=pool + 号池没配 → 硬失败，绝不偷用本地', {
    mode: 'unconfigured',
    env: {
      RH_SESSION_SOURCE: 'pool',
      RH_SESSION_JSON: b64(sess('dev-env-b6')),
    },
    readyPred: (s) => s.session_pool && s.session_pool.at > 0 && s.session_pool.ok === false,
    check: (ctx) => {
      const s = ctx.status;
      ok('凭据不可用', s.session_ready === false);
      ok('来源为空（本地明明有也不认）', s.session_origin === null, String(s.session_origin));
      ok('日志点明了 RH_SESSION_SOURCE=pool', /RH_SESSION_SOURCE=pool/.test(ctx.out));
    },
  });

  // =========================================================================
  await scenario('B7 · RH_SESSION_SOURCE=env → 一个请求都不发给 /agent/session', {
    mode: 'configured',
    env: {
      RH_SESSION_SOURCE: 'env',
      RH_SESSION_JSON: b64(sess('dev-env-b7')),
    },
    readyPred: (s) => s.session_ready === true && s.pool_reachable === true,
    check: (ctx) => {
      const s = ctx.status;
      ok('凭据可用（走的是环境变量）', s.session_ready === true);
      ok('来源标成 env', s.session_origin === 'env', String(s.session_origin));
      ok('**一次都没问号池要凭据**', ctx.sessions.length === 0, String(ctx.sessions.length));
      ok('但号池通道本身是通的（自检过了）', s.pool_reachable === true);
    },
  });
}

(async () => {
  console.log('='.repeat(70));
  console.log('会话凭据 · 号池持有 / 控制台切换 / 节点按需索取 —— 离线自测');
  console.log('='.repeat(70));

  await partA();
  await partB();

  console.log('\n' + '='.repeat(70));
  console.log(failures ? `${failures} 项断言未通过 ✗` : '会话凭据自测全部通过 ✓');
  console.log('='.repeat(70));
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('自测自身出错：', err && err.stack || err);
  process.exit(2);
});
