'use strict';
/**
 * 失败分类 —— 把「上游为什么拒了」压成机器可判、人可读的一个标签。
 *
 * 为什么需要它
 * ------------
 * 改造之前，所有失败在号池里都长成同一个 `FAILED` + 一段上游英文原文：
 *
 *     Error: 上游生成失败 [10043300] This content may violate our Community Guidelines.
 *
 * 于是**三种性质完全不同的失败在控制台上无法区分**：
 *
 *   - 内容不合规     —— 换素材/改提示词才有用，**同输入重发必然再失败**（钱照扣）
 *   - 会话过期       —— 换一份 cookie 能救，但要**重新发起**这条任务
 *   - 节点心跳超时   —— 纯粹是节点掉线，重发有意义
 *
 * 运营看到红色只知道「挂了」，不知道该重发还是该换素材；更糟的是
 * 「重发一次试试」在这种场景下**每次都真的烧掉一次上游额度**（5 积分/次）。
 *
 * 所以分类的目的不是好看，是**给出「值不值得重发」的判据**。
 *
 * 边界：本模块只做归类，**不做任何重试**。
 * 全项目唯一允许重试的位置是 `sessionruntime.withSubmitRetry`（只在提交阶段、
 * 只认 10001106、且号池那份凭据必须已经换过）。
 * 轮询阶段绝不重新提交 —— 那时上游已经建单，重提 = 建第二单 = 白烧一次额度。
 *
 * 只依赖 `node:*`，不联网、不读 env，好测。
 */

/** 失败类别。字符串值会**原样回报给号池并落库**，改名等于改协议。 */
const KIND = {
  /** 内容策略/社区规范/版权（含音频）拦下 —— 终态，同输入重发必再失败 */
  CONTENT_MODERATION: 'CONTENT_MODERATION',
  /** 会话失效（10001106 Login Required）—— 换 cookie 可救，任务需重新发起 */
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  /** 本地轮询超时 —— 上游可能还在跑，重发有意义 */
  TIMEOUT: 'TIMEOUT',
  /** 调用方主动取消（号池已进终态）—— 不是故障，别报成失败原因 */
  CANCELLED: 'CANCELLED',
  /** 账号额度/并发用尽 —— 等额度重置或换号后有意义 */
  QUOTA: 'QUOTA',
  /** 参数/入参不合法 —— 换哪个号都一样 */
  PARAM: 'PARAM',
  /** 上游 5xx、网关抖动、传输层错误 —— 稍后重发有意义 */
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  /** 认不出来 —— 保守放行人工重试，但别指望自动重试 */
  UNKNOWN: 'UNKNOWN',
};

/**
 * 内容策略类错误码。
 *
 * `10043300` 是本项目实测撞到的那个：上游文案是
 * `OutputAudioSensitiveContentDetected.PolicyViolation`（输出音频可能含版权），
 * 界面上显示成「This content may violate our Community Guidelines」。
 * ⚠️ API 文档曾写「随机命中、同参数重跑就过」——**实测不成立**：
 *    同一张抽象几何图连跑两次都挂，换真实照片 + 改 prompt 一次就过。
 *    所以它必须当**确定性终态**处理，不能「重跑碰运气」。
 * 同段号预留邻居（上游会扩），按区间收比逐个枚举稳。
 */
const CONTENT_CODE_PREFIX = '1004330';

/** 文案兜底：上游换码值时靠措辞也能认出来（**全小写比对**）。 */
const CONTENT_HINTS = [
  'policyviolation', 'policy violation',
  'sensitivecontent', 'sensitive content',
  'communityguideline', 'community guideline',
  'violate', 'violates', 'moderation', 'moderated',
  'content policy', 'copyright', 'infringe',
  // 中文兜底：上游偶尔直接回中文文案
  '侵权', '违规', '敏感', '社区规范', '内容政策', '不合规', '内容安全',
];

/** 会话失效 */
const SESSION_CODE = '10001106';
const SESSION_HINTS = ['login required', 'not login', 'session expired', '重新登录'];

/** 额度 / 并发 */
const QUOTA_HINTS = [
  'insufficient', 'quota', 'credit', 'exceed', 'limit reached', 'too many',
  'rate limit', 'concurrency', '额度', '并发', '限流', '积分不足',
];

/** 参数类（换号也一样） */
const PARAM_HINTS = [
  'invalid parameter', 'invalid_param', 'missing parameter', 'required',
  'not supported', 'unsupported', '参数', '不支持',
];

/**
 * 给一个错误挂上「上游给的信息」。
 *
 * ⚠️ 这个函数**真代码与自测桩共用**（`selftest/fake-tiktok.js` 也 require 它）。
 *    理由：桩如果自己拼一遍键名，很容易少一个键或拼错，而自测照样全绿 ——
 *    于是「测试通过、真代码已坏」。共用构造器之后，桩最多只能把措辞写错，
 *    形状不可能漂。
 */
