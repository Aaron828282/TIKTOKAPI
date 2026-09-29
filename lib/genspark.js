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
 * 「真 Chrome 的脸」，CF 放行。凭据两种形态（2026-09-29 起）：
 *   · cookie 型（后备）：只需 session_id 一个；
 *   · genspark_login 型（推荐）：邮箱+密码，节点在持久 profile 里自登录，
 *     登录态 profile 常驻自持，失效自动重登（Genspark 无 2SV，纯填表）。
 *
 * project_id 的自括（2026-09-29 作废 → 改 null 新会话制）：
 * 旧结论「ask_proxy 的 project_id 必须真实存在（随机 UUID 500），缓存复用」
 * 被网页版抓包推翻：UI 每次都传 project_id:null 由服务端新建会话——
 * 复用固定 project 反而触发会话级 5h 上限。null 即正解，不再需要建项目。
 * （/api/project/create 老 payload {article:'# image'} 会返回 -8 假额度墙，
 * 该接口已从生图链路摘除。）
 *
 * 额度墙（5h 窗口 —— 2026-09-29 用户口径终版：账号级，跨会话/跨模型共用）
 * --------------------
 * SSE 里出现
 *     field_name: "session_state.session_limit_message"
 *     field_value: "AI Image [5-hour limit] reached. Resets {time:<epoch>}"
 * 即该账号的 5h 额度池耗尽——池子按账号计：同一账号无论开多少个会话窗口、
 * 用哪个模型，共用同一份额度，触顶时间相同（用户口径 2026-09-29）。
 * 旧注释「按会话计」系假墙混淆：当年 28 张单会话撞墙 + UI 还能出图，
 * 实为缺 reCAPTCHA token 的风控软拦截（被拒请求不耗额度，UI 自然无恙），
 * 两者文案相同。真伪判据看重置点：真墙=固定 epoch；假墙=滚动(当前+90min)。
 * project_id:null 每单新会话保留（对齐 UI 行为、避开旧会话上下文膨胀）；
 * 解析逻辑作为兜底：解析出重置 epoch 抛 QuotaLimitError(resetTs)，
 * 由 index.js 的换号 failover 接手：账号回报 sleep_until（+30min 缓冲）、
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

