'use strict';
/**
 * Google AI Studio 生图执行器（backend = aistudio_image）。
 *
 * 为什么必须用浏览器页面执行
 * --------------------------
 * GenerateContent 内部 RPC 的第 [4] 参「请求令牌」**绑定请求内容**（提示词）：
 * 原样重放永远 200、换提示词必 403（2026-09-26 Step 0 实测，见
 * docs/aistudio-pool-plan.md）。令牌由页面 JS 在提交那一刻为「当前提示词」现签，
 * 服务端无法离线铸造 ⟹ 每个任务都必须在一个已登录的页面里走真实提交流程，
 * 我们在网络层拦截请求/响应拿图。
 *
 * 好消息（同一次实测）：令牌**不绑 generationConfig** —— 拦截到页面发往上游的
 * 请求后，把分辨率档在途改写成 4K 再放行，照样 200。所以 UI 只负责「为这条
 * 提示词签令牌」，参数自由度全部由拦截器掌握。
 *
 * 执行链（单任务）
 * ---------------
 *   1. ensure(account)   每账号一个 chromium 持久 profile（cookie 由号池下发，
 *                        只落 profile 目录），打开 aistudio.google.com；
 *   2. 检测登录态        URL 被踢到 accounts.google.com = cookie 失效 →
 *                        抛 authExpired，由 index.js 的换号重试逻辑接手；
 *   3. 填提示词 → Run    令牌在页面内现签；
 *   4. 路由拦截          context.route 捕获 GenerateContent：在途改写分辨率，
 *                        route.fetch() 亲自放行，拿到响应字节后 fulfill 给页面
 *                        （页面自己继续走完，我们只要字节）；
 *   5. 解析响应          JSON 数组里抽出图片 part（预览图 + 4K 成图，取最大者）。
 *
 * 已知待实测校准点（first-deploy 前 must-fix）
 * ------------------------------------------
 *   · 提示词输入框 / Run 按钮的选择器按公开 UI 写了多级候选，真实 DOM 可能
 *     不同 —— 部署前用真实页面各跑一次 `node lib/aistudio.js` 自检校准；
 *   · 模型选择：若页面默认模型不是 gemini-3-pro-image，提交出的响应里没有
 *     图片 part，会以 PARAM 失败并给出提示（不会错扣：未进上游不成单）。
 *
 * 并发模型
 * --------
 *   每账号一个 persistent context，内开至多 cfg.aistudioTabs 个工作 tab；
 *   任务从空闲 tab 取，没有空闲就新开（到上限为止），再满则排队。
 *   tab 数 = 单账号并发（用户定 10；每 tab 约 300-500MB 内存）。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { ensureLogin, hasLiveSession } = require('./aistudio_login');
const failure = require('./failure');

// 🔴 全局开窗串行闸（1015 用户定版）：并发满载时窗口必须逐个开启——上一单
// 成功发出 GenerateContent 请求（点 Run 完成）后，才放行下一单开窗；出图
// 等待阶段不占闸（各单等待仍并行）。排队长度=账号数，秒级周转，无饥饿风险。
const submitGate = (() => {
  let chain = Promise.resolve();
  return {
    /** 排队拿闸；返回 {release()}，release 幂等（重复调用无害）。 */
    async acquire() {
      const prev = chain;
      let release;
      chain = new Promise((r) => { release = r; });
      let done = false;
      const rel = () => { if (!done) { done = true; release(); } };
      await prev.catch(() => {});
      return { release: rel };
    },
  };
})();

// ---------------------------------------------------------------- 登录错峰闸
// 十几个 Google 账号在同一台 VPS IP 上先后首登/重登，若背靠背（验证链虽串行
// 但无间隔）会触发 Google IP 风控 —— 那时三层接码都救不了（挑战页直接不给
// 选项）。本闸保证：
//   · 同一时刻至多一个 aistudio 账号在做网页登录；
//   · 上一次登录结束（无论成败）到下一次登录开始之间随机间隔
//     RH_AISTUDIO_LOGIN_GAP_MIN_MS ~ MAX_MS（默认 6~12 分钟）。
// 已登录（profile 自持）的快速探活**不进闸** —— 只拦「真要开登录页」的路径；
// 全新 profile（无 cookie 文件 = 必然真登录）在启动浏览器**之前**排队，
// 避免十几号同时入池时排队期间各自挂着一只空转 Chromium（内存保护）。
const loginGate = {
  tail: Promise.resolve(),   // FIFO 队尾
  lastFinishTs: 0,           // 上一次网页登录的结束时刻
};
const gateSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function _gateGapMs() {
  const lo = Number(process.env.RH_AISTUDIO_LOGIN_GAP_MIN_MS || 6 * 60_000);
  const hi = Number(process.env.RH_AISTUDIO_LOGIN_GAP_MAX_MS || 12 * 60_000);
  const a = Math.max(0, Math.min(lo, hi));
  const b = Math.max(lo, hi);
  return a + Math.random() * Math.max(0, b - a);
}
function gatedLogin(key, log, fn) {
  const prev = loginGate.tail;
  let release;
  // 排队位在调用 gatedLogin 时就占好（FIFO），返回 thunk 由调用方执行 ——
  // 调用方写法统一为 `await gatedLogin(...)()`。
  loginGate.tail = new Promise((r) => { release = r; });
  return async () => {
    await prev;
    try {
      const waitMs = Math.max(0, loginGate.lastFinishTs + _gateGapMs() - Date.now());
      if (waitMs > 0) {
        log(`  [ai#${key}] 登录错峰：排队等待 ${Math.round(waitMs / 60_000)} 分钟`
          + `（防同 IP 连续登录触发 Google 风控；RH_AISTUDIO_LOGIN_GAP_*_MS 可调）`);
        await gateSleep(waitMs);
      }
      return await fn();
    } finally {
      loginGate.lastFinishTs = Date.now();
      release();
    }
  };
}

const RPC_URL_MATCH = /alkalimakersuite-pa\.clients6\.google\.com\/.*GenerateContent/;

/** AI Studio 提示词输入框 / Run 按钮的多级候选选择器（真实 DOM 校准后收敛）。
 *  2026-10-15 改版校准（1015 全量失败复盘，探针实测新版 DOM）：
 *  · 输入框 aria-label "Type something" → "Enter a prompt"，placeholder 换成
 *    "Start typing a prompt…"（旧 "Type" 子串全部失配）；
 *  · 旧 ms-autocomplete 容器没了，输入框挂在 ms-prompt-box > ms-chunk-editor 内；
 *  · Run 按钮从 button.run-button 变成 ms-run-button 内 button.ctrl-enter-submits
 *   （aria-label 为空，旧 aria/run-button 候选全失配）。新旧候选并存做兼容。 */
