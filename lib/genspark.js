'use strict';
/**
 * Genspark 生图执行器（backend = genspark_image）。
 *
 * 为什么改成浏览器执行面（2026-09-28 晚，替代初版纯 HTTP）
 * ------------------------------------------------------
 * 初版用 node fetch 直发 ask_proxy 纯 HTTP，VPS 上 5 单全挂在 CF：
 * 裁决实验（同一台 KV-M2、同一 IP）实锤——curl/node 纯 HTTP 连首页都 403
 * 「Just a moment」，而 Chrome 页面内 fetch('/api/user') 在全新 profile、
 * 未登录、无 cf_clearance 的情况下 200。拦截变量是 **TLS/HTTP2 客户端指纹**
 * 而非 IP、也非请求参数。⟹ 执行面必须是真浏览器：Playwright 常驻
 * Chromium 持久 profile（每账号一个，模式与 aistudio 相同），任务在
 * **页面上下文里注入 fetch** 走 ask_proxy SSE —— 所有请求都长着
 * 「真 Chrome 的脸」，CF 放行。cookie 只需 session_id 一个。
 *
 * project_id 的自举（关键实测结论，沿用初版）
 * --------------------------------
 * ask_proxy 的 project_id **必须真实存在**（随机 UUID 直接 HTTP 500），
 * 但项目可以用 cookie 自己创建：
 *     POST /api/project/create   →  200 {"status":0,"data":{"id":"<uuid>"}}
 * project_id 缓存在内存里随账号走。用户录入时不需要提供 cookie 之外的字段。
 *
 * 额度墙（5h 滚动窗口）
 * --------------------
 * HTTP 恒 200；额度耗尽时 SSE 里出现
 *     field_name: "session_state.session_limit_message"
 *     field_value: "AI Image [5-hour limit] reached. Resets {time:<epoch>}"
 * 且 results 为空。解析出重置 epoch 抛 QuotaLimitError(resetTs)，由
 * index.js 的换号 failover 接手：账号回报 sleep_until（+30min 缓冲）、
 * 任务转下一个账号的空槽（最多 5 个账号）。
 *
 * 静默纠偏（必读）
 * --------------
 * agent 对非法参数**不报错、静默回落**：model:"gpt-image-99" → gpt-image-2，
 * image_size:"8k" → 4k。所以真实生效值必须读 results[].model —— 本执行器
 * 把它放进返回值，调用方落日志/记账一律以它为准。
 *
 * 并发模型（2026-09-28 用户口径）
 * --------
 * 每账号并发 = 号池 max_slots（默认 5）；**整机 tab 上限 = RH_TAB_LIMIT
 * （默认 8），由 cfg.tabPool（lib/tabPool.js）在 aistudio 与 genspark 两个
 * 执行面之间共享，按任务到达时间 FIFO 发牌**。任务执行 = 一个页面
 * （tab），跑完即关页并归还全局槽位（不养空闲 tab 占坑）。
 */

const crypto = require('node:crypto');
const path = require('node:path');

const BASE = 'https://www.genspark.ai';

/** 允许的分辨率档（与号池 config.external_backends.genspark_image.resolutions 一致）。 */
const SIZES = new Set(['1K', '2K', '4K']);
/** 允许的模型（号池 models[].model_id）。 */
const MODELS = new Set(['gpt-image-2', 'gpt-image-2.5']);

/** cookie 失效：借 10001106 通道走号池的「标记失效 + 换号重试」路径。 */
class AuthExpiredError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'AuthExpiredError';
    this.authExpired = true;
    this.upstreamCode = '10001106';
  }
}

