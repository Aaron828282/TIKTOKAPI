'use strict';
/**
 * 失败分类自测 —— 不联网、不消耗任何额度。
 *
 * 为什么要专门测这个：
 * 「内容不合规」与「会话过期」「节点掉线」在改造前**在控制台上长得一模一样**，
 * 而处置方式完全相反 —— 前者重发必再失败且每次都照扣上游额度（5 积分/次），
 * 后者换了 cookie 重发才是正解。分类判错的代价是**真金白银 + 运营被误导**，
 * 所以关键词表、码前缀、优先级顺序都必须钉死。
 *
 * 用法（在本目录下）：
 *   node selftest/failure.js
 */
const fs = require('node:fs');
const path = require('node:path');

const failure = require('../lib/failure');

let pass = 0;
let fail = 0;
function check(label, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${extra ? ' —— ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? ' —— ' + extra : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

/** 造一个「上游拒了」的错误，形状与 lib/tiktok.js 抛的完全一致。 */
function upstream(code, message) {
  const e = new Error(`上游生成失败 [${code}] ${message}`);
  e.upstreamCode = String(code);
  e.upstreamMessage = String(message);
  e.fromUpstream = true;
  return e;
}

const K = failure.KIND;

// ---------------------------------------------------------------------------
section('A1 · 内容策略类（本项目实测撞到的那个码）');

// 2026-09-20 实跑真实撞到的原文，一字不差。
const realMsg = 'This content may violate our Community Guidelines. Try generating again.';
const r1 = failure.classify(upstream(10043300, realMsg));
check('10043300 + 社区规范文案 → CONTENT_MODERATION', r1.kind === K.CONTENT_MODERATION, r1.kind);
check('标记为不可重发', r1.retryable === false, String(r1.retryable));
check('原样带回错误码', r1.code === '10043300', r1.code);

const r2 = failure.classify(upstream(10043300, 'OutputAudioSensitiveContentDetected.PolicyViolation'));
check('音频版权措辞同样归类', r2.kind === K.CONTENT_MODERATION, r2.kind);

const r3 = failure.classify(upstream(10043307, 'something brand new'));
check('同段号邻居（上游会扩码）也认', r3.kind === K.CONTENT_MODERATION, r3.code);

const r4 = failure.classify(new Error('blocked: this request was moderated'));
check('只有措辞没有码时也能认（moderated）', r4.kind === K.CONTENT_MODERATION, r4.kind);

const r5 = failure.classify(upstream('', '内容涉嫌侵权，已被拦截'));
check('纯中文措辞兜底', r5.kind === K.CONTENT_MODERATION, r5.kind);

// ---------------------------------------------------------------------------
section('A2 · 会话失效（可救，但要重新发起，不是本任务内重试）');

const r6 = failure.classify(upstream(10001106, 'Login Required'));
check('10001106 → SESSION_EXPIRED', r6.kind === K.SESSION_EXPIRED, r6.kind);
check('任务级不可复用（需重新发起）', r6.retryable === false, String(r6.retryable));

// 轮询期那条合成错误（index.js 新造的 e）必须仍能归类 —— 它把任务号带过来了。
const synth = new Error('会话在轮询期间失效（10001106 Login Required）—— 需要刷新 cookie'
  + ' —— 上游任务已建单，未重新提交（避免重复消耗）。请到号池控制台换一份会话凭据，这条订单需要重新发起');
synth.upstreamCode = '10001106';
check('轮询期合成错误仍归类为 SESSION_EXPIRED',
  failure.classify(synth).kind === K.SESSION_EXPIRED);

// ---------------------------------------------------------------------------
section('A3 · 其余类别与优先级');

const r7 = failure.classify(Object.assign(new Error('任务已被调用方取消'), { cancelled: true }));
check('cancelled 优先于一切 → CANCELLED', r7.kind === K.CANCELLED, r7.kind);
check('取消不算「可重发」', r7.retryable === false);

const r8 = failure.classify(Object.assign(new Error('本地轮询超时（>1800s）'), { localTimeout: true }));
check('本地超时 → TIMEOUT 且可重发', r8.kind === K.TIMEOUT && r8.retryable === true, r8.kind);

const r9 = failure.classify(new Error('insufficient quota for this account'));
check('额度用尽 → QUOTA', r9.kind === K.QUOTA, r9.kind);

const r10 = failure.classify(new Error('invalid parameter: duration'));
check('入参不合法 → PARAM 且不可重发',
  r10.kind === K.PARAM && r10.retryable === false, r10.kind);

const r11 = failure.classify(new Error('建单失败：HTTP 502 code=undefined'));
check('上游 5xx → UPSTREAM_ERROR 可重发',
  r11.kind === K.UPSTREAM_ERROR && r11.retryable === true, r11.kind);

const r12 = failure.classify(new Error('完全没见过的一种炸法'));
check('认不出来 → UNKNOWN（不谎报成内容问题）', r12.kind === K.UNKNOWN, r12.kind);

const r13 = failure.classify(null);
check('null 不抛异常', r13.kind === K.UNKNOWN, r13.kind);

// 优先级：内容文案里如果同时出现「limit」之类的词，不能被 QUOTA 抢走 ——
// 顺序错了会把「换素材」误判成「等额度重置」。
const r14 = failure.classify(upstream(10043300, 'policy violation: rate limit exceeded'));
check('内容类优先级高于额度类', r14.kind === K.CONTENT_MODERATION, r14.kind);

// ---------------------------------------------------------------------------
section('A4 · outcomeOf 组装的回报载荷（这个是发给号池的契约）');

const err = upstream(10043300, realMsg);
err.remoteTaskId = '768752408852250497';          // 截图里那个上游任务号
const out = failure.outcomeOf(err);
check('ok=false', out.ok === false);
check('带 error_code', out.error_code === '10043300', out.error_code);
check('带 error_kind', out.error_kind === K.CONTENT_MODERATION, out.error_kind);
check('带 retryable=false', out.retryable === false, String(out.retryable));
check('失败也带 remote_task_id', out.remote_task_id === '768752408852250497', out.remote_task_id);
check('error 保留上游原文（排查用）', out.error.includes('Community Guidelines'));
check('error 不再有 "Error: " 噪音前缀', !out.error.startsWith('Error: '), out.error.slice(0, 24));

const noRemote = failure.outcomeOf(upstream(10043300, 'x'));
check('拿不到上游任务号时**不编**一个', !('remote_task_id' in noRemote));

const named = Object.assign(new TypeError('某处类型错'), { name: 'TypeError' });
check('非普通 Error 保留类型前缀', failure.outcomeOf(named).error.startsWith('TypeError: '),
  failure.outcomeOf(named).error.slice(0, 20));

// 契约：kind 字符串要**原样落库并跨语言比对**，改名等于悄悄改协议。
check('CONTENT_MODERATION 字面量锁死', K.CONTENT_MODERATION === 'CONTENT_MODERATION');
check('SESSION_EXPIRED 字面量锁死', K.SESSION_EXPIRED === 'SESSION_EXPIRED');

const d = failure.describe(K.CONTENT_MODERATION);
check('中文标签可用', d.label === '内容不合规', d.label);
check('给了「别急着重发」的明确指引', /重发会被同样拒绝/.test(d.advice));

// ---------------------------------------------------------------------------
section('A5 · 源码级断言：不重试这条线没有被改坏');

const root = path.join(__dirname, '..');
const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const tk = fs.readFileSync(path.join(root, 'lib', 'tiktok.js'), 'utf8');

check('主循环用 failure.outcomeOf 组装失败载荷', idx.includes('failure.outcomeOf(err)'));
check('不可重发的失败会显式告警（防运营盲重发）',
  idx.includes('outcome.retryable === false'));
check('轮询的 catch 会补挂 remoteTaskId', idx.includes('err.remoteTaskId = submitted.taskId'));
check('轮询期会话失效的合成错误把任务号带过去',
  idx.includes('e.remoteTaskId = err.remoteTaskId'));
// B1 会用真代码把「抛出的对象里到底有没有 upstreamCode」跑出来，
// 这里只守住「用的是共用构造器」——自己拼键名迟早会漂。
check('上游终态失败走共用构造器 upstreamFailure',
  tk.includes('failure.upstreamFailure('));
check('draftTaskStatus=3 仍立刻抛错（不许继续轮询）',
  tk.includes('Number(me.draftTaskStatus) === 3'));

// 全项目唯一允许重试的位置仍然是 withSubmitRetry，且必须在 poll 之前。
const pollAt = idx.indexOf('await tiktok.poll(');
const retryAt = idx.indexOf('sessionruntime.withSubmitRetry(');
check('withSubmitRetry 仍在 poll 之前（只在提交阶段生效）',
  retryAt > 0 && retryAt < pollAt, `${retryAt} < ${pollAt}`);
check('轮询期仍明确写着「不重新提交」', idx.includes('不重新提交'));

// ---------------------------------------------------------------------------
section('B1 · 真解析代码：poll 见到 draftTaskStatus=3 时到底抛了什么');

// A5 是源码级断言，只能证明「代码里写了」；这一段把**真的 `tiktok.poll`** 跑起来，
// 用假 fetch 喂一份上游 history 响应。理由是失败分类的全部价值都压在
// 「真代码抛出的那个对象里有没有 upstreamCode」这一点上 —— 只靠自测桩证明不了它。
const tiktok = require('../lib/tiktok');

const SESSION = {
  cookie: 'sessionid_ads=x; csrftoken=y', device_id: 'd', user_agent: 'UA', x_fp_id: '',
};
const SELL_CFG = {
  origin: 'https://ads.example.test',
  referer: 'https://ads.example.test/studio',
  userAgent: 'UA',
};
/** 假 fetch：只实现 poll 会用到的那两个成员（status / text）。 */
const canned = (json, status = 200) => async () => ({
  status, text: async () => JSON.stringify(json),
});

const UPSTREAM_BODY = {
  code: 0,
  data: {
    draft_infos: [{
      taskId: 'T1',
      draftTaskStatus: 3,
      generateErrorCode: 10043300,
      generateErrorMessage: realMsg,
    }],
  },
};

(async () => {
  let realErr = null;
  try {
    await tiktok.poll(SESSION, SELL_CFG, 'T1', {
      fetchImpl: canned(UPSTREAM_BODY), timeoutMs: 3000, intervalMs: 1,
    });
  } catch (e) { realErr = e; }

  check('真代码确实抛错（不是静默继续轮询）', Boolean(realErr),
    String((realErr && realErr.message) || '').slice(0, 36));
  check('抛出物带 upstreamCode —— **不是靠正则去抠 message**',
    Boolean(realErr) && realErr.upstreamCode === '10043300',
    String(realErr && realErr.upstreamCode));
  check('抛出物带 upstreamMessage 原文',
    Boolean(realErr) && /Community Guidelines/.test(String(realErr.upstreamMessage)));
  check('真代码抛出的错误能被归成 CONTENT_MODERATION',
    Boolean(realErr) && failure.classify(realErr).kind === K.CONTENT_MODERATION);

  // 真代码抛出的错误 + 桩抛出的错误，走同一条组装路径必须得到同样的键集合。
  const realKeys = Object.keys(failure.outcomeOf(realErr)).sort().join(',');
  const stubKeys = Object.keys(failure.outcomeOf(upstream(10043300, realMsg))).sort().join(',');
  check('真代码与自测桩组装出的载荷键集合完全一致（桩不会漂）',
    realKeys === stubKeys, realKeys);

  // 轮询期会话失效那条真代码路径（10001106）
  let authErr = null;
  try {
    await tiktok.poll(SESSION, SELL_CFG, 'T1', {
      fetchImpl: canned({ code: 10001106, message: 'Login Required' }),
      timeoutMs: 3000, intervalMs: 1,
    });
  } catch (e) { authErr = e; }
  check('真代码 10001106 也带上了 upstreamCode',
    Boolean(authErr) && authErr.upstreamCode === '10001106',
    String(authErr && authErr.upstreamCode));
  check('并且能被归成 SESSION_EXPIRED',
    Boolean(authErr) && failure.classify(authErr).kind === K.SESSION_EXPIRED);

  const tf = fs.readFileSync(path.join(root, 'selftest', 'fake-tiktok.js'), 'utf8');
  check('自测桩复用同一个构造函数（形状不可能漂）',
    tf.includes('failure.upstreamFailure'));

  // -------------------------------------------------------------------------
  console.log(`\n${fail ? '✗' : '✓'} 失败分类：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