function tagUpstream(err, code, message) {
  err.upstreamCode = (code === undefined || code === null) ? '' : String(code);
  if (message !== undefined && message !== null && message !== '') {
    err.upstreamMessage = String(message).slice(0, 400);
  }
  err.fromUpstream = true;
  return err;
}

/**
 * 造一个「上游终态拒绝」的错误 —— 码与原文分开挂，供本模块归类。
 *
 * 码拼进 message 只是为了让日志可读；分类**不许**去正则抠 message（码是硬事实）。
 */
function upstreamFailure(code, message) {
  const c = (code === undefined || code === null) ? '' : String(code);
  const m = (message === undefined || message === null || message === '') ? '上游未给出原因' : String(message);
  return tagUpstream(new Error(`上游生成失败 [${c}] ${m}`.slice(0, 500)), c, m);
}

/** 取出「上游给的那个码」。
 *
 * 优先 `upstreamCode`（我们抛结构化错误时自己挂的），退到 `code`
 * （探活/采集接口那种 `res.code` 的形状）。取不到就返回空串 —— 让调用方
 * 能区分「码是 0」与「压根没有码」，别用 `|| ''` 把 0 吞掉。
 */
function codeOf(err) {
  if (!err) return '';
  const raw = (err.upstreamCode !== undefined && err.upstreamCode !== null
    && err.upstreamCode !== '') ? err.upstreamCode : err.code;
  if (raw === undefined || raw === null || raw === '') return '';
  return String(raw);
}

/** 把错误身上所有可读文本拼成一个小写串，供关键词匹配。 */
function textOf(err) {
  if (!err) return '';
  return [err.upstreamMessage, err.message]
    .filter((s) => typeof s === 'string' && s)
    .join(' ')
    .toLowerCase();
}

/**
 * 每个 kind 对应的「同样的输入再发一次有没有意义」。
 *
 * ⚠️ 这是**唯一真相源**：`classify()` 的每个分支不再自己写 retryable，
 *    而是让 `build()` 从这里取。否则将来加分支时很容易出现
 *    「classify 说能重发、localFailure 说不能」这种同一 kind 两种结论的分裂。
 */
const RETRYABLE = {
  [KIND.CONTENT_MODERATION]: false,
  [KIND.SESSION_EXPIRED]: false,
  [KIND.TIMEOUT]: true,
  [KIND.CANCELLED]: false,
  [KIND.QUOTA]: true,
  [KIND.PARAM]: false,
  [KIND.UPSTREAM_ERROR]: true,
  [KIND.UNKNOWN]: true,
};

function build(kind, { code = '', retryable, note = '' } = {}) {
  const fallback = Object.prototype.hasOwnProperty.call(RETRYABLE, kind)
    ? RETRYABLE[kind] : RETRYABLE[KIND.UNKNOWN];
  return { kind, code, retryable: retryable === undefined ? fallback : retryable, note };
}

/** 该 kind 是否值得用**同样的输入**再发一次。 */
function retryableOf(kind) {
  return Object.prototype.hasOwnProperty.call(RETRYABLE, kind)
    ? RETRYABLE[kind] : RETRYABLE[KIND.UNKNOWN];
}

/**
 * 造一个「本地就判死」的失败载荷 —— 不经上游、也不该被当成上游抖动。
 *
 * 存在的理由：`executeTask` 里有几处**不进 catch 的提前 return**（缺参考图、
 * 缺 agent.model_id）。改造时只把 catch 分支接进了 `outcomeOf`，那几处直接
 * `return { ok:false, error }` —— 于是它们在号池里仍然落成
 * 「FAILED 但 error_kind 为空」，正是本次改造要消灭的那种「分不清」。
 * （2026-09-20 由一次零成本探针任务当场撞出来。）
 *
 * 载荷形状与 `outcomeOf` 严格一致：调用方拿到的对象不该有两种长相。
 */
function localFailure(kind, message, extra = {}) {
  const k = Object.prototype.hasOwnProperty.call(RETRYABLE, kind) ? kind : KIND.UNKNOWN;
  const out = {
    ok: false,
    cancelled: k === KIND.CANCELLED,
    error: String(message === undefined || message === null || message === ''
      ? '未给出失败原因' : message).slice(0, 500),
    error_code: extra.code === undefined || extra.code === null ? '' : String(extra.code),
    error_kind: k,
    retryable: extra.retryable === undefined ? retryableOf(k) : Boolean(extra.retryable),
  };
  if (extra.remoteTaskId) out.remote_task_id = String(extra.remoteTaskId);
  return out;
}

/**
 * 分类一个错误。
 *
 * @param {Error|object} err
 * @returns {{kind:string, code:string, retryable:boolean, note:string}}
 *   `retryable` 的含义是「**同样的输入再发一次有没有意义**」，
 *   不是「系统会不会自动重试」（系统在任何情况下都不会自动重发同一条任务）。
 */
