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

const RPC_URL_MATCH = /alkalimakersuite-pa\.clients6\.google\.com\/.*GenerateContent/;

/** AI Studio 提示词输入框 / Run 按钮的多级候选选择器（真实 DOM 校准后收敛）。 */
const PROMPT_SELECTORS = [
  'textarea[aria-label*="Type" i]',
  'textarea[placeholder*="Type" i]',
  'textarea[aria-label*="提示" i]',
  'ms-autocomplete textarea',
  'ms-chunk-editor textarea',
  'main textarea',
].join(', ');
const RUN_SELECTORS = [
  'button[aria-label*="Run" i]',
  'button[aria-label*="运行" i]',
  'button.run-button',
].join(', ');
const MODEL_TEXT_HINTS = ['Gemini 3 Pro Image', 'gemini-3-pro-image'];

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

/** 生成请求 wire 里 generationConfig 末位的分辨率档 [null,"1K"|"4K"]。 */
function rewriteResolution(generationConfig, resolution) {
  if (!Array.isArray(generationConfig)) return false;
  for (let i = 0; i < generationConfig.length; i += 1) {
    const el = generationConfig[i];
    if (Array.isArray(el) && el.length === 2 && el[0] === null
        && (el[1] === '1K' || el[1] === '2K' || el[1] === '4K')) {
      generationConfig[i] = [null, resolution];
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
   * @param {{accountKey: string|number, cookieStr: string, cfg: object,
   *           log: function}} opts
   */
  constructor({ accountKey, cookieStr, cfg, log }) {
    this.key = String(accountKey);
    this.cookieStr = cookieStr;
    this.cfg = cfg;
    this.log = log || (() => {});
    this.profileDir = path.resolve(cfg.aistudioProfileDir, this.key);
    this.context = null;
    this.tabs = [];            // [{ page, busy }]
    this.booting = null;       // 并发 ensure 只跑一次
    this.routeArmed = false;   // context 级路由只挂一次
    this.waiters = [];         // 捕获槽：[{page, resolve, timer}]
  }

  /** 启动/复用持久 context 并打开一个登录页面。重复调用返回同一个 promise。 */
  async ensure() {
    if (this.booting) return this.booting;
    this.booting = this._boot().catch((err) => { this.booting = null; throw err; });
    return this.booting;
  }

  async _boot() {
    fs.mkdirSync(this.profileDir, { recursive: true });
    // playwright 是可选依赖：没装就 fail closed，由调用方降级
    let pw;
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      pw = require('playwright');
    } catch (e) {
      throw new Error('未安装 playwright（npm i playwright && npx playwright install chromium）'
        + `—— AI Studio 执行面不可用: ${e.message}`);
    }
    this.log(`  [ai#${this.key}] 启动 Chromium 持久 profile：${this.profileDir}`);
    this.context = await pw.chromium.launchPersistentContext(this.profileDir, {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      viewport: { width: 1440, height: 900 },
      timeout: 60_000,
    });

    // cookie：号池下发的字符串写进 profile。version 变化时由 reloadCookies() 重写。
    await this.reloadCookies();

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
    const cookies = parseCookieHeader(this.cookieStr);
    if (!cookies.length) throw new AuthExpiredError('账号凭据为空');
    await this.context.addCookies(cookies);
  }

  /** 拦截 GenerateContent：在途改写分辨率 → fetch 放行 → 喂给等待中的任务。 */
  async _handleRpc(route) {
    const req = route.request();
    const bodyText = req.postData() || '';
    let body = null;
    try { body = JSON.parse(bodyText); } catch { /* 非 JSON：原样放行 */ }
    if (Array.isArray(body) && this.cfg.aistudioResolution) {
      const g = body[3];
      if (rewriteResolution(g, this.cfg.aistudioResolution)) {
        this.log(`  [ai#${this.key}] 分辨率已在途改写为 ${this.cfg.aistudioResolution}`);
      }
    }
    const resp = await route.fetch({
      ...(Array.isArray(body) ? { postData: JSON.stringify(body) } : {}),
    });
    const buf = await resp.body();
    // 喂给等待中的任务。**按发起页配对**，不是 FIFO —— 10 个 tab 并发时响应
    // 到达顺序与提交顺序无关，FIFO 会把 B 的图交给 A（真实事故形态）。
    // route.request().frame().page() 精确到「哪个页面发的这个请求」；
    // 页面上没有 waiter（页面自己跑的预热请求）就丢弃，绝不污染别人的槽。
    const reqPage = (() => {
      try { return route.request().frame().page(); } catch { return null; }
    })();
    const idx = this.waiters.findIndex((w) => w.page === reqPage);
    if (idx < 0 && this.waiters.length === 1) {
      // 单 waiter 兜底（frame().page() 个别场景拿不到）
      this.log(`  [ai#${this.key}] 按 page 配对未命中，单 waiter 兜底接管`, 'warn');
      this.waiters[0].resolve({ status: resp.status(), bytes: buf });
    } else if (idx >= 0) {
      clearTimeout(this.waiters[idx].timer);
      this.waiters[idx].resolve({ status: resp.status(), bytes: buf });
    }
    await route.fulfill({ response: resp, body: buf });
  }

  /** 取一个空闲 tab（必要时新开，到上限为止）；全忙返回 null。 */
  async acquireTab() {
    await this.ensure();
    let tab = this.tabs.find((t) => !t.busy);
    if (!tab && this.tabs.length < this.cfg.aistudioTabs) {
      const page = await this.context.newPage();
      tab = { page, busy: false };
      this.tabs.push(tab);
    }
    if (!tab) return null;
    tab.busy = true;
    return tab;
  }

  releaseTab(tab) {
    if (!tab) return;
    tab.busy = false;
  }

  /**
   * 单次生图：{prompt} → [{contentType, bytes}]（响应里通常 2 张：预览 + 4K，
   * 调用方选最大一张交付）。
   */
  async generate({ prompt }) {
    const tab = await this.acquireTab();
    if (!tab) throw new Error(`账号 #${this.key} 的 ${this.cfg.aistudioTabs} 个 tab 全忙`);
    const { page } = tab;
    try {
      await this._gotoStudio(page);
      await this._ensurePromptReady(page, prompt);

      // 捕获槽 + 提交。4K 实测 ~120s，超时给 cfg.aistudioTimeoutSeconds。
      // waiter 携带 page：拦截器按「请求来自哪个页面」配对（见 _handleRpc）。
      const captured = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = this.waiters.findIndex((x) => x.resolve === resolve);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error(`GenerateContent 响应等待超时（${this.cfg.aistudioTimeoutSeconds}s）`));
        }, this.cfg.aistudioTimeoutSeconds * 1000);
        this.waiters.push({ page, resolve, timer });
      });

      await this._clickRun(page);
      this.log(`  [ai#${this.key}] 已提交，等待出图（最长 ${this.cfg.aistudioTimeoutSeconds}s）…`);
      const { status, bytes } = await captured;
      if (status !== 200) {
        const head = bytes.slice(0, 200).toString('utf-8', 0, 200);
        throw new Error(`GenerateContent 返回 ${status}：${head}`);
      }
      const images = extractImages(JSON.parse(bytes.toString('utf-8')));
      if (!images.length) {
        throw new Error('响应里没有图片 part —— 页面当前模型可能不是 gemini-3-pro-image，'
          + '请在页面上选好模型后重试');
      }
      return images;
    } finally {
      this.releaseTab(tab);
    }
  }

  /** 打开工作台；被踢去登录页 = cookie 失效。 */
  async _gotoStudio(page) {
    try {
      await page.goto('https://aistudio.google.com/prompts/new_chat', {
        waitUntil: 'domcontentloaded', timeout: 45_000,
      });
    } catch {
      await page.goto('https://aistudio.google.com/', {
        waitUntil: 'domcontentloaded', timeout: 45_000,
      });
    }
    await page.waitForTimeout(1500);
    const url = page.url();
    if (/accounts\.google\.com|ServiceLogin|signin/.test(url)) {
      throw new AuthExpiredError(`cookie 已失效（页面被重定向到 ${url.slice(0, 80)}）`);
    }
  }

  /** 把提示词灌进输入框（多级候选选择器 + 兜底键盘输入）。 */
  async _ensurePromptReady(page, prompt) {
    await page.waitForSelector(PROMPT_SELECTORS, { timeout: 20_000 })
      .then((el) => el.click({ clickCount: 3 }))
      .catch(() => null);
    const el = await page.$(PROMPT_SELECTORS);
    if (!el) {
      throw new Error('找不到提示词输入框 —— AI Studio 前端结构变了，'
        + '需要校准 lib/aistudio.js 的 PROMPT_SELECTORS');
    }
    await el.fill('');          // 清掉上一条任务的残留
    await el.type(prompt, { delay: 5 });
  }

  /** 点 Run。点之前顺手尝试选中 gemini-3-pro-image（失败不打断，响应无图时再报）。 */
  async _clickRun(page) {
    // 尽力而为选模型：开模型下拉 → 点含关键字的项。选择器校准前的兜底逻辑。
    try {
      const msChip = await page.$('ms-model-selector, [aria-label*="model" i]');
      if (msChip) {
        await msChip.click();
        await page.waitForTimeout(600);
        for (const hint of MODEL_TEXT_HINTS) {
          const item = await page.$(`text=${hint}`);
          if (item) { await item.click(); await page.waitForTimeout(400); break; }
        }
      }
    } catch { /* 选不上就按页面默认模型跑 */ }

    const run = await page.$(RUN_SELECTORS);
    if (!run) {
      throw new Error('找不到 Run 按钮 —— 需要校准 lib/aistudio.js 的 RUN_SELECTORS');
    }
    await run.click();
  }

  async close() {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      try { w.resolve({ status: 0, bytes: Buffer.alloc(0) }); } catch { /* 关停竞态 */ }
    }
    try { if (this.context) await this.context.close(); } catch { /* 幂等 */ }
    this.context = null;
    this.tabs = [];
    this.booting = null;
  }
}

/** 账号池：accountKey → AistudioAccount。cookie 换新时 updateCookie() 原地热更。 */
class AistudioPool {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.accounts = new Map();     // key → {account, cookieStr}
  }

  /** 取（或建）账号执行器。cookie 与上次不同 ⟹ 原地热更（换 cookie 不重启）。 */
  get(accountKey, cookieStr) {
    const key = String(accountKey);
    let entry = this.accounts.get(key);
    if (!entry) {
      entry = {
        account: new AistudioAccount({
          accountKey: key, cookieStr, cfg: this.cfg, log: this.log,
        }),
        cookieStr,
      };
      this.accounts.set(key, entry);
    } else if (entry.cookieStr !== cookieStr) {
      entry.cookieStr = cookieStr;
      entry.account.cookieStr = cookieStr;
      // 热更：清掉旧 context，下次 ensure 用新 cookie 重开（version+1 才会走到这）
      entry.account.close().catch(() => {});
      this.log(`  [ai#${key}] cookie 已更新（v+1），执行会话将重开`);
    }
    return entry.account;
  }

  async stop() {
    for (const { account } of this.accounts.values()) await account.close();
    this.accounts.clear();
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