/** 5h 额度墙：带官方重置 epoch，index.js 据此回报 sleep_until 并换号。 */
class QuotaLimitError extends Error {
  constructor(resetTs, raw) {
    super(`Genspark 5h 额度窗口已用尽（官方重置点 ${new Date(resetTs * 1000)
      .toLocaleString('zh-CN', { hour12: false })}），账号休眠至重置点 + 30 分钟，任务转其他账号`);
    this.name = 'QuotaLimitError';
    this.resetTs = Number(resetTs) || 0;
    this.quotaLimited = true;
    this.errorKind = 'QUOTA';
    this.raw = String(raw || '').slice(0, 300);
  }
}

/** 从 cookie 串里取单个键值（探活/诊断用）。 */
function cookieValue(cookieStr, name) {
  for (const seg of String(cookieStr || '').split(';')) {
    const i = seg.indexOf('=');
    if (i <= 0) continue;
    if (seg.slice(0, i).trim() === name) return seg.slice(i + 1).trim();
  }
  return '';
}

/** 解析 SSE 全文（保留给诊断/外部调用用；执行路径用页内流式解析）。 */
function parseSse(text) {
  const results = [];
  let limitRaw = '';
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let ev;
    try { ev = JSON.parse(line.slice(6)); } catch { continue; }
    if (ev && ev.field_name === 'image_generation_agent.results') {
      const v = ev.field_value;
      if (Array.isArray(v)) results.push(...v.filter((x) => x && typeof x === 'object'));
    } else if (ev && ev.field_name === 'session_state.session_limit_message') {
      limitRaw = String((ev.field_value || '').value ?? ev.field_value ?? '');
    }
  }
  // session_limit_message 形如 "AI Image [5-hour limit](...) reached. Resets {time:1790595239}"
  const m = /\{time:(\d+)\}/.exec(limitRaw);
  return {
    results,
    limitRaw,
    resetTs: m ? Number(m[1]) : 0,
    limited: Boolean(m) || /limit[^]{0,40}reached/i.test(limitRaw),
  };
}

/** 判定一个 403 响应体是不是 Cloudflare 挑战页（区分「cookie 失效」与「指纹/IP 被拦」）。 */
function isCfChallenge(text) {
  return /just a moment|challenge-platform|cf-browser-verification|attention required/i
    .test(String(text || '').slice(0, 2000));
}

// ---------------------------------------------------------------------------
// 页面上下文里跑的脚本（真函数：page.evaluate 会序列化源码到页内执行；
// 不要用多行字符串——Playwright 对字符串函数探测在带前导换行时会失效，
// 返回 undefined，2026-09-28 实测）。
// ---------------------------------------------------------------------------

/** 页内流式消费 ask_proxy SSE：边读边解析，出 results / session_limit_message。 */
const PAGE_ASK_PROXY = async ({ body, timeoutMs }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('deadline'), timeoutMs);
  try {
    const res = await fetch('/api/agent/ask_proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': '*/*' },
      body: JSON.stringify(body),
      credentials: 'include',
      signal: ctrl.signal,
    });
    const text0 = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, status: res.status, text: text0.slice(0, 400) };
    // text() 一次性等全量（生成结束流自然关闭），超时由 ctrl.abort 兜底。
    const results = [];
    let limitRaw = '';
    for (const line of text0.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev && ev.field_name === 'image_generation_agent.results') {
        const v = ev.field_value;
        if (Array.isArray(v)) results.push(...v.filter((x) => x && typeof x === 'object'));
      } else if (ev && ev.field_name === 'session_state.session_limit_message') {
        limitRaw = String((ev.field_value || '').value ?? ev.field_value ?? '');
      }
    }
    return { ok: true, results, limitRaw };
  } catch (err) {
    return { ok: false, status: 0, text: '', net: String((err && err.message) || err) };
  } finally { clearTimeout(timer); }
};

/** 页内下载成图 → base64（同源 /api/files 带凭据；跨域 CDN 无 CORS 时由调用方走 page.goto 回落）。 */
const PAGE_FETCH_B64 = async (url) => {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) return { ok: false, status: r.status };
  const buf = await r.arrayBuffer();
  const u8 = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return { ok: true, contentType: r.headers.get('content-type') || 'image/png', b64: btoa(bin) };
};