const PROMPT_SELECTORS = [
  'textarea[aria-label*="prompt" i]',
  'textarea[placeholder*="prompt" i]',
  'ms-prompt-box textarea',
  'textarea[aria-label*="Type" i]',
  'textarea[placeholder*="Type" i]',
  'textarea[aria-label*="提示" i]',
  'ms-autocomplete textarea',
  'ms-chunk-editor textarea',
  'main textarea',
].join(', ');
const RUN_SELECTORS = [
  'ms-run-button button',
  'button.ctrl-enter-submits',
  'button[aria-label*="Run" i]',
  'button[aria-label*="运行" i]',
  'button.run-button',
].join(', ');
const MODEL_TEXT_HINTS = ['Gemini 3 Pro Image', 'gemini-3-pro-image'];
/** 参考图上传控件候选（真实页面校准后收敛）。setInputFiles 对隐藏 input 也生效。 */
const IMAGE_INPUT_SELECTORS = [
  'input[type="file"][accept*="image" i]',
  'input[type="file"]',
].join(', ');

/** cookie 头串 → Playwright cookie 对象数组（domain 全部归到 google.com 系）。 */
function parseCookieHeader(cookieStr) {
  const out = [];
  for (const seg of String(cookieStr || '').split(';')) {
    const i = seg.indexOf('=');
    if (i <= 0) continue;
    const name = seg.slice(0, i).trim();
    const value = seg.slice(i + 1).trim();
    if (!name || !value) continue;
    // __Secure- 前缀的 cookie 必须标记 secure，否则 Playwright 拒收
    out.push({
      name, value,
      domain: name.startsWith('__Host-') ? 'aistudio.google.com' : '.google.com',
      path: '/',
      secure: true,
      httpOnly: name.startsWith('SID') || name.startsWith('__Secure-'),
    });
  }
  return out;
}

/** 从 GenerateContent 响应（JSON 数组格式）里抽出全部图片 part。 */
function extractImages(data) {
  const imgs = [];
  const walk = (o) => {
    if (!Array.isArray(o)) return;
    if (o.length === 2 && typeof o[0] === 'string'
        && /^(image|media)\//.test(o[0])
        && typeof o[1] === 'string' && o[1].length > 1000) {
      imgs.push({ contentType: o[0], base64: o[1] });
      return;
    }
    for (const x of o) walk(x);
  };
  walk(data);
  return imgs;
}

/** 生成请求 wire 里 generationConfig 末位的分辨率档与宽高比。
 *  imageConfig 在 json+protobuf 里就是二元组 [aspectRatio, imageSize]：
 *  页面默认 1:1 时 aspectRatio 为 null（2026-09-27 抓包实锤）。 */
function rewriteResolution(generationConfig, resolution, aspect = '') {
  if (!Array.isArray(generationConfig)) return false;
  for (let i = 0; i < generationConfig.length; i += 1) {
    const el = generationConfig[i];
    if (Array.isArray(el) && el.length === 2
        && (el[0] === null || typeof el[0] === 'string')
        && (el[1] === '1K' || el[1] === '2K' || el[1] === '4K')) {
      generationConfig[i] = [aspect || el[0], resolution];
      return true;
    }
  }
  return false;
}

class AuthExpiredError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'AuthExpiredError';
    this.authExpired = true;
    // 借用节点的「会话失效」信号通道：runTask 的换号重试逻辑认
    // upstreamCode=10001106（sessionruntime.isAuthExpired）。AI 账号的
    // cookie 失效在处置上与会话失效完全同构（标记账号 + 换号重试），复用之。
    this.upstreamCode = '10001106';
  }
}

class AistudioAccount {
  /**
   * @param {{accountKey: string|number, session: object, cfg: object,
   *           log: function}} opts
   *   session：normalizeAiSession 的产物，两种形态 ——
   *     { kind:'cookie', cookie }        旧式人工导 cookie（环境绑定，仅过渡）；
   *     { kind:'google_login', email, password, app_password?, totp_secret?,
   *       backup_codes? }                节点自登录 + 持久 profile 自持（正路）。
   */
  constructor({ accountKey, session, cfg, log }) {
    this.key = String(accountKey);
    this.creds = session || {};
    this.cfg = cfg;
    this.log = log || (() => {});
    this.profileDir = path.resolve(cfg.aistudioProfileDir, this.key);
    this.context = null;
    this.tabs = [];            // [{ page, permit }] —— 只含在跑的 tab（用完即关）
    this.booting = null;       // 并发 ensure 只跑一次
    this.bootError = null;     // 最近一次启动/执行错误（/status 远程可见）
    this.routeArmed = false;   // context 级路由只挂一次
    this.waiters = [];         // 捕获槽：[{page, resolve, timer}]
  }

  /** 启动/复用持久 context 并打开一个登录页面。重复调用返回同一个 promise。 */
  async ensure() {
    if (this.booting) return this.booting;
    this.booting = this._boot().catch((err) => {
      this.booting = null;
      this.bootError = `${err.name || 'Error'}: ${err.message}`;
      throw err;
    });
    return this.booting;
  }

  /**
   * profile 里是否已落过登录 cookie（粗判：有非占位的 Cookies 文件 ≈
   * 大概率已登录，无需进错峰闸 —— 会话探活自己会说话）。
   */
  _profileHasCookies() {
    for (const rel of ['Default/Network/Cookies', 'Default/Cookies']) {
      try {
        if (fs.statSync(path.join(this.profileDir, rel)).size > 8192) return true;
      } catch { /* 文件不存在 */ }
    }
    return false;
  }

  async _boot() {
    fs.mkdirSync(this.profileDir, { recursive: true });
    // 全新 profile（无 cookie = 必然要真登录）：先过登录错峰闸再启动浏览器。
    // 排队期间不占 Chromium —— 十几号同时入池的内存保护（排队 6~12 分钟/号，
    // 若先启浏览器再排队，每号空挂 300MB+，队列长了直接 OOM）。
    if (this.creds.kind === 'google_login' && !this._profileHasCookies()) {
      this._gateHeld = true;
      try {
        return await gatedLogin(this.key, this.log, () => this._bootInner())();
      } finally {
        this._gateHeld = false;
      }
    }
    return this._bootInner();
  }