function classify(err) {
  if (!err) return build(KIND.UNKNOWN);

  // 取消优先：调用方已经自己把任务标成终态，这不是故障。
  if (err.cancelled) return build(KIND.CANCELLED);

  const code = codeOf(err);
  const text = textOf(err);

  // ① 会话失效 —— 码是硬的，先认
  if (code === SESSION_CODE || SESSION_HINTS.some((h) => text.includes(h))) {
    return build(KIND.SESSION_EXPIRED, { code });
  }

  // ② 内容策略 —— 码前缀或措辞命中任一即算
  if (code.startsWith(CONTENT_CODE_PREFIX) || CONTENT_HINTS.some((h) => text.includes(h))) {
    return build(KIND.CONTENT_MODERATION, { code });
  }

  // ③ 本地自己判的超时（上游还在跑，重发有意义）
  if (err.localTimeout) return build(KIND.TIMEOUT, { code });

  // ④ 额度/并发
  if (QUOTA_HINTS.some((h) => text.includes(h))) {
    return build(KIND.QUOTA, { code });
  }

  // ⑤ 参数类
  if (PARAM_HINTS.some((h) => text.includes(h))) {
    return build(KIND.PARAM, { code });
  }

  // ⑥ 明确的传输层/上游抖动
  if (err.transient || /HTTP 5\d\d|ECONNRESET|ETIMEDOUT|socket hang up/.test(String(err.message || ''))) {
    return build(KIND.UPSTREAM_ERROR, { code });
  }

  return build(KIND.UNKNOWN, { code });
}

/**
 * 给**控制台**用的中文一句话结论。
 *
 * ⚠️ 界面上要把这个和「这条不要急着重发」的结论一起显示 ——
 * 光把英文原文翻成中文没有意义，运营需要的是**下一步该做什么**。
 */
const LABEL = {
  [KIND.CONTENT_MODERATION]: {
    label: '内容不合规',
    advice: '上游按社区规范/版权拒收。**同样的素材与提示词重发会被同样拒绝，且每次都照扣额度**'
      + ' —— 请更换参考图或改写提示词后重新发起。',
  },
  [KIND.SESSION_EXPIRED]: {
    label: '会话已失效',
    advice: 'cookie 过期（广告线 TTL 只有 3 天）。到控制台换一份新凭据，'
      + '然后**重新发起**这条任务。',
  },
  [KIND.TIMEOUT]: {
    label: '轮询超时',
    advice: '本地等不到终态就放弃了，上游可能仍在生成。可以先等一下再重新发起。',
  },
  [KIND.CANCELLED]: {
    label: '已取消',
    advice: '调用方主动取消，不是故障。',
  },
  [KIND.QUOTA]: {
    label: '额度/并发用尽',
    advice: '账号额度或并发槽位不够，等额度重置（UTC 00:00）或加号后重发。',
  },
  [KIND.PARAM]: {
    label: '参数不合法',
    // 措辞**不能**写死「按上游原文修正」：本地入参校验（缺参考图、缺
    // agent.model_id）也会归到这一类，那时根本没有上游原文可看。
    advice: '换哪个账号都一样，先按失败原因修正入参后重新发起。',
  },
  [KIND.UPSTREAM_ERROR]: {
    label: '上游抖动',
    advice: '服务端或链路临时故障，稍后重发通常能过。',
  },
  [KIND.UNKNOWN]: {
    label: '未归类失败',
    advice: '先看上游原文与节点日志再决定是否重发。',
  },
};

function describe(kind) {
  return LABEL[kind] || LABEL[KIND.UNKNOWN];
}

/**
 * 把错误组装成 `POST /api/v1/agent/result` 的**失败分支载荷**。
 *
 * 落库的 `error` 刻意保留**上游技术原文**（排查要靠它），中文结论由
 * `error_kind` 在展示层渲染 —— 号池该存事实，不该存措辞。这样将来改文案
 * 不必碰历史数据，网站侧也能按 kind 自己决定给用户看什么。
 *
 * `remote_task_id` 只要拿得到就一定带上：走到失败说明**上游很可能已经建单、
 * 额度已经扣了**，没有这个号就既不能对账也不能申诉。
 */
function outcomeOf(err) {
  const f = classify(err);
  // 只给非普通 Error 留类型前缀。改造前一律拼 `${err.name || 'Error'}: `，
  // 于是每条失败都带着一个毫无信息量的 `Error: ` 头，还白占 500 字上限。
  const name = err && err.name && err.name !== 'Error' ? `${err.name}: ` : '';
  const raw = name + String((err && err.message) || err || '未给出失败原因');
  const out = {
    ok: false,
    cancelled: f.kind === KIND.CANCELLED,
    error: raw.slice(0, 500),
    error_code: f.code,
    error_kind: f.kind,
    retryable: f.retryable,
  };
  if (err && err.remoteTaskId) out.remote_task_id = String(err.remoteTaskId);
  return out;
}

module.exports = {
  KIND, classify, describe, outcomeOf, localFailure, retryableOf,
  tagUpstream, upstreamFailure, LABEL,
};