/** 页内 GET /api/user（探活 + 会员档）。响应很大，必须在页内解析完再回传。 */
const PAGE_GET_USER = async () => {
  const res = await fetch('/api/user', { credentials: 'include', headers: { accept: 'application/json' } });
  const text = await res.text().catch(() => '');
  let cogen = {};
  try {
    const data = JSON.parse(text);
    cogen = (data && data.data && data.data.cogen) || {};
  } catch { /* 非 JSON（挑战页等），原样带回前段供判定 */ }
  return {
    status: res.status,
    email: String(cogen.email || ''),
    name: String(cogen.name || ''),
    plan: String(cogen.plan || (cogen.personal_membership_ext || {}).status || ''),
    head: text.slice(0, 300),
  };
};

/** 页内 POST /api/project/create。 */
const PAGE_CREATE_PROJECT = async () => {
  const r = await fetch('/api/project/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ article: '# image' }),
    credentials: 'include',
  });
  const text = await r.text().catch(() => '');
  return { status: r.status, text: text.slice(0, 400) };
};

// ---------------------------------------------------------------------------

class GensparkAccount {
  /**
   * @param {{accountKey: string|number, cookie: string, cfg: object,
   *           log: function}} opts
   */
  constructor({ accountKey, cookie, cfg, log }) {
    this.key = String(accountKey);
    this.cookie = String(cookie || '');
    this.cfg = cfg;
    this.log = log || (() => {});
    this.projectId = '';     // 账号级缓存：首次执行自动创建
    this.lastError = null;   // /status 远程可见的最近一次错误
    this.created = 0;        // 生图成功计数（本进程生命周期内）
    this.profileDir = path.resolve(
      String(cfg.gensparkProfileDir || 'data/genspark-profiles'), `gs-${this.key}`);
    this.context = null;     // Playwright 持久上下文（懒启动）
    this.tabs = [];          // [{ page, permit }] —— 只含在跑的 tab
    this._ensuring = null;
    this._pendingClose = false; // 换 cookie/删账号时延迟关闭：等在跑任务收尾
  }

  get valid() {
    return Boolean(cookieValue(this.cookie, 'session_id'));
  }

  get busyTabs() {
    return this.tabs.length;
  }

  /** cookie 串 → Playwright addCookies 数组（全部落在 genspark.ai 域）。 */
  _cookieArray() {
    const out = [];
    for (const seg of this.cookie.split(';')) {
      const i = seg.indexOf('=');
      if (i <= 0) continue;
      const name = seg.slice(0, i).trim();
      const value = seg.slice(i + 1).trim();
      if (!name || !value) continue;
      out.push({
        name, value, domain: '.genspark.ai', path: '/',
        secure: true, httpOnly: false, sameSite: 'Lax',
      });
    }
    return out;
  }

