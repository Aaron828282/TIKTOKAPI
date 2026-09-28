'use strict';
/**
 * Genspark 生图执行器（backend = genspark_image）。
 *
 * 为什么是纯 HTTP 而不是浏览器
 * ----------------------------
 * 与 aistudio（令牌绑定提示词、必须页面现签）相反，Genspark 的 ask_proxy
 * **只认 cookie 会话**：2026-09-28 实测——完整删掉 g_recaptcha_token 字段
 * 照样出图（44.6s SUCCESS）、随机 chat_session_id 无所谓、 trace 头乱填也过。
 * 一条 `fetch` + SSE 解析就是全部执行面，不需要 Playwright/Chromium。
 *
 * project_id 的自举（关键实测结论）
 * --------------------------------
 * ask_proxy 的 project_id **必须真实存在**（随机 UUID 直接 HTTP 500），
 * 但项目可以用 cookie 自己创建：
 *     POST /api/project/create   →  200 {"status":0,"data":{"id":"<uuid>"}}
 * 所以每账号只需要一份 cookie：首次执行时自动建一个项目，project_id 缓存在
 * 内存里随账号走（丢了就再建一个，零成本）。**用户录入时不需要提供任何
 * cookie 之外的字段。**
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
 * 并发模型
 * --------
 * 无上游并发上限（8 路并发实测全部受理），约束是 5h 窗口（≈20 张/号）。
 * 槽位数 = 号池 agent_accounts.max_slots（默认 5），租约由号池记账；
 * 本执行器不自己限并发 —— 同一账号同时被租几个槽就并发几个请求。
 */

const crypto = require('node:crypto');

const BASE = 'https://www.genspark.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

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

function baseHeaders(cookie) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    cookie: String(cookie || ''),
    origin: BASE,
    referer: BASE + '/',
    'user-agent': UA,
    'x-timezone': 'Asia/Shanghai',
  };
}

/** 一次请求的 trace 头 —— 服务端没有校验逻辑（实测乱填也过），但仍按真实形态生成。 */
function traceHeaders(extra = {}) {
  const trace = crypto.randomUUID().replace(/-/g, '');
  return {
    'request-id': `|${trace}.${crypto.randomUUID().hex || crypto.randomBytes(8).toString('hex')}`,
    traceparent: `00-${trace}-${crypto.randomBytes(8).toString('hex')}-01`,
    ...extra,
  };
}

/** 解析 SSE 全文：抽出 results / session_limit_message / agent 最终文本。 */
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
  }

  get valid() {
    return Boolean(cookieValue(this.cookie, 'session_id'));
  }

  /** 每请求公共头（referer 指向当前项目，与真实页面一致）。 */
  _headers(projectId) {
    return {
      ...baseHeaders(this.cookie),
      ...traceHeaders(),
      referer: projectId ? `${BASE}/agents?id=${projectId}` : `${BASE}/`,
      accept: '*/*',
    };
  }

  /**
   * 探活 + 会员档采集：GET /api/user。
   * 返回 { email, plan, name }；401/403 → AuthExpiredError。
   */
  async health() {
    let res;
    try {
      res = await fetch(`${BASE}/api/user`, {
        headers: baseHeaders(this.cookie),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`Genspark 探活网络错误：${err.message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthExpiredError(`Genspark cookie 失效（HTTP ${res.status}）`);
    }
    if (!res.ok) throw new Error(`Genspark /api/user HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const cogen = (data && data.data && data.data.cogen) || {};
    return {
      email: String(cogen.email || ''),
      name: String(cogen.name || ''),
      plan: String(cogen.plan || (cogen.personal_membership_ext || {}).status || '').toLowerCase(),
    };
  }

  /** 确保账号有一个可用 project_id（首次自动创建，之后缓存复用）。 */
  async ensureProject() {
    if (this.projectId) return this.projectId;
    let res;
    try {
      res = await fetch(`${BASE}/api/project/create`, {
        method: 'POST',
        headers: this._headers(''),
        body: JSON.stringify({ article: '# image' }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`Genspark 项目创建网络错误：${err.message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthExpiredError(`Genspark cookie 失效（HTTP ${res.status}）`);
    }
    if (!res.ok) throw new Error(`Genspark 项目创建 HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const pid = String((data && data.data && data.data.id) || '');
    if (!pid) throw new Error(`Genspark 项目创建响应异常：${JSON.stringify(data).slice(0, 200)}`);
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
    const pid = await this.ensureProject();
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
      // 上游若收紧（HTTP 4xx），再让录入方补抓一个 token（接口预留，见设计文档）。
      is_private: true, push_token: '', last_seen_event_index: -1,
      chat_session_id: crypto.randomUUID(),
    };
    const timeoutMs = Math.max(60, Number(this.cfg.gensparkTimeoutSeconds) || 300) * 1000;
    let res;
    try {
      res = await fetch(`${BASE}/api/agent/ask_proxy`, {
        method: 'POST',
        headers: this._headers(pid),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = new Error(`Genspark 提交/读流失败（${Math.round(timeoutMs / 1000)}s 预算）：${err.message}`);
      e.errorKind = 'UPSTREAM_ERROR';
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthExpiredError(`Genspark cookie 失效（HTTP ${res.status}）`);
    }
    if (!res.ok) {
      const e = new Error(`Genspark ask_proxy HTTP ${res.status}：`
        + (await res.text().catch(() => '')).slice(0, 200));
      e.errorKind = 'UPSTREAM_ERROR';
      throw e;
    }
    const text = await res.text();
    const { results, limited, resetTs, limitRaw } = parseSse(text);
    if (limited && !results.length) {
      throw new QuotaLimitError(resetTs, limitRaw);
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
    if (!url) throw new Error('Genspark 结果缺图片 URL（status=' + ok.status + '）');
    const img = await fetch(url, {
      headers: { cookie: this.cookie, referer: `${BASE}/`, 'user-agent': UA },
      signal: AbortSignal.timeout(180_000),
    });
    if (!img.ok) {
      const e = new Error(`成图下载失败 HTTP ${img.status}（${url.slice(0, 90)}）`);
      e.errorKind = 'UPSTREAM_ERROR';
      throw e;
    }
    const bytes = Buffer.from(await img.arrayBuffer());
    if (!bytes.length) throw new Error('成图下载结果为空');
    const contentType = String(img.headers.get('content-type') || 'image/png');
    this.created += 1;
    this.lastError = null;
    return { bytes, contentType, model: realModel, size: realSize,
             taskId: String(ok.task_id || ''), promptUsed: String(ok.prompt || '') };
  }

  async close() { /* 无常驻资源：纯 HTTP，无事可收 */ }
}

/** 账号池：accountKey → GensparkAccount。cookie 换新时原地热更。 */
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
      // 换 cookie（version+1）：原地热更凭据，项目缓存一并作废（新会话新项目）
      entry.sig = sig;
      entry.account = new GensparkAccount({ accountKey: key, cookie, cfg: this.cfg, log: this.log });
      this.log(`  [gs#${key}] cookie 已更新（v+1），执行会话重开`);
    }
    return entry.account;
  }

  /** 控制台已删账号的内存清理（与 aistudio 的 reconcile 同思路，无磁盘要清）。 */
  reconcile(validKeys) {
    const keep = new Set(validKeys.map(String));
    for (const key of [...this.accounts.keys()]) {
      if (!keep.has(key)) this.accounts.delete(key);
    }
  }

  status() {
    return {
      enabled: Boolean(this.cfg.gensparkEnabled),
      accounts: [...this.accounts.entries()].map(([key, e]) => ({
        key,
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
  MODELS,
  SIZES,
};