  async _bootInner() {
    // playwright 是可选依赖：没装就 fail closed，由调用方降级
    let pw;
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      pw = require('playwright');
    } catch (e) {
      throw new Error('未安装 playwright（npm i playwright && npx playwright install chromium）'
        + `—— AI Studio 执行面不可用: ${e.message}`);
    }
    // 启动前后都打内存：托管平台 OOM 击杀不留遗言（2026-09-26 Hostinger 首日
    // 实锤，boot_count 涨、crash.log 无记录、外网探测握手超时），只能靠
    // 「死前最后的内存读数」反推是不是顶到了托管内存上限。
    const m0 = process.memoryUsage();
    this.log(`  [ai#${this.key}] 启动 Chromium 持久 profile：${this.profileDir}`
      + `（node rss=${Math.round(m0.rss / 1048576)}MB heap=${Math.round(m0.heapUsed / 1048576)}MB）`);
    // RH_AISTUDIO_HEADLESS=0 → 有头模式（配 DISPLAY=:98 虚拟屏）。无头模式下
    // GenerateContent 会 403 permission denied（waa 反滥用拒签，2026-09-27
    // 登录型账号实测）——有头 + client-hints 伪装是过审的必要条件组合。
    const headed = String(process.env.RH_AISTUDIO_HEADLESS || '') === '0';
    this.context = await pw.chromium.launchPersistentContext(this.profileDir, {
      headless: !headed,
      // --no-zygote 省一个常驻 zygote 进程（须与 --no-sandbox 同用，已有）；
      // --renderer-process-limit=1 压渲染进程数。单账号 tab 内并存多页时
      // 每页仍是独立进程，但至少不让 Chromium 自行扩到多渲染进程。
      args: headed
        ? ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900',
          '--disable-blink-features=AutomationControlled',
          // 强关浏览器/断电后重启必弹「Restore pages?」恢复气泡（1015 深夜
          // noVNC 人工关窗后实锤）——压掉它，免得干扰点击与视觉排查。
          '--hide-crash-restore-bubble']
        : ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
          '--no-zygote', '--renderer-process-limit=1'],
      ...(headed ? { ignoreDefaultArgs: ['--enable-automation'] } : {}),
      viewport: { width: 1440, height: 900 },
      timeout: 60_000,
    });
    const m1 = process.memoryUsage();
    this.log(`  [ai#${this.key}] Chromium 已启动（node rss=${Math.round(m1.rss / 1048576)}MB，`
      + `增量 +${Math.round((m1.rss - m0.rss) / 1048576)}MB —— 浏览器本体内存不在 node 读数里，`
      + `以平台监控为准）`);

    // 凭据：cookie 型 → 号池下发的字符串写进 profile（version 变化时
    // reloadCookies() 重写）；登录型 → profile 自持登录态，失效时走
    // _ensureLoggedIn() 自动重登（登录失败抛 AuthExpiredError 交换号/人工）。
    if (this.creds.kind === 'google_login') {
      await this._ensureLoggedIn();
    } else {
      await this.reloadCookies();
    }

    // 🔒 指纹伪造（修 2026-09-26 实锤的「活页面也 403」）：
    // 无头 Chromium 在 sec-ch-ua-full-version-list 里自曝 "HeadlessChrome"，
    // Google waa 反滥用拒绝为可疑环境签有效令牌 ⟹ GenerateContent 403
    // permission denied。用 CDP 把整组 client hints 换成与浏览器同版本的
    // 正常 Chrome 指纹，并抹掉 navigator.webdriver。RH_AISTUDIO_UA_SPOOF=0 可关。
    if (String(process.env.RH_AISTUDIO_UA_SPOOF || '1') !== '0') {
      const m0 = this.context.browser() && this.context.browser().version
        ? this.context.browser().version() : '';
      this._spoofVersion = m0 || '153.0.8010.12';
      this._spoofPage = async (page) => {
        try {
          const cdp = await this.context.newCDPSession(page);
          const major = this._spoofVersion.split('.')[0];
          await cdp.send('Network.setUserAgentOverride', {
            userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36`
              + ` (KHTML, like Gecko) Chrome/${this._spoofVersion} Safari/537.36`,
            userAgentMetadata: {
              brands: [
                { brand: 'Google Chrome', version: major },
                { brand: 'Chromium', version: major },
                { brand: 'Not_A Brand', version: '24' },
              ],
              fullVersionList: [
                { brand: 'Google Chrome', version: this._spoofVersion },
                { brand: 'Chromium', version: this._spoofVersion },
                { brand: 'Not_A Brand', version: '24.0.0.0' },
              ],
              fullVersion: this._spoofVersion,
              platform: 'Windows', platformVersion: '10.0.0',
              architecture: 'x86', bitness: '64', model: '',
              mobile: false, wow64: false, formFactors: ['Desktop'],
            },
          });
          await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          });
        } catch (err) {
          this.log(`  [ai#${this.key}] 指纹伪造失败（裸跑）:${err.message}`, 'warn');
        }
      };
      this.context.on('page', (page) => { this._spoofPage(page); });
      for (const page of this.context.pages()) this._spoofPage(page);
      this.log(`  [ai#${this.key}] client-hints 伪造已启用（伪装 Chrome ${this._spoofVersion}）`);
    }

    // Cookie 落盘：Google 会通过 Set-Cookie 持续轮换 1PSIDTS 等会话 cookie，
    // 只有浏览器引擎接得住。这里把 profile 内的最新登录态存下来（chmod 600，
    // 不进库），供纯 HTTP 执行器/排障直接取「新鲜 cookie」。
    try {
      const live = await this.context.cookies();
      const dumpPath = path.resolve(this.profileDir, '..', `cookies-live-${this.key}.json`);
      fs.writeFileSync(dumpPath, JSON.stringify({
        dumped_at: new Date().toISOString(),
        cookie: live.map((c) => `${c.name}=${c.value}`).join('; '),
      }), { mode: 0o600 });
    } catch (err) {
      this.log(`  [ai#${this.key}] cookie 落盘失败：${err.message}`, 'warn');
    }

    // 响应捕获槽：任务发起前 push 一个 waiter，路由拦截器命中时配对。
    // context 级只挂一次；page 级路由在 tab 创建时挂。
    if (!this.routeArmed) {
      this.routeArmed = true;
      this.context.route(new RegExp(RPC_URL_MATCH.source), async (route) => {
        try {
          await this._handleRpc(route);
        } catch (err) {
          this.log(`  [ai#${this.key}] RPC 拦截失败：${err.message}`, 'warn');
          try { await route.continue_(); } catch { /* 页面可能已关闭 */ }
        }
      }).catch(() => {});
    }
  }

  /** cookie 版本变化时重写 profile 内的登录态（换 cookie 不必杀进程）。 */
  async reloadCookies() {
    const cookies = parseCookieHeader(this.creds.cookie || '');
    if (!cookies.length) throw new AuthExpiredError('账号凭据为空');
    await this.context.addCookies(cookies);
  }

  /**
   * 登录型账号的登录态保障：profile 自持 → 直接用（日常路径，绝大多数走这）；
   * 没有登录态 → 用邮箱/TOTP/备用码自动重登。无头环境重登 Google 可能弹
   * 「browser may not be secure」（反检测补丁在，未实锤无头能过）—— 失败
   * 抛 AuthExpiredError，控制台标红后走人机协同首登补 profile。
   */
  async _ensureLoggedIn() {
    const probe = await this.context.newPage();
    try {
      await probe.goto('https://aistudio.google.com/', {
        waitUntil: 'domcontentloaded', timeout: 60_000,
      }).catch(() => {});
      await probe.waitForTimeout(8_000);
      // 🔴 hasLiveSession 只查 cookie 名存在（SID/SAPISID），被 Google 服务端
      // 登出的会话 cookie 文件仍在 → 必误报「有效」（1015 深夜 74/78 实锤：
      // 页面实际落在 accounts.google.com 选择器）。补一道 URL 终审：
      // probe 被重定向到登录域 = 会话已死，走真重登。
      if (await hasLiveSession(this.context)
        && !/accounts\.google\.com|ServiceLogin|signin/.test(probe.url())) {
        this.log(`  [ai#${this.key}] profile 自持会话有效，跳过登录`);
        return;
      }
      if (!this.creds.email || !this.creds.password) {
        throw new AuthExpiredError('profile 无登录态且无登录凭据 —— 请在控制台补齐或走协同首登');
      }
      this.log(`  [ai#${this.key}] profile 无登录态 —— 自动重登（${this.creds.email.replace(/^(.{2}).*(@.*)$/, '$1***$2')}）`);
      // 真登录路径统一过错峰闸（_gateHeld = 全新 profile 启动时已持闸，
      // 不再重复进 —— gatedLogin 非重入，重复进会死等自己）。
      const runLogin = () => ensureLogin({
        context: this.context,
        creds: {
          email: this.creds.email,
          password: this.creds.password,
          app_password: this.creds.app_password,
          totp_secret: this.creds.totp_secret,
          backup_codes: this.creds.backup_codes,
          recovery_outlook: this.creds.recovery_outlook,
        },
        log: (m) => this.log(`  [ai#${this.key}]${m.replace(/\[login\]/, '')}`),
        shotsDir: path.join(os.tmpdir(), `aistudio-relogin-${this.key}`),
      });
      const result = this._gateHeld
        ? await runLogin()
        : await gatedLogin(this.key, this.log, runLogin)();
      if (result.status === 'already' || result.status === 'logged_in') {
        this.log(`  [ai#${this.key}] 重登成功（${result.status}），登录态已落 profile`);
        return;
      }
      throw new AuthExpiredError(`自动重登未成功（${result.status}）：`
        + String(result.detail || '').slice(0, 200) + ' —— 建议走人机协同首登');
    } finally {
      await probe.close().catch(() => {});
    }
  }

  /** 拦截 GenerateContent：在途改写分辨率 → fetch 放行 → 喂给等待中的任务。 */
  async _handleRpc(route) {
    const req = route.request();
    const bodyText = req.postData() || '';
    let body = null;
    try { body = JSON.parse(bodyText); } catch { /* 非 JSON：原样放行 */ }
    if (Array.isArray(body)) {
      // 宽高比随任务走：从「发起请求的页面」配对的 waiter 上取（页面请求
      // 发出前 waiter 已入列）。取不到（预热请求等）就只改分辨率。
      const wIdx = this._waiterIndexFor(req);
      const wAspect = wIdx >= 0 ? String(this.waiters[wIdx].aspect || '')
        : (this.waiters.length === 1 ? String(this.waiters[0].aspect || '') : '');
      // 分辨率同样随任务走（网站 1K=9 / 4K=10 星点分档计费）；任务没带就用节点默认。
      const wRes = wIdx >= 0 ? String(this.waiters[wIdx].resolution || '')
        : (this.waiters.length === 1 ? String(this.waiters[0].resolution || '') : '');
      const targetRes = (wRes === '1K' || wRes === '2K' || wRes === '4K')
        ? wRes : this.cfg.aistudioResolution;
      const g = body[3];
      // 诊断 4K 被上游钳成 1K：把模型名与原始 generationConfig 打出来对质。
      if (wIdx >= 0 || this.waiters.length === 1) {
        this.log(`  [ai#${this.key}] wire 诊断：url=${req.url().slice(-90)} genCfg=${JSON.stringify(g).slice(0, 360)}`);
      }
      if (rewriteResolution(g, targetRes, wAspect)) {
        this.log(`  [ai#${this.key}] 画布参数已在途改写为 `
          + `${wAspect || '页面默认'} · ${targetRes}`);
      }
    }
    // 🔴 route.fetch 绝不能吃 Playwright 默认 30s 超时：4K 响应体是几十 MB 的
    // chunked 流（200 头 ~3s 就到，body 要流几分钟），2026-09-27 实测 30s 被
    // Playwright 掐断 → 响应永远喂不到 waiter → 任务白等 300s 才「等待超时」。
    // fetch 预算 = 任务预算 - 5s，让 fetch 先死、错误更可读。
    const fetchTimeoutMs = Math.max(60, this.cfg.aistudioTimeoutSeconds - 5) * 1000;
    let resp;
    try {
      resp = await route.fetch({
        ...(Array.isArray(body) ? { postData: JSON.stringify(body) } : {}),
        timeout: fetchTimeoutMs,
      });
    } catch (err) {
      this.log(`  [ai#${this.key}] RPC 拦截失败（${Math.round(fetchTimeoutMs / 1000)}s 内未拿到完整响应）：${err.message}`, 'warn');
      await this._failWaiter(route.request(), err);
      await route.abort().catch(() => {});
      return;
    }
    let buf;
    try {
      buf = await resp.body();
    } catch (err) {
      this.log(`  [ai#${this.key}] 读响应体失败：${err.message}`, 'warn');
      await this._failWaiter(route.request(), err);
      await route.abort().catch(() => {});
      return;
    }
    // 喂给等待中的任务。**按发起页配对**，不是 FIFO —— 10 个 tab 并发时响应
    // 到达顺序与提交顺序无关，FIFO 会把 B 的图交给 A（真实事故形态）。
    // route.request().frame().page() 精确到「哪个页面发的这个请求」；
    // 页面上没有 waiter（页面自己跑的预热请求）就丢弃，绝不污染别人的槽。
    const idx = this._waiterIndexFor(route.request());
    if (idx < 0 && this.waiters.length === 1) {
      // 单 waiter 兜底（frame().page() 个别场景拿不到）
      this.log(`  [ai#${this.key}] 按 page 配对未命中，单 waiter 兜底接管`, 'warn');
      clearTimeout(this.waiters[0].timer);
      this.waiters[0].resolve({ status: resp.status(), bytes: buf });
      this.waiters.splice(0, 1);
    } else if (idx >= 0) {
      clearTimeout(this.waiters[idx].timer);
      this.waiters[idx].resolve({ status: resp.status(), bytes: buf });
      this.waiters.splice(idx, 1);
    }
    await route.fulfill({ response: resp, body: buf }).catch(() => {});
  }

  /** 按「请求来自哪个页面」找 waiter 下标（找不到返回 -1）。 */
  _waiterIndexFor(request) {
    const reqPage = (() => {
      try { return request.frame().page(); } catch { return null; }
    })();
    return this.waiters.findIndex((w) => w.page === reqPage);
  }

  /** 拦截链路失败时立即拒绝配对的 waiter（快败），没有配对就兜底拒绝最后一个。 */
  _failWaiter(request, err) {
    let idx = this._waiterIndexFor(request);
    if (idx < 0 && this.waiters.length === 1) idx = 0;
    if (idx < 0) return;
    const w = this.waiters[idx];
    this.waiters.splice(idx, 1);
    clearTimeout(w.timer);
    if (typeof w.reject === 'function') w.reject(err);
  }

  /**
   * 是否还能取新 tab：worker 领单前的排队闸要用（2026-09-28 起接入全局
   * tab 池——KV-M2 一机承载 aistudio + genspark，整机 tab 上限共享）。
   * 页面策略改为「用完即关」：tab 不再常驻占坑，每次任务新开页面，
   * 否则空闲 tab 会一直握着全局槽位，把另一个执行面饿死。
   */
  hasFreeTab() {
    if (this.tabs.length >= this.cfg.aistudioTabs) return false;
    const pool = this.cfg.tabPool;
    if (pool && !pool.canTakeNow) return false;
    return true;
  }

  async acquireTab() {
    await this.ensure();
    if (this.tabs.length >= this.cfg.aistudioTabs) return null;
    // 🔴 全局 tab 池 FIFO 排队（与 genspark 共享整机 8 槽）；等待期间
    // 调用方（executeAistudio 的排队循环）维持 beat 心跳。
    const pool = this.cfg.tabPool;
    const permit = pool ? await pool.acquire(`ai-${this.key}`, 20 * 60 * 1000) : { label: '' };
    const openPage = async () => {
      const page = await this.context.newPage();
      const tab = { page, permit };
      this.tabs.push(tab);
      return tab;
    };
    try {
      return await openPage();
    } catch (err) {
      // 浏览器实例死亡自愈（1015 深夜实锤：noVNC 虚拟屏里人工关掉浏览器
      // 窗口 = Playwright 持久 context 被连坐杀掉，此后所有任务
      // newPage 报 Target page, context or browser has been closed）。
      // 判定为实例死亡 → 抛弃旧 context 整体重启（_boot 重新 launchPersistent，
      // 登录态在持久 profile 里自持，不受影响）→ 重开一次；其他错误原样上抛。
      if (!/has been closed|Target closed|Browser closed|Session closed|browser has been disconnected/i.test(String((err && err.message) || ''))) {
        pool && pool.release(permit);
        throw err;
      }
      this.log(`  [ai#${this.key}] WARN  浏览器实例已死亡（${String(err.message).split('\n')[0]}）—— 整体重启浏览器…`, 'warn');
      try { if (this.context) await this.context.close(); } catch { /* 已死，幂等 */ }
      this.context = null;
      this.booting = null;
      this.routeArmed = false;
      try {
        await this.ensure();
        return await openPage();
      } catch (err2) {
        pool && pool.release(permit);
        throw err2;
      }
    }
  }

  async releaseTab(tab) {
    if (!tab) return;
    const i = this.tabs.indexOf(tab);
    if (i >= 0) this.tabs.splice(i, 1);
    if (tab.page) await tab.page.close().catch(() => {});
    if (this.cfg.tabPool) this.cfg.tabPool.release(tab.permit);
  }

  /**
   * 单次生图：{prompt, imagePaths?, aspect?} → [{contentType, bytes}]
   * （响应里通常 2 张：预览 + 4K，调用方选最大一张交付）。
   *
   * imagePaths 可空（纯文生图）；有值时在页面里用 setInputFiles 喂给上传
   * 控件（对隐藏 input 也生效），等一会儿让缩略图渲染出来再点 Run。
   * aspect 目前只透传记录：宽高比在 wire 里的具体位置还没抓包定位
   * （方案文档「待校准」项），定位后在这里做在途改写，与分辨率同套路。
   */
  async generate({ prompt, imagePaths = [], aspect = '', resolution = '', cancel = null } = {}) {
    // 🔴 全局开窗串行闸：拿闸后才允许开窗（上一单发出请求后本单才开窗）。
    // releaseOnce 幂等，三重保险：①提交点放行（_submitOnce 点 Run 后立即）；
    // ②generate 兜底 finally；③开窗失败 catch。绝不卡死后面排队的窗口。
    const gate = await submitGate.acquire();
    let gateReleased = false;
    const releaseOnce = () => { if (!gateReleased) { gateReleased = true; gate.release(); } };
    const tab = await this.acquireTab().catch((e) => { releaseOnce(); throw e; });
    if (!tab) {
      releaseOnce();
      throw new Error(`账号 #${this.key} 的 ${this.cfg.aistudioTabs} 个 tab 全忙`);
    }
    const { page } = tab;
    // 🔴 取消中止（2026-10-11）：号池判死时立即关页 —— _submitOnce 的 RPC
    // 等待 race 到 cancel.promise 后 reject，finally 释放 tab。死任务的
    // 浏览器页面不再挂着占槽（执行器 makeImageCancelWatch 的落地点）。
    if (cancel && cancel.promise) {
      cancel.promise.then(() => {
        this.log(`  [ai#${this.key}] 取消信号触发，强制关闭生成页面`, 'warn');
        page.close().catch(() => {});
      }).catch(() => {});
    }
    try {
      await this._gotoStudio(page);
      await this._dismissDialogs(page);
      await this._ensurePromptReady(page, prompt);
      if (imagePaths.length) await this._attachImages(page, imagePaths);
      if (aspect) {
        this.log(`  [ai#${this.key}] 宽高比 ${aspect}（提交时在 wire 里在途改写）`);
      }

      // 🔴 同账号多 tab 并发时，上游会对部分请求**秒回「200 但无图片 part」**
      // （2026-09-27 并发实测：1~2s 就返回，正常出图要 27s+；同批另有任务成功
      // ⟹ 是单账号并发限额，不是模型/页面问题）。另外 1K 档存在**间歇性 403
      // PERMISSION_DENIED**（实测约一半概率，4K 从未复现；重跑即成功）。对策：
      // ① 失败现场（抹掉 base64）打进日志让真因现形；② 两类快失败都整体重试一次
      //（重进页面清残留）；③ 慢失败（超时）不重试，避免拖长尾。
      const maxAttempts = 2;
      let lastErr = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
          this.log(`  [ai#${this.key}] 可重试失败，重试 ${attempt}/${maxAttempts}（重进页面清残留）…`, 'warn');
          await new Promise((r) => setTimeout(r, 8000));
          await this._gotoStudio(page);
          await this._dismissDialogs(page);
          await this._ensurePromptReady(page, prompt);
          if (imagePaths.length) await this._attachImages(page, imagePaths);
        }
        try {
          const out = await this._submitOnce({ page, prompt, imagePaths, aspect, resolution, cancel, releaseOnce });
          if (out) return out;
          // out === null：200 但无图（现场已进日志），需要重试。
          // 🔴 文案里绝不能出现「并发/额度/limit」等词 —— failure.classify 按
          // 关键词归类，2026-09-27 实锤「提示词 'AAA' 过短 → 模型以文本作答」
          // 被误标成「额度/并发用尽」，用户拿着网页版 1000/天的配额页对不上账。
          lastErr = new Error('上游 200 但没有返回图片 —— 常见于提示词过短或语义不明'
            + '（如纯字母/单词，模型会当成聊天作答文字而不是画图）；'
            + '同账号瞬时高负载也可能无图。请丰富提示词后重试');
          lastErr.errorKind = failure.KIND.UPSTREAM_ERROR;
        } catch (err) {
          const msg = String(err?.message || err);
          // 只有快失败可重试：403 权限抖动 / 上游明确的拒绝；超时等慢失败原样抛出
          if (!/返回 403|没有图片 part/.test(msg)) throw err;
          if (/返回 403/.test(msg)) err.errorKind = failure.KIND.UPSTREAM_ERROR;
          lastErr = err;
          this.log(`  [ai#${this.key}] 可重试失败：${msg.slice(0, 140)}`, 'warn');
        }
      }
      throw lastErr || new Error('生图未产出结果');
    } catch (err) {
      // 执行面任何失败都留底：/status 的 accounts[].last_error 远程可见，
      // 托管平台拿不到日志时这里是唯一现场（2026-09-26 OOM 排查的教训）。
      this.bootError = `${err.name || 'Error'}: ${err.message}`;
      throw err;
    } finally {
      releaseOnce();            // 未到提交点就失败：立即放行，不堵排队的窗口
      this.releaseTab(tab);
    }
  }

  /** 单次提交+等待：成功返回图片数组；HTTP 200 但无图返回 null（响应现场进日志）。
   *  cancel = { promise }（可选）：号池判终态时 resolve —— race 进等待，
   *  触发即 reject（err.cancelled=true），配合 generate 里的关页立即中止。 */
  async _submitOnce({ page, prompt, imagePaths, aspect, resolution, cancel = null, releaseOnce = null }) {
    // 捕获槽：waiter 携带 page，拦截器按「请求来自哪个页面」配对（见 _handleRpc）。
    // reject 也挂进 waiter：拦截链路（fetch/读体）失败时立即快败，不等满额。
    const captured = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((x) => x.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`GenerateContent 响应等待超时（${this.cfg.aistudioTimeoutSeconds}s）`));
      }, this.cfg.aistudioTimeoutSeconds * 1000);
      this.waiters.push({ page, resolve, reject, timer, aspect: String(aspect || ''), resolution: String(resolution || '').toUpperCase() });
    });
    // 取消 race：cancel 先到就立即抛 CancelledError，不等 RPC 超时。
    // captured 的迟到 reject 必须 catch 掉，否则 race 出局后未处理的
    // rejection 会让整个进程崩掉（node 15+ 默认行为）。
    const raced = (cancel && cancel.promise)
      ? Promise.race([
        captured,
        cancel.promise.then(() => {
          const e = new Error('任务已被号池判终态（超时/取消），节点中止等待出图');
          e.cancelled = true;
          throw e;
        }),
      ])
      : captured;
    if (raced !== captured) captured.catch(() => {});

    await this._clickRun(page);
    this.log(`  [ai#${this.key}] 已提交，等待出图（最长 ${this.cfg.aistudioTimeoutSeconds}s）…`);
    // 🔴 请求已发出：立即放行全局开窗闸——下一个窗口可以开了；出图等待不占闸。
    if (releaseOnce) releaseOnce();
    const { status, bytes } = await raced;
    if (status !== 200) {
      const head = bytes.slice(0, 200).toString('utf-8', 0, 200);
      // 🔴 429 账号限流（2026-10-14 用户口径）：GenerateContent 层的 429 =
      // 该 Google 账号被上游限流。打结构化标记抛出，由 index.js 的
      // runTask.failover 接手：回报号池 sleep_until=+1h（账号休息 1 小时，
      // sleep_until 闸通用、号池零改动）→ 换号重试一次（429 时上游未建单，
      // 重提安全）。generate() 的重试条件（/返回 403|没有图片 part/）不含
      // 429 文案 ⟹ 本地不会先自耗一次重试，直接上抛换号。
      if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(head)) {
        const e = new Error(`GenerateContent 返回 ${status}（账号被限流）：${head}`);
        e.accountRateLimited = true;
        e.errorKind = failure.KIND.QUOTA;
        throw e;
      }
      throw new Error(`GenerateContent 返回 ${status}：${head}`);
    }
    const raw = bytes.toString('utf-8');
    const images = extractImages(JSON.parse(raw));
    if (!images.length) {
      // 现场留底：抹掉 base64 长串后打前 320 字符 —— 限额文案/安全拦截/模型
      // 不符都在这里现形（此前只有一句「没有图片 part」，无法定位真因）。
      const head = raw.replace(/[A-Za-z0-9+/=]{120,}/g, '«base64»').slice(0, 320);
      this.log(`  [ai#${this.key}] 响应 200 但没有图片 part —— 现场：${head}`, 'warn');
      return null;
    }
    // 🔴 响应里通常是「预览(1K) + 成品(4K)」多张：必须**按字节量降序**再截取，
    // 否则 slice(0,1) 恒交第一张预览图 —— 「请求 4K 实际出 1K」的根因
    //（2026-09-27 实锤：请求 4K 成图 768x1376，响应体却几十 MB，4K 原图被丢弃）。
    const sorted = [...images].sort((a, b) => b.base64.length - a.base64.length);
    const max = Number(this.cfg.aistudioMaxImages) || 0;
    const out = max > 0 ? sorted.slice(0, max) : sorted;
    if (out.length < images.length) {
      this.log(`  [ai#${this.key}] 上游出了 ${images.length} 张（最大 ${(sorted[0].base64.length * 0.75 / 1048576).toFixed(2)}MB），按 aistudioMaxImages=${max} 交付最大 ${max} 张`);
    }
    this.bootError = null;
    return out;
  }

  /** 打开工作台；被踢去登录页 = 登录态失效 —— 登录型账号先试自动重登再重开一次。 */
  async _gotoStudio(page) {
    const open = async () => {
      try {
        // 直开带模型参数的 URL（1015 用户口径：https://aistudio.google.com/
        // prompts/new_chat?model=gemini-3-pro-image 直落 Nano Banana Pro 生图
        // 界面，省掉「点模型下拉」这个不受保证的 UI 动作；_clickRun 里的
        // chip 切换保留为兜底）。
        await page.goto('https://aistudio.google.com/prompts/new_chat?model=gemini-3-pro-image', {
          waitUntil: 'domcontentloaded', timeout: 45_000,
        });
      } catch {
        await page.goto('https://aistudio.google.com/', {
          waitUntil: 'domcontentloaded', timeout: 45_000,
        });
      }
      await page.waitForTimeout(1500);
    };
    await open();
    // 🔴 登录跳转是客户端异步重定向（1015 深夜实锤：74 号已被 Google 登出
    // 的账号，domcontentloaded 后 1.5s 时 URL 还停在 aistudio，数秒后才落到
    // accounts.google.com 选择器页——固定等 1.5s 必漏判 → 找不到输入框死循环）。
    // 改为最多 12s 轮询：textarea 出现=正常进入（提前返回）；URL 落到登录域=走重登。
    let url = '';
    for (let i = 0; i < 24; i += 1) {
      await page.waitForTimeout(500);
      url = page.url();
      if (/accounts\.google\.com|ServiceLogin|signin/.test(url)) break;
      if (await page.$(PROMPT_SELECTORS)) return;
    }
    if (!/accounts\.google\.com|ServiceLogin|signin/.test(url)) return;
    if (this.creds.kind === 'google_login') {
      this.log(`  [ai#${this.key}] 页面被踢到登录页 —— 先自动重登再重开`);
      await this._ensureLoggedIn();
      await open();
      url = page.url();
      if (!/accounts\.google\.com|ServiceLogin|signin/.test(url)) return;
      throw new AuthExpiredError(`重登后仍被重定向（${url.slice(0, 80)}）`);
    }
    throw new AuthExpiredError(`cookie 已失效（页面被重定向到 ${url.slice(0, 80)}）`);
  }

  /** 把提示词灌进输入框（多级候选选择器 + 自愈硬刷新 + 兜底键盘输入）。
   *  🔴 自愈 reload（2026-10-15 全量失败复盘）：tab 是长驻复用的 SPA 实例，
   *  Google 推新前端后旧 bundle 的组件树在 goto（同源路由，不重载 bundle）时
   *  渲染死亡——页面 URL 正常但 DOM 里连 textarea 都没有，waitForSelector 必然
   *  超时。探针实测「全新加载的页面」DOM 正常 ⟹ reload（强拉服务端 bundle）
   *  即可自愈。选择器失配时先硬刷新再找一轮，找不到才真报结构变化。 */
  async _ensurePromptReady(page, prompt) {
    const findInput = async () => {
      await page.waitForSelector(PROMPT_SELECTORS, { timeout: 20_000 })
        // 点击只是聚焦辅助：参考图摄取期间可能有遮罩盖住输入框（探针实测会
        // 白等 30s），超时给短（3s），失败不影响后续 fill/type。
        .then((el) => el.click({ clickCount: 3, timeout: 3_000 }))
        .catch(() => null);
      // 挑第一个「可见」匹配——DOM 里可能存在隐藏 textarea（首匹配不可点）。
      const cands = await page.$$(PROMPT_SELECTORS);
      for (const c of cands) {
        if (await c.isVisible().catch(() => false)) return c;
      }
      return null;
    };
    let el = await findInput();
    if (!el) {
      this.log('  [ai#' + this.key + '] 页面无输入框（疑似长驻 SPA 实例过期/前端热更）——硬刷新页面重试…', 'warn');
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(6000);
      } catch (err) {
        this.log('  [ai#' + this.key + '] reload 失败（继续按原页面找）:' + (err.message || err), 'warn');
      }
      el = await findInput();
    }
    if (!el) {
      throw new Error('找不到提示词输入框 —— AI Studio 前端结构变了，'
        + '需要校准 lib/aistudio.js 的 PROMPT_SELECTORS');
    }
    // 🔴 定位器版输入（1015 深夜生产实锤：findInput 拿到的 elementHandle 会被
    // SPA 重渲染变成僵尸句柄，type 卡 30s 可交互性等待超时——用户看到的就是
    // 「提示词打一半，窗口直接被关」）。locator 每次操作自动重解析最新元素；
    // 逐键失稳时兜底 fill 一次性灌入（无逐键延迟，但绝不卡死）。
    const locs = page.locator(PROMPT_SELECTORS);
    const n = await locs.count().catch(() => 0);
    let loc = null;
    for (let i = 0; i < n; i += 1) {
      const cand = locs.nth(i);
      if (await cand.isVisible().catch(() => false)) { loc = cand; break; }
    }
    if (!loc) loc = locs.first();
    // 🔴 1015 用户定版：不做逐键敲击（慢、且会被 SPA 重渲染打断成僵尸句柄
    // 超时——生产连坏多单的元凶）。改为整段一次性灌入，等效剪贴板整段粘贴：
    // 一个动作写入全部文本，瞬间完成；且比走系统剪贴板更稳（免剪贴板权限、
    // 免焦点竞争）。fill 派发标准 input 事件，Angular 双向绑定正常生效
    // （生产实测 fill 灌入后成功出图）。
    try {
      await loc.fill(prompt, { timeout: 15_000 });
    } catch (err) {
      this.log(`  [ai#${this.key}] 灌入失稳（${String((err && err.message) || err).split('\n')[0]}）—— 重挑可见输入框再灌一次`, 'warn');
      const n2 = await locs.count().catch(() => 0);
      let loc2 = null;
      for (let i = 0; i < n2; i += 1) {
        const cand = locs.nth(i);
        if (await cand.isVisible().catch(() => false)) { loc2 = cand; break; }
      }
      await (loc2 || locs.first()).fill(prompt, { timeout: 15_000 });
    }
  }

  /** 参考图进页面：setInputFiles 喂上传控件（隐藏 input 也可），失败给明确校准指引。 */
  async _attachImages(page, imagePaths) {
    const input = await page.$(IMAGE_INPUT_SELECTORS);
    if (!input) {
      throw new Error('找不到参考图上传控件（input[type=file]) —— 需要校准 '
        + 'lib/aistudio.js 的 IMAGE_INPUT_SELECTORS；若任务本意是纯文生图，'
        + '请不带参考图重新提交');
    }
    await input.setInputFiles(imagePaths);
    // 等页面把图吃进去（缩略图/上传条出现）。没有可靠的完成信号，给一段
    // 固定缓冲：本地图 feed 后 AI Studio 是前端压缩+内联，通常秒级。
    await page.waitForTimeout(1500 * imagePaths.length);
    this.log(`  [ai#${this.key}] 已挂载 ${imagePaths.length} 张参考图`);
  }

  /**
   * 关掉挡住输入区/Run 的 cdk 对话框（1015 生产实锤：任务 e4b8d495 两连败，
   * Playwright call log 明示 `<div class="cdk-overlay-backdrop
   * dialog-backdrop-blur-overlay"></div> subtree intercepts pointer events`
   * ——带参考图时 UI 弹对话框，backdrop 把后续所有鼠标点击拖到 30s 超时）。
   * 优先点关闭按钮，退而按 Esc；无对话框时零开销。
   */
  async _dismissDialogs(page) {
    try {
      const has = await page.$('.cdk-overlay-backdrop.cdk-overlay-backdrop-showing');
      if (!has) return;
      this.log('  [ai#' + this.key + '] 检测到页面对话框遮罩 —— 尝试处理…', 'warn');
      // ①「接受」类弹窗（1015 实测 Accept terms of service——Google 新规：账号
      //    首次用 Nano Banana Pro 要接受新条款；只有 Accept 一个按钮、Esc 无效，
      //    backdrop 拦截全部鼠标点击）：点接受是唯一出路。
      //    🔴 必须用 Playwright 真实点击——evaluate 的 el.click() 触发不了
      //    Angular Material 的处理器（探针实测连点 40 次纹丝不动）。
      const paneBtns = await page.$$('.cdk-overlay-pane button');
      let acceptBtn = null;
      for (const b of paneBtns) {
        const sig = ((await b.getAttribute('aria-label').catch(() => '')) || '') + ' '
          + (await b.innerText().catch(() => ''));
        if (/accept|agree|同意|接受/i.test(sig)) { acceptBtn = b; break; }
      }
      if (acceptBtn) {
        await acceptBtn.click({ timeout: 5000 }).catch(() => {});
        this.log('  [ai#' + this.key + '] 点击「接受」类按钮（服务条款/确认）…', 'warn');
        await page.waitForTimeout(2500);
        if (!(await page.$('.cdk-overlay-backdrop.cdk-overlay-backdrop-showing'))) {
          this.log('  [ai#' + this.key + '] 已接受服务条款/确认弹窗 ✓', 'warn');
          return;
        }
      }
      // ② 普通弹窗（升级推销等）：点关闭按钮，再退 Esc。
      const closer = await page.$('.cdk-overlay-pane button[aria-label*="close" i]');
      if (closer) await closer.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      if (await page.$('.cdk-overlay-backdrop.cdk-overlay-backdrop-showing')) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(800);
      }
      if (await page.$('.cdk-overlay-backdrop.cdk-overlay-backdrop-showing')) {
        this.log('  [ai#' + this.key + '] 对话框仍在 —— 键盘链路（Ctrl+Enter）不受遮罩影响，继续', 'warn');
      }
    } catch { /* 尽力而为 */ }
  }

  /** 点 Run。点之前顺手尝试选中 gemini-3-pro-image（失败不打断，响应无图时再报）。 */
  async _clickRun(page) {
    // 尽力而为选模型：开模型下拉 → 点含关键字的项。选择器校准前的兜底逻辑。
    // 1015 起若 URL 已带 model 参数（_gotoStudio 直开）则跳过——有参考图时
    // 切模型会弹 cdk 确认对话框，backdrop 盖住输入框与 Run（见 _dismissDialogs）。
    if (!/[?&]model=/.test(page.url())) {
      try {
        const msChip = await page.$('ms-model-selector, [aria-label*="model" i]');
        if (msChip) {
          await msChip.click();
          await page.waitForTimeout(600);
          for (const hint of MODEL_TEXT_HINTS) {
            const item = await page.$(`text=${hint}`);
            if (item) { await item.click(); await page.waitForTimeout(400); break; }
          }
          await this._dismissDialogs(page);
        }
      } catch { /* 选不上就按页面默认模型跑 */ }
    }

    // Run 找不到同样走自愈 reload（同 _ensurePromptReady：长驻 SPA 实例过期时
    // 输入框可能被 fill 后又被前端热更换掉）。reload 后提示词会丢——重新灌一遍。
    let run = await page.$(RUN_SELECTORS);
    if (!run) {
      this.log('  [ai#' + this.key + '] 无 Run 按钮 —— 硬刷新页面重试…', 'warn');
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(6000);
        await this._ensurePromptReady(page, prompt);
      } catch (err) {
        this.log('  [ai#' + this.key + '] reload 重灌失败:' + (err.message || err), 'warn');
      }
      run = await page.$(RUN_SELECTORS);
    }
    if (!run) {
      throw new Error('找不到 Run 按钮 —— 需要校准 lib/aistudio.js 的 RUN_SELECTORS');
    }
    // 遮罩在挂图/其他交互后也可能出现——点 Run 前最后清一次。
    await this._dismissDialogs(page);
    // 参考图上传/压缩期间 Run 处于 aria-disabled=true（1015 探针实测 T+2s 仍禁用），
    // 不等就绪就 click 会在 enabled 检查上白耗 30s 再超时。宽限 60s 等就绪。
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      return Boolean(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    }, RUN_SELECTORS, { timeout: 60_000 }).catch(() => null);
    // 点击失败不再致命（1015 事故：点不动时直接 throw，Ctrl+Enter 双保险根本
    // 执行不到）。短超时落入下方双保险。
    try {
      await run.click({ timeout: 10_000 });
    } catch (err) {
      this.log('  [ai#' + this.key + '] Run 按钮点击未完成（转入 Ctrl+Enter 双保险）:'
        + (err.message || err), 'warn');
    }
    // 双保险（2026-09-27 实测）：真实页面里点 Run 按钮可能不触发提交（本地抓包
    // 第一轮点 Run 后 GenerateContent 从未发出）。UI 标注 Run Ctrl+↵ —— 焦点
    // 在输入框时 Ctrl+Enter 一定提交（唯一验证过能触发 RPC 的方式）。
    // 1015 起挑可见匹配（隐藏 textarea focus 不到，快捷键会落空）。
    const tas = await page.$$(PROMPT_SELECTORS);
    let ta = null;
    for (const c of tas) {
      if (await c.isVisible().catch(() => false)) { ta = c; break; }
    }
    if (ta) {
      await ta.focus().catch(() => {});
      await page.keyboard.press('Control+Enter').catch(() => {});
    }
  }

  async close() {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      try { w.resolve({ status: 0, bytes: Buffer.alloc(0) }); } catch { /* 关停竞态 */ }
    }
    try { if (this.context) await this.context.close(); } catch { /* 幂等 */ }
    this.context = null;
    // 关停时归还每个在跑 tab 持有的全局槽位（否则 tabPool.active 泄漏，
    // 另一个执行面会被永久饿死）。
    for (const tab of this.tabs) {
      if (this.cfg.tabPool) this.cfg.tabPool.release(tab.permit);
    }
    this.tabs = [];
    this.booting = null;
  }
}