  /** 启动持久上下文 + 注入 cookie + 抹 webdriver。 */
  async _launch() {
    let pw;
    try {
      pw = require('playwright');
    } catch (e) {
      throw new Error(`未安装 playwright（npm i playwright）—— Genspark 浏览器执行面不可用：${e.message}`);
    }
    const t0 = Date.now();
    // 🔴 默认有头（RH_GENSPARK_HEADLESS=1 才无头）：CF 按 TLS/HTTP2 指纹打分，
    // 2026-09-28 裁决实验实锤真 Chrome 指纹放行。跟 aistudio 一样要求
    // DISPLAY=:98 虚拟屏（rhnode.service 已注入）。
    const headed = !this.cfg.gensparkHeadless;
    this.context = await pw.chromium.launchPersistentContext(this.profileDir, {
      headless: !headed,
      args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900',
        '--disable-blink-features=AutomationControlled',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: { width: 1440, height: 900 },
      timeout: 60_000,
    });
    const cookies = this._cookieArray();
    if (cookies.length) await this.context.addCookies(cookies);
    // 抹 navigator.webdriver（CF JS 探针会查）；
    // 有头真 Chrome 的 UA/client-hints 本来就正常，无需 aistudio 那套 CDP 伪造。
    await this.context.addInitScript(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch { /* 旧内核 */ }
    });
    this.log(`  [gs#${this.key}] Chromium 已启动（profile=${this.profileDir}`
      + `，${headed ? '有头' : '无头'}，${Math.round((Date.now() - t0) / 100) / 10}s）`);
  }

  /** 懒启动（并发调用共享同一次启动）。 */
  ensure() {
    if (this.context) return Promise.resolve(this.context);
    if (!this._ensuring) {
      this._ensuring = this._launch()
        .catch((err) => { this.lastError = `${err.name || 'Error'}: ${err.message}`.slice(0, 200); throw err; })
        .finally(() => { this._ensuring = null; });
    }
    return this._ensuring;
  }

  /** 打开一个新页面并落在 genspark.ai 首页（确保后续 fetch 是同源、真实指纹）。 */
  async _newPageAtBase() {
    const page = await this.context.newPage();
    try {
      if (!String(page.url()).startsWith(BASE)) {
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
      return page;
    } catch (err) {
      await page.close().catch(() => {});
      throw new Error(`Genspark 首页导航失败（CF 挑战或网络）：${err.message}`);
    }
  }

  /** 领单闸：本账号还有空槽 **且** 全局 tab 池此刻有富余（无人排队）。 */
  hasFreeTab() {
    const cap = Math.max(1, Number(this.cfg.gensparkTabs) || 5);
    if (this.tabs.length >= cap) return false;
    const pool = this.cfg.tabPool;
    if (pool && !pool.canTakeNow) return false;
    return true;
  }

  /**
   * 取一个 tab：先过全局 tab 池（FIFO，按到达时间），再开页面。
   * 账号内无空槽返回 null；全局池等待超时抛错（调用方按上游错误处置）。
   */
  async acquireTab() {
    await this.ensure();
    const cap = Math.max(1, Number(this.cfg.gensparkTabs) || 5);
    if (this.tabs.length >= cap) return null;
    const pool = this.cfg.tabPool;
    // 等全局槽（最长 20 分钟，与 aistudio 的排队闸同口径；期间调用方的
    // beat 心跳由 executeGenspark 的排队循环维持——见 index.js）。
    const permit = pool
      ? await pool.acquire(`gs-${this.key}`, 20 * 60 * 1000)
      : { label: '' };
    try {
      const page = await this._newPageAtBase();
      const tab = { page, permit };
      this.tabs.push(tab);
      return tab;
    } catch (err) {
      pool && pool.release(permit);
      throw err;
    }
  }

  /** 收尾一个 tab：关页 + 归还全局槽位（不养空闲 tab 占坑）。 */
  async releaseTab(tab) {
    if (!tab) return;
    const i = this.tabs.indexOf(tab);
    if (i >= 0) this.tabs.splice(i, 1);
    if (tab.page) {
      await tab.page.close().catch(() => {});
    }
    if (this.cfg.tabPool) this.cfg.tabPool.release(tab.permit);
    if (this._pendingClose && !this.tabs.length) await this.close();
  }

  /**
   * 探活 + 会员档采集：页内 GET /api/user。
   * 返回 { email, plan, name }；401/403 → AuthExpiredError。
   */
  async health() {
    if (!this.valid) throw new AuthExpiredError('账号凭据缺少 session_id');
    await this.ensure();
    const page = await this._newPageAtBase();
    try {
      const r = await page.evaluate(PAGE_GET_USER);
      if (r.status === 401 || (r.status === 403 && !isCfChallenge(r.head))) {
        throw new AuthExpiredError(`Genspark cookie 失效（HTTP ${r.status}）`);
      }
      if (r.status === 403 && isCfChallenge(r.head)) {
        throw new Error('Genspark 探活被 Cloudflare 挑战页拦截（浏览器环境异常？）');
      }
      if (r.status !== 200) throw new Error(`Genspark /api/user HTTP ${r.status}`);
      return {
        email: String(r.email || ''),
        name: String(r.name || ''),
        plan: String(r.plan || '').toLowerCase(),
      };
    } finally {
      await page.close().catch(() => {});
      // 巡检是唯一「不接任务也拉起浏览器」的路径：查完就把浏览器收掉，
      // 空闲账号不常驻 Chromium（内存预算留给在跑任务；下次任务懒启动）。
      if (!this.tabs.length) await this.close().catch(() => {});
    }
  }

  /** 确保账号有一个可用 project_id（首次自动创建，之后缓存复用）。 */
  async ensureProject(page) {
    if (this.projectId) return this.projectId;
    const r = await page.evaluate(PAGE_CREATE_PROJECT);
    if (r.status === 401 || (r.status === 403 && !isCfChallenge(r.text))) {
      throw new AuthExpiredError(`Genspark cookie 失效（HTTP ${r.status}）`);
    }
    // 🔴 上游额度用尽（2026-09-28 实测：status:-8 "You've run out of credits"，
    // 挂在项目创建上而非 ask_proxy 的 session_limit_message）——按额度墙处置：
    // 抛 QuotaLimitError 让 index.js 回报 sleep_until + 立即换号，而不是按
    // UNKNOWN 错误干等 15 分钟。重置点未知，按 1.5h 保守休眠（到点重试，
    // 仍无额度会再次休眠）。
    if (/out of credits/i.test(String(r.text))) {
      throw new QuotaLimitError(Math.floor(Date.now() / 1000) + 5400,
        `project/create: ${String(r.text).slice(0, 200)}`);
    }
    if (r.status !== 200) {
      const e = new Error(`Genspark 项目创建 HTTP ${r.status}：${String(r.text).slice(0, 200)}`);
      e.errorKind = 'UPSTREAM_ERROR';
      throw e;
    }
    let parsed;
    try { parsed = JSON.parse(r.text); } catch {
      throw new Error(`Genspark 项目创建响应异常：${String(r.text).slice(0, 200)}`);
    }
    const pid = String((parsed && parsed.data && parsed.data.id) || '');
    if (!pid) throw new Error(`Genspark 项目创建响应异常：${String(r.text).slice(0, 200)}`);
    this.projectId = pid;
    this.log(`  [gs#${this.key}] 已创建工作项目 ${pid}`);
    return pid;
  }

  /**
   * 单次生图：{prompt, model, size, aspect} → {bytes, contentType, model, size, taskId}
   * model = 'gpt-image-2' | 'gpt-image-2.5'；size = '1K'|'2K'|'4K'；aspect = '1:1' 等。
   */
  async generate({ prompt, model, size, aspect } = {}) {
    if (!this.valid) throw new AuthExpiredError('账号凭据缺少 session_id');
    const wantModel = MODELS.has(String(model)) ? String(model) : 'gpt-image-2';
    const wantSize = SIZES.has(String(size || '').toUpperCase()) ? String(size).toUpperCase() : '1K';
    const tab = await this.acquireTab();
    if (!tab) throw new Error(`账号 #${this.key} 的 ${this.cfg.gensparkTabs || 5} 个 tab 全忙`);
    const { page } = tab;
    try {
      const pid = await this.ensureProject(page);
      const mid = crypto.randomUUID();
      const body = {
        model_params: {
          type: 'image', model: wantModel,
          aspect_ratio: String(aspect || '1:1'),
          auto_prompt: false, style: 'auto',
          image_size: wantSize.toLowerCase(),
          quality: 'auto',            // 免费档：上游 0 成本（用户口径：只用 auto）
          background_mode: true, camera_control: null, generation_count: 1,
        },
        writingContent: null, sas_ask_origin: 'typed', type: 'image_generation_agent',
        project_id: pid,
        messages: [{
          role: 'user', id: mid, content: String(prompt || ''), pending: true,
          sendStatus: 'sending', _deepDiveStateNegContent: String(prompt || ''), thinking: false,
        }],
        user_s_input: String(prompt || ''), client_message_id: mid,
        // ⚠️ 刻意不带 g_recaptcha_token：2026-09-28 实测完整删掉该字段照样出图。
        is_private: true, push_token: '', last_seen_event_index: -1,
        chat_session_id: crypto.randomUUID(),
      };
      const timeoutMs = Math.max(60, Number(this.cfg.gensparkTimeoutSeconds) || 300) * 1000;
      const res = await page.evaluate(PAGE_ASK_PROXY, { body, timeoutMs });
      if (!res.ok) {
        if (res.net) {
          const e = new Error(`Genspark 提交/读流失败（${Math.round(timeoutMs / 1000)}s 预算）：${res.net}`);
          e.errorKind = 'UPSTREAM_ERROR';
          throw e;
        }
        if (res.status === 401 || (res.status === 403 && !isCfChallenge(res.text))) {
          throw new AuthExpiredError(`Genspark cookie 失效（HTTP ${res.status}）`);
        }
        if (res.status === 403 && isCfChallenge(res.text)) {
          const e = new Error('Genspark ask_proxy 被 Cloudflare 挑战页拦截（浏览器指纹/IP 信誉变化，需要排查执行环境）');
          e.errorKind = 'UPSTREAM_ERROR';
          throw e;
        }
        const e = new Error(`Genspark ask_proxy HTTP ${res.status}：${String(res.text).slice(0, 200)}`);
        e.errorKind = 'UPSTREAM_ERROR';
        throw e;
      }
      const { results, limitRaw } = res;
      const m = /\{time:(\d+)\}/.exec(limitRaw);
      const limited = Boolean(m) || /limit[^]{0,40}reached/i.test(limitRaw);
      if (limited && !results.length) {
        throw new QuotaLimitError(m ? Number(m[1]) : 0, limitRaw);
      }
      if (!results.length) {
        const e = new Error('Genspark 流式响应结束但没有产出图片（无额度信号）——'
          + '可能 agent 文本作答或上游行为变化，请检查任务日志');
        e.errorKind = 'UPSTREAM_ERROR';
        throw e;
      }
      const ok = results.find((r) => r.status === 'SUCCESS') || results[0];
      // 🔴 静默纠偏后真实值（results[].model / image_size），记账以它为准
      const realModel = String(ok.model || wantModel);
      const realSize = String(ok.image_size || wantSize.toLowerCase()).toUpperCase();
      const url = (ok.image_urls_nowatermark && ok.image_urls_nowatermark[0])
        || (ok.image_urls && ok.image_urls[0]) || '';
      if (!url) {
        // 非 SUCCESS 项（status 缺失/失败）通常伴随上游错误（额度耗尽、内容
        // 拒绝等）——把现场带全，方便远程判读。
        const e = new Error(`Genspark 结果缺图片 URL（status=${ok.status}`
          + `｜item=${JSON.stringify(ok).slice(0, 260)}）`);
        if (/out of credits|credit/i.test(JSON.stringify(ok))) {
          throw new QuotaLimitError(Math.floor(Date.now() / 1000) + 5400, JSON.stringify(ok));
        }
        e.errorKind = 'UPSTREAM_ERROR';
        throw e;
      }

      // 成图下载：① 页内 fetch（同源带凭据，CF 放行）；② 跨域 CDN 无 CORS
      // 时回落 page.goto(url) 取 body（导航不受 CORS 限制，仍走浏览器 TLS）。
      let bytes;
      let contentType;
      const dl = await page.evaluate(PAGE_FETCH_B64, url).catch(() => ({ ok: false, status: -1 }));
      if (dl.ok) {
        bytes = Buffer.from(dl.b64, 'base64');
        contentType = dl.contentType;
      } else {
        const resp = await page.goto(url, { timeout: 180_000, waitUntil: 'commit' })
          .catch((err) => { throw new Error(`成图下载失败（页内 fetch HTTP ${dl.status}，导航也失败：${err.message.slice(0, 120)}）`); });
        if (!resp || !resp.ok()) {
          const e = new Error(`成图下载失败 HTTP ${resp ? resp.status() : '?'}（${url.slice(0, 90)}）`);
          e.errorKind = 'UPSTREAM_ERROR';
          throw e;
        }
        bytes = await resp.body();
        contentType = String((resp.headers() || {})['content-type'] || 'image/png');
      }
      if (!bytes || !bytes.length) throw new Error('成图下载结果为空');
      this.created += 1;
      this.lastError = null;
      return { bytes, contentType, model: realModel, size: realSize,
               taskId: String(ok.task_id || ''), promptUsed: String(ok.prompt || '') };
    } catch (err) {
      // 执行面任何失败都留底：/status 的 accounts[].last_error 远程可见。
      this.lastError = `${err.name || 'Error'}: ${err.message}`.slice(0, 200);
      throw err;
    } finally {
      await this.releaseTab(tab);
    }
  }

  /** 关浏览器（换 cookie/删账号时由 Pool 调；有在跑任务则延迟到收尾）。 */
  async close() {
    if (this.tabs.length) { this._pendingClose = true; return; }
    this._pendingClose = false;
    this.tabs = [];
    const ctx = this.context;
    this.context = null;
    if (ctx) { try { await ctx.close(); } catch { /* 已死进程 */ } }
  }
}