/** 5h 额度墙：带官方重置 epoch（「Approaching」临限拒绝时为 0），index.js 据此回报 sleep_until 并换号。 */
class QuotaLimitError extends Error {
  constructor(resetTs, raw) {
    super(`Genspark 5h 额度窗口已用尽（${
      Number(resetTs)
        ? `官方重置点 ${new Date(resetTs * 1000).toLocaleString('zh-CN', { hour12: false })}`
        : '临限拒绝，上游未下发重置点'
    }），账号休眠至${Number(resetTs) ? '重置点' : '现在'} + 30 分钟，任务转其他账号`);
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

/** 邮箱脱敏（日志用）。 */
function maskEmail(email) {
  return String(email || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
}

// ---------------------------------------------------------------------------
// 页面上下文里跑的脚本（真函数：page.evaluate 会序列化源码到页内执行；
// 不要用多行字符串——Playwright 对字符串函数探测在带前导换行时会失效，
// 返回 undefined，2026-09-28 实测）。
// ---------------------------------------------------------------------------

/**
 * 🔴 reCAPTCHA token（2026-09-29 关键修复）：
 * 上游对**缺失 g_recaptcha_token** 的 ask_proxy 会返回伪装成限额的软拦截
 * （session_limit_message: "AI Image [5-hour limit] reached. Resets {time}"，
 * 且重置点滚动 = 当前时间+90min，实锤不是真窗口）。9/28 时缺 token 还能过，
 * 之后收紧。UI 每次都带 token —— 这里页内现签：enterprise key + action:'ask'。
 * token 有效期约 2 分钟且单次使用，必须每单现取。
 */
const RECAPTCHA_SITE_KEY = '6Leq7KYqAAAAAGdd1NaUBJF9dHTPAKP7DcnaRc66';

/** 页内取 reCAPTCHA token：没有 grecaptcha 就注入 enterprise 脚本再 execute。 */
const PAGE_GET_RECAPTCHA_TOKEN = async (siteKey) => {
  let g = window.grecaptcha;
  if (!g) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = `https://www.google.com/recaptcha/enterprise.js?render=${siteKey}`;
      s.onload = res;
      s.onerror = () => rej(new Error('recaptcha script load fail'));
      document.head.appendChild(s);
      setTimeout(() => rej(new Error('recaptcha script timeout')), 10_000);
    }).catch(() => {});
    g = window.grecaptcha;
  }
  if (!g) throw new Error('window.grecaptcha 不可用');
  const ent = g.enterprise || g;
  return new Promise((res, rej) => {
    let done = false;
    ent.ready(() => {
      ent.execute(siteKey, { action: 'ask' }).then((t) => {
        if (!done) { done = true; res(String(t)); }
      }, (e) => { if (!done) { done = true; rej(e); } });
    });
    setTimeout(() => { if (!done) { done = true; rej(new Error('recaptcha execute timeout')); } }, 8000);
  });
};

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
  let code = null;      // 业务码：0=成功，负数=业务错误（-5=user not found 匿名访客）
  try {
    const data = JSON.parse(text);
    if (data && typeof data.status === 'number') code = data.status;
    cogen = (data && data.data && data.data.cogen) || {};
  } catch { /* 非 JSON（挑战页等），原样带回前段供判定 */ }
  return {
    status: res.status,
    code,
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
   * @param {{accountKey: string|number, creds: object, cfg: object,
   *           log: function}} opts
   *   creds = lib/session.js normalizeGsSession 产物：
   *     { kind:'cookie', cookie } 或
   *     { kind:'genspark_login', email, password, cookie? }
   *   （兼容旧调用：传字符串按 {kind:'cookie'} 处理。）
   */
  constructor({ accountKey, creds, cfg, log }) {
    this.key = String(accountKey);
    this.creds = (typeof creds === 'string')
      ? { kind: 'cookie', cookie: creds }
      : (creds || { kind: 'cookie', cookie: '' });
    this.cookie = String(this.creds.cookie || '');
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
    this._authRetried = false;  // generate() 失效重登重试的一次性闸
    this._pendingClose = false; // 换 cookie/删账号时延迟关闭：等在跑任务收尾
    this._lastSubmitAt = 0;     // 频率闸：上次 ask_proxy 提交时刻（见 RH_GENSPARK_MIN_INTERVAL_SECONDS）
  }

  get valid() {
    // 登录型：凭据齐即视为可用（会话本身由 profile 自持 + _ensureLogin 保障）；
    // cookie 型：认 session_id。
    if (this.creds.kind === 'genspark_login') {
      return Boolean(this.creds.email && this.creds.password);
    }
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
    // 登录型凭据：profile 自持会话优先（日常路径秒过）；无会话才走
    // 填表自动登录（Genspark 无 2SV，实测密码提交直接进）。cookie 型不进
    // 这条路 —— 会话失效直接抛 AuthExpiredError 走换号/换 cookie。
    if (this.creds.kind === 'genspark_login') {
      await this._ensureLogin();
    }
  }

  /**
   * 登录型凭据的会话保障（2026-09-29）：页内 GET /api/user 探活 ——
   * 200 且**响应里有邮箱** = profile 自持，直接用；其余（401/403，或
   * 200 但匿名 guest 响应）= 走登录页填表重登。
   * 🔴 判定口径（2026-09-29 实测修正）：Genspark 对匿名访客 /api/user 返回
   *    **HTTP 200** + body {"status":-5,"message":"user not found"}（无邮箱）——
   *    只看 HTTP 状态码会把空 profile 误判成「已登录」，真账号永远不触发
   *    自动登录，然后带着空会话生图 401。登录判定必须认邮箱在场。
   * 登录成功后新会话自然落盘 profile（launchPersistentContext 持久化）。
   */
  async _ensureLogin() {
    const page = await this._newPageAtBase();
    try {
      const r = await page.evaluate(PAGE_GET_USER).catch(() => ({ status: 0, head: '' }));
      if (r.status === 200 && r.email) {
        this.log(`  [gs#${this.key}] profile 自持会话有效`
          + `（${r.email}，plan=${r.plan || '?'}），跳过登录`);
        return;
      }
      if (r.status === 403 && isCfChallenge(r.head)) {
        throw new Error('登录前探活被 Cloudflare 挑战页拦截（浏览器环境异常？）');
      }
      if (r.status !== 401 && r.status !== 403
        && !(r.status === 200 && !r.email)) {
        throw new Error(`登录前探活异常（HTTP ${r.status}，code=${r.code}）`);
      }
      await this._fillLoginPage(page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * 登录页自动登录（2026-09-29 二次校准）：
   *
   * **谷歌邮箱账号（主流）→ Google OAuth**，实测全链路：
   *   www.genspark.ai/login → Azure B2C provider 选择页（login.genspark.ai）
   *   → 点 #GoogleExchange → accounts.google.com（**同窗口**导航，无弹窗）
   *   → #identifierId 填邮箱 → #identifierNext → /v3/signin/challenge/pwd
   *   → 填密码 → #passwordNext → 302 直回 www.genspark.ai（会话落 profile）。
   *   实测无 2SV、无同意页（账号授权过 Genspark 后免确认）；约 40s 走完。
   *   🔴 B2C 的「Login with email」原生表单对 Google 注册账号**无效**（实测
   *   停在 Sign up or sign in 页报错）—— 谷歌账号必须走 #GoogleExchange。
   *
   * Genspark 原生邮箱账号（并列路径）→ #loginWithEmailWrapper 表单，见
   * _fillEmailForm。登录方式由控制台录入时显式选择（creds.loginMethod，
   * 2026-09-29 新增）：google=Google OAuth（默认），native=直接走 B2C 表单。
   * native 不再当后备，而是首选 —— 原生邮箱账号走 Google 链会卡在
   * Google 的人机挑战页（hotmail 域实测）；Google 路径报「账号不存在」
   * 时仍自动降级过去（兜底控制台选错的情况）。
   */
  async _fillLoginPage(page) {
    const email = String(this.creds.email || '');
    const password = String(this.creds.password || '');
    if (this.creds.loginMethod === 'native') {
      this.log(`  [gs#${this.key}] profile 无登录态 —— 自动登录`
        + `（${maskEmail(email)}，原生邮箱 → B2C 表单）`);
      return this._fillEmailForm(page);
    }
    this.log(`  [gs#${this.key}] profile 无登录态 —— 自动登录（${maskEmail(email)}，Google OAuth 优先）`);
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch(() => {});
    await page.waitForTimeout(4000);
    // Azure B2C provider 选择页可能加载慢：等 Google 按钮出现。
    const googleBtn = page.locator('#GoogleExchange, button:has-text("Google")').first();
    const hasGoogle = await googleBtn.isVisible().catch(() => false)
      || await googleBtn.waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true).catch(() => false);
    if (!hasGoogle) {
      // 没有 Google 按钮（B2C 改版/纯邮箱租户）→ 原生邮箱表单
      this.log(`  [gs#${this.key}] 登录页无 Google 按钮，降级 B2C 邮箱表单`, 'warn');
      return this._fillEmailForm(page);
    }
    await googleBtn.click({ timeout: 10_000 })
      .catch(() => { throw new Error('Genspark 登录页点 Google 按钮失败'); });
    await page.waitForURL(/accounts\.google\./, { timeout: 45_000 })
      .catch(() => { throw new Error(`点 Google 后未跳转 accounts.google.com（url=${page.url().slice(0, 120)}）`); });

    // ---- Google 登录状态机：看到什么填什么（同 aistudio_login 口径）----
    let passSubmitted = false;
    for (let i = 0; i < 40; i += 1) {            // ~2 分钟预算
      await page.waitForTimeout(3000);
      const url = page.url();
      // 已回 Genspark 主站：验会话（🔴 认「邮箱在场」，匿名 guest 也是 200）
      if (/^https:\/\/www\.genspark\.ai/.test(url)) {
        for (let j = 0; j < 10; j += 1) {
          const r = await page.evaluate(PAGE_GET_USER).catch(() => ({ status: 0 }));
          if (r.status === 200 && r.email) {
            this.log(`  [gs#${this.key}] Google OAuth 登录成功（${r.email}，`
              + `plan=${r.plan || '?'}），登录态已落 profile`);
            return;
          }
          await page.waitForTimeout(3000);
        }
        throw new AuthExpiredError('Google OAuth 已回主站但会话未生效（/api/user 无邮箱）');
      }
      if (!/accounts\.google\./.test(url)) continue;   // 中间跳转页，等下一拍
      const body = await page.innerText('body').catch(() => '');
      // 密码页（只提交一次，防锁号）
      const pass = page.locator('#password input[type="password"], input[type="password"]:visible').first();
      if (!passSubmitted && await pass.isVisible().catch(() => false)) {
        passSubmitted = true;
        await pass.fill(password);
        await page.locator('#passwordNext').click({ timeout: 8000 })
          .catch(() => pass.press('Enter').catch(() => {}));
        this.log(`  [gs#${this.key}] Google 密码已提交`);
        continue;
      }
      // OAuth 同意页（首次授权才出现）：点 Continue
      const consent = page.locator('#submit_approve_access, button:has-text("Continue")').first();
      if (/oauth\/consent|wants access/i.test(body)
        && await consent.isVisible().catch(() => false)) {
        await consent.click({ timeout: 8000 }).catch(() => {});
        this.log(`  [gs#${this.key}] 已点 OAuth 同意`);
        continue;
      }
      // 邮箱页（会话失效重登时再次出现）
      const emailBox = page.locator('#identifierId, input[type="email"]').first();
      if (await emailBox.isVisible().catch(() => false)) {
        await emailBox.fill(email);
        await page.locator('#identifierNext').click({ timeout: 8000 })
          .catch(() => emailBox.press('Enter').catch(() => {}));
        continue;
      }
      // 2SV / 挑战页：无第二因子，交给人
      if (/2-Step Verification|Choose how you want to sign in|Verify it.s you|Enter the code/i.test(body)) {
        throw new AuthExpiredError(
          'Google 登录弹了两步验证（节点没有 TOTP/备用码）—— '
          + '请走 noVNC 人机协同首登一次，之后 profile 自持不再需要登录');
      }
      if (/wrong.?password|couldn.t find your google account|suspended/i.test(`${body} ${url}`)) {
        // Google 账号不存在/密码错。有一种可能：这是 Genspark 原生邮箱账号
        //（不是 Google 账号）→ 降级 B2C 邮箱表单再试一次。
        if (/couldn.t find your google account/i.test(body)) {
          this.log(`  [gs#${this.key}] Google 无此账号 —— 可能是原生邮箱账号，降级 B2C 表单`, 'warn');
          return this._fillEmailForm(page);
        }
        throw new AuthExpiredError(
          'Google 拒绝登录（密码错误或账号异常）—— 请在控制台核对邮箱密码');
      }
    }
    throw new AuthExpiredError(
      `Google OAuth 登录未在预算内完成（${maskEmail(email)}）—— 请走 noVNC 人机协同`);
  }

  /**
   * Genspark 原生邮箱账号的后备路径：B2C「Login with email」表单
   * （#loginWithEmailWrapper → #email/#password → #next）。
   * 对 Google 注册的账号无效 —— 谷歌账号走 _fillLoginPage 主路径。
   */
  async _fillEmailForm(page) {
    const email = String(this.creds.email || '');
    const password = String(this.creds.password || '');
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await page.locator('#loginWithEmailWrapper').first()
      .click({ timeout: 8000 }).catch(() => { /* 表单可能已展开 */ });
    const emailBox = page.locator('#email, input[type="email"]').first();
    await emailBox.waitFor({ state: 'visible', timeout: 45_000 })
      .catch(() => {
        throw new Error('Genspark 登录页没等到邮箱输入框（B2C 页面改版或加载超时？）');
      });
    await emailBox.fill(email);
    const passBox = page.locator('#password, input[type="password"]').first();
    await passBox.waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => { throw new Error('Genspark 登录页没等到密码输入框'); });
    await passBox.fill(password);
    await page.locator('#next').first().click({ timeout: 8000 })
      .catch(() => passBox.press('Enter').catch(() => {}));
    await page.waitForURL(/www\.genspark\.ai/, { timeout: 60_000 })
      .catch(() => { /* 没跳回：轮询里会拿现场报错 */ });
    for (let i = 0; i < 20; i += 1) {
      await page.waitForTimeout(3000);
      const r = await page.evaluate(PAGE_GET_USER).catch(() => ({ status: 0 }));
      if (r.status === 200 && r.email) {
        this.log(`  [gs#${this.key}] B2C 邮箱表单登录成功（${r.email}，`
          + `plan=${r.plan || '?'}），登录态已落 profile`);
        return;
      }
    }
    const scene = String(await page.content().catch(() => ''))
      .replace(/\s+/g, ' ').slice(0, 500);
    throw new AuthExpiredError(
      `Genspark B2C 邮箱表单登录未成功（${maskEmail(email)}）—— 请在控制台核对邮箱密码，`
      + `或走 noVNC 人机协同。页面现场：${scene}`);
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
   * 收割当前 profile 的登录 cookie 串（`name=value; …`）。
   * 用途：登录型凭据自动登录成功后回传号池（login-refresh 回填），
   * 让控制台从「等待节点自动登录」变成「看到真实 cookie + 到期时间」。
   * context.cookies() 包含 httpOnly 的 session_id。
   * ⚠️ health() 探测完会关浏览器（省内存），所以 _healthOnce 在关闭前会把
   * cookie 快照到 lastCookieHeader —— 这里优先返回活收割，回落快照。
   */
  async getCookieHeader() {
    if (this.context) {
      const cookies = await this.context.cookies(BASE).catch(() => []);
      const live = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      if (live.includes('session_id=')) return live;
    }
    return this.lastCookieHeader || '';
  }

  /**
   * 探活 + 会员档采集：页内 GET /api/user。
   * 返回 { email, plan, name }；401/403 → AuthExpiredError。
   * 登录型凭据：失效先自动重登一次再探（2026-09-29 自续语义）。
   */
  async health() {
    if (!this.valid) {
      throw new AuthExpiredError('账号凭据不可用（cookie 型缺 session_id / 登录型缺邮箱密码）');
    }
    try {
      return await this._healthOnce();
    } catch (err) {
      if (err.authExpired && this.creds.kind === 'genspark_login') {
        this.log(`  [gs#${this.key}] 会话失效，自动重登后重探…`, 'warn');
        await this.close().catch(() => {});
        await this.ensure();       // 重启 + _ensureLogin 填表重登
        return this._healthOnce();
      }
      throw err;
    }
  }

  /** health() 的单次探测（登录失败时由 health 包一层重登重试）。 */
  async _healthOnce() {
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
      // 🔴 200 但无邮箱 = 匿名 guest 响应（{"status":-5,"user not found"}），
      // 不是登录态 —— 按 cookie 失效处置（登录型由此触发真正的填表重登）。
      if (r.status === 200 && !r.email) {
        throw new AuthExpiredError(
          `Genspark 会话无效（HTTP 200 但匿名响应 code=${r.code}，无邮箱）`);
      }
      if (r.status !== 200) throw new Error(`Genspark /api/user HTTP ${r.status}`);
      // 关浏览器前把登录 cookie 快照下来（登录型回传号池的原料；
      // health() 的 finally 会关 context，之后 getCookieHeader 靠这个快照）。
      if (this.creds.kind === 'genspark_login') {
        const cookies = await this.context.cookies(BASE).catch(() => []);
        const hdr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        if (hdr.includes('session_id=')) this.lastCookieHeader = hdr;
      }
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
   * 单次生图（对外入口）：登录型凭据失效时自动重登一次再重试；
   * cookie 型失效照旧抛 AuthExpiredError（换号/换 cookie 由上层接手）。
   */
  async generate(params = {}) {
    try {
      return await this._generateOnce(params);
    } catch (err) {
      if (err.authExpired && this.creds.kind === 'genspark_login' && !this._authRetried) {
        this._authRetried = true;
        try {
          this.log(`  [gs#${this.key}] 会话失效，自动重登后重试一次…`, 'warn');
          await this.close().catch(() => {});
          return await this._generateOnce(params);   // ensure() 重启时顺带重登
        } finally {
          this._authRetried = false;
        }
      }
      throw err;
    }
  }

  /**
   * 单次生图（单次尝试）：{prompt, model, size, aspect} → {bytes, contentType, model, size, taskId}
   * model = 'gpt-image-2' | 'gpt-image-2.5'；size = '1K'|'2K'|'4K'；aspect = '1:1' 等。
   */
  async _generateOnce({ prompt, model, size, aspect, autoPrompt } = {}) {
    if (!this.valid) {
      throw new AuthExpiredError('账号凭据不可用（cookie 型缺 session_id / 登录型缺邮箱密码）');
    }
    const wantModel = MODELS.has(String(model)) ? String(model) : 'gpt-image-2';
    const wantSize = SIZES.has(String(size || '').toUpperCase()) ? String(size).toUpperCase() : '1K';
    const tab = await this.acquireTab();
    if (!tab) throw new Error(`账号 #${this.key} 的 ${this.cfg.gensparkTabs || 5} 个 tab 全忙`);
    const { page } = tab;
    try {
      const mid = crypto.randomUUID();
      // 🔴 tier:"flare" 只属于 gpt-image-2.5（用户口径 2026-09-29），2 不带。
      // 🔴 auto_prompt 两个模型统一 false（2026-09-29 用户口径 + 实测裁决）：
      // false + 显式尺寸直发可出图（3:4+2K=1328×1760px），且提示词不被上游
      // 扩写、行为可预期；true 留 autoPrompt 参数覆盖钩子供实验。
      const modelParams = {
        type: 'image', model: wantModel,
        aspect_ratio: String(aspect || '1:1'),
        auto_prompt: autoPrompt !== undefined ? Boolean(autoPrompt) : false,
        style: 'auto',
        image_size: wantSize.toLowerCase(),
        quality: 'auto',            // 免费档：上游 0 成本（用户口径：只用 auto）
        background_mode: true, camera_control: null, generation_count: 1,
      };
      if (wantModel === 'gpt-image-2.5') modelParams.tier = 'flare';
      const body = {
        model_params: modelParams,
        writingContent: null, sas_ask_origin: 'typed', type: 'image_generation_agent',
        // 🔴 2026-09-29 关键修复：project_id 必须传 null（照抄网页版）——
        // 每单开全新会话。此前复用固定 project 把 28 张塞同一会话，触发的是
        // 「会话级 5h 上限」（UI 同账号新会话随时能出图，实锤非账号级）；
        // 顺带绕开了 /api/project/create 老 payload（{article:'# image'}）返回
        // -8 "out of credits" 的假额度墙——那个接口本就不该再调。
        project_id: null,
        messages: [{
          role: 'user', id: mid, content: String(prompt || ''), pending: true,
          sendStatus: 'sending', _deepDiveStateNegContent: String(prompt || ''), thinking: false,
        }],
        user_s_input: String(prompt || ''), client_message_id: mid,
        // 🔴 g_recaptcha_token 必带（2026-09-29 实测：缺它会被伪装成「5h 限额」
        // 的风控软拦截挡掉，见 PAGE_GET_RECAPTCHA_TOKEN 注释）。页内现签，
        // 单次有效；取失败则降级裸发（自赌上游策略，日志留痕）。
        is_private: true, push_token: '', last_seen_event_index: -1,
        chat_session_id: crypto.randomUUID(),
      };
      try {
        body.g_recaptcha_token = await page.evaluate(PAGE_GET_RECAPTCHA_TOKEN, RECAPTCHA_SITE_KEY);
      } catch (e) {
        this.log(`  [gs#${this.key}] reCAPTCHA 现签失败（${String(e.message).slice(0, 60)}）—— 降级无 token 裸发`, 'warn');
      }
      // 🔴 频率闸（2026-09-29）：bisect 期间 ~9 次/5min 直发连发全撞瞬态软拦截
      // （伪装 5h 额度墙 + 滚动 +90min 重置点，不耗额度；且同窗口 UI 手动生图
      // 正常 ⟹ 拦截是「直发路径特异」，频率未必是充分条件，此闸是保险）。
      // 单账号提交间隔下限 RH_GENSPARK_MIN_INTERVAL_SECONDS（默认 35s，
      // 用户口径 09-29），排队等待期间持有 tab permit（属正常占槽语义）。
      const minGapMs = (Number(this.cfg.gensparkMinIntervalSeconds) || 0) * 1000;
      if (minGapMs > 0) {
        const waitMs = this._lastSubmitAt + minGapMs - Date.now();
        if (waitMs > 0) {
          this.log(`  [gs#${this.key}] 频率闸：距上次提交不足 ${Math.round(minGapMs / 1000)}s，排队 ${Math.round(waitMs / 1000)}s`);
          await new Promise((r) => setTimeout(r, waitMs));
        }
        this._lastSubmitAt = Date.now();
      }
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
      // 🔴 09-29 终审：除「reached」外，上游还有「Approaching 5-hour limit.」
      // 临限拒绝（不带 {time} 时间戳）——同样必须按额度墙处置（休眠+failover），
      // 否则会落成普通 UPSTREAM_ERROR，白白烧光 failover 次数后判任务失败。
      const m = /\{time:(\d+)\}/.exec(limitRaw);
      const limited = Boolean(m) || /limit/i.test(limitRaw);
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

  /**
   * accountKey → GensparkAccount。creds = normalizeGsSession 产物
   * （兼容旧调用传 cookie 字符串）。凭据签名变了热更（旧浏览器延迟回收）。
   */
  get(accountKey, creds) {
    const key = String(accountKey);
    const norm = (typeof creds === 'string')
      ? { kind: 'cookie', cookie: creds }
      : (creds || { kind: 'cookie', cookie: '' });
    const sig = JSON.stringify(norm);
    let entry = this.accounts.get(key);
    if (!entry) {
      entry = { account: new GensparkAccount({ accountKey: key, creds: norm, cfg: this.cfg, log: this.log }), sig };
      this.accounts.set(key, entry);
    } else if (entry.sig !== sig) {
      // 换凭据（cookie 换新 / 登录材料改密）：换新执行会话，项目缓存作废；
      // 旧浏览器**延迟关闭**（有任务在跑时等它收尾，见 GensparkAccount.close）。
      entry.sig = sig;
      const old = entry.account;
      entry.account = new GensparkAccount({ accountKey: key, creds: norm, cfg: this.cfg, log: this.log });
      old.close().catch(() => {});
      this.log(`  [gs#${key}] 凭据已更新（v+1），执行会话重开`);
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
  GensparkAccount,
  AuthExpiredError,
  QuotaLimitError,
  parseSse,
  cookieValue,
  isCfChallenge,
  MODELS,
  SIZES,
};