/** 账号池：accountKey → AistudioAccount。cookie 换新时 updateCookie() 原地热更。 */
class AistudioPool {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.accounts = new Map();     // key → {account, sig}
  }

  /**
   * profile 残留对账：控制台已删除的账号，其磁盘 profile 目录就地清掉。
   *
   * @param {Array<string|number>} validKeys 控制台现存账号 id 清单
   *   （调用方必须保证这是**拉取成功**后的清单 —— 拉取失败宁可不调，
   *   宁留勿删）。清单为空 = 用户删光了所有账号 → 全部清理。
   *
   * 安全阀：还挂在内存里（有任务在跑/刚热更）的账号绝不动。
   */
  async reconcileProfiles(validKeys) {
    const keep = new Set(validKeys.map(String));
    const removed = [];
    try {
      for (const name of fs.readdirSync(this.cfg.aistudioProfileDir)) {
        const full = path.join(this.cfg.aistudioProfileDir, name);
        if (!fs.statSync(full).isDirectory()) continue;   // cookies-live-*.json 等散文件不碰
        if (keep.has(name) || this.accounts.has(name)) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(name);
      }
    } catch (e) {
      this.log(`  [ai] profile 对账失败（本地未动）：${e.message}`);
      return removed;
    }
    if (removed.length) {
      this.log(`  [ai] 已清理控制台已删账号的残留 profile：${removed.join(', ')}`);
    }
    return removed;
  }

  /**
   * 取（或建）账号执行器。session = normalizeAiSession 产物（cookie 或
   * google_login 两形态）。凭据签名与上次不同 ⟹ 原地热更（换 cookie /
   * 改密码 / 换 TOTP 不必杀进程，下次 ensure 重开）。
   */
  get(accountKey, session) {
    const key = String(accountKey);
    const s = session || {};
    const sig = s.kind === 'google_login'
      ? JSON.stringify([s.email, s.password, s.totp_secret, s.backup_codes])
      : String(s.cookie || '');
    let entry = this.accounts.get(key);
    if (!entry) {
      entry = {
        account: new AistudioAccount({
          accountKey: key, session: s, cfg: this.cfg, log: this.log,
        }),
        sig,
      };
      this.accounts.set(key, entry);
    } else if (entry.sig !== sig) {
      entry.sig = sig;
      entry.account.creds = s;
      // 热更：清掉旧 context，下次 ensure 用新凭据重开（version+1 才会走到这）
      entry.account.close().catch(() => {});
      this.log(`  [ai#${key}] 凭据已更新（v+1），执行会话将重开`);
    }
    return entry.account;
  }

  async stop() {
    for (const { account } of this.accounts.values()) await account.close();
    this.accounts.clear();
  }

  /** 观测：/status 直接透出。启动失败的原因必须远程可见（托管平台日志难取）。 */
  status() {
    return {
      enabled: Boolean(this.cfg.aistudioEnabled),
      tabs: this.cfg.aistudioTabs,
      accounts: [...this.accounts.entries()].map(([key, e]) => ({
        key,
        booted: Boolean(e.account.context),
        tabs_open: e.account.tabs.length,
        waiters: e.account.waiters.length,
        last_error: e.account.bootError || null,
      })),
    };
  }
}

module.exports = {
  AistudioPool,
  AuthExpiredError,
  extractImages,
  parseCookieHeader,
  rewriteResolution,
  RPC_URL_MATCH,
};