/** 账号池：accountKey → GensparkAccount。cookie 换新时热更（旧浏览器延迟回收）。 */
class GensparkPool {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.accounts = new Map();   // key → {account, sig}
  }

  get(accountKey, cookie) {
    const key = String(accountKey);
    const sig = String(cookie || '');
    let entry = this.accounts.get(key);
    if (!entry) {
      entry = { account: new GensparkAccount({ accountKey: key, cookie, cfg: this.cfg, log: this.log }), sig };
      this.accounts.set(key, entry);
    } else if (entry.sig !== sig) {
      // 换 cookie（version+1）：换新执行会话（新 profile 落新 cookie），项目缓存作废；
      // 旧浏览器**延迟关闭**（有任务在跑时等它收尾，见 GensparkAccount.close）。
      entry.sig = sig;
      const old = entry.account;
      entry.account = new GensparkAccount({ accountKey: key, cookie, cfg: this.cfg, log: this.log });
      old.close().catch(() => {});
      this.log(`  [gs#${key}] cookie 已更新（v+1），执行会话重开`);
    }
    return entry.account;
  }

  /** 控制台已删账号的内存清理：关浏览器 + 删磁盘 profile（有任务在跑则延迟）。 */
  async reconcile(validKeys) {
    const keep = new Set(validKeys.map(String));
    for (const key of [...this.accounts.keys()]) {
      if (keep.has(key)) continue;
      const entry = this.accounts.get(key);
      this.accounts.delete(key);
      if (entry) {
        await entry.account.close().catch(() => {});
        this.log(`  [gs#${key}] 账号已删除，执行会话关闭`);
      }
    }
  }

  status() {
    const pool = this.cfg.tabPool;
    return {
      enabled: Boolean(this.cfg.gensparkEnabled),
      global_tabs: pool ? pool.status() : null,
      accounts: [...this.accounts.entries()].map(([key, e]) => ({
        key,
        busy_tabs: e.account.busyTabs,
        has_project: Boolean(e.account.projectId),
        generated: e.account.created,
        last_error: e.account.lastError || null,
      })),
    };
  }
}

module.exports = {
  GensparkPool,
  AuthExpiredError,
  QuotaLimitError,
  parseSse,
  cookieValue,
  isCfChallenge,
  MODELS,
  SIZES,
};
