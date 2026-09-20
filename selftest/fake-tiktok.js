'use strict';
/**
 * 自测用的假 TikTok 上游 —— **只替换 I/O，不替换编排**。
 *
 * 真上游每次调用都烧账号额度且不可重放，所以这里按真契约回放：
 *   · `poll` 每 tick 调一次 `onTick`，并在它返回 `{stop:true}` 时抛出
 *     带 `.cancelled = true` 的错误（真实现见 `lib/tiktok.js`）；
 *   · `RH_SELFTEST_UPSTREAM_FAIL` = base64(`{code,message}`) 时，`poll` 直接抛
 *     **上游终态拒绝** —— 错误对象用 `lib/failure.js` 的 `upstreamFailure()`
 *     构造，与真代码同一个函数，所以形状不可能漂（措辞可能不同，形状不会）；
 *   · `submit` 返回一个 TikTok 侧任务号，用于验证**它没有被当成交付标识**；
 *   · `download` 默认回一片普通大小的字节，`RH_SELFTEST_OVERSIZE=1` 时回超限体积。
 */
const { cfg } = require('../lib/config');
const failure = require('../lib/failure');

const RESULT = JSON.parse(Buffer.from(process.env.RH_SELFTEST_RESULT || 'e30=', 'base64').toString('utf8'));
const OVERSIZE = process.env.RH_SELFTEST_OVERSIZE === '1';

/** 上游终态拒绝：`{code, message}`。空/缺失 = 不启用。 */
const UPSTREAM_FAIL = (() => {
  const raw = process.env.RH_SELFTEST_UPSTREAM_FAIL || '';
  if (!raw) return null;
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { return null; }
})();

let ticks = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeSession() {
  return { alive: true, code: 0, message: '' };
}

async function submit() {
  return { taskId: RESULT.taskId, draftId: 'draft-1', draftInfo: {}, raw: {} };
}

/**
 * 按真契约轮询：每 tick 调 onTick，见 `{stop:true}` 就抛 `.cancelled`。
 * 默认最多跑 400 tick（约 20 秒）—— 自测里正常出片会在第 3 tick 返回。
 */
async function poll(session, _cfg, taskId, opts = {}) {
  const { onTick = null, intervalMs = 8000, log = null } = opts;
  // 自测要把节奏压快：真环境是 8s 一轮，这里 50ms 一轮
  const step = Math.min(intervalMs, 50);

  // 上游终态拒绝：走一遍 onTick（让取消检测/心跳照常发生），然后抛。
  // 用真代码同一个构造器 —— 这个自测要验的正是「抛出物被如何归类与回报」。
  if (UPSTREAM_FAIL) {
    for (let i = 0; i < 2; i += 1) {
      ticks += 1;
      if (onTick) {
        const verdict = onTick(Math.min(95, 5 + ticks));
        if (verdict && verdict.stop) {
          const err = new Error('任务已被调用方取消（号池侧已进终态）');
          err.cancelled = true;
          throw err;
        }
      }
      await sleep(step);
    }
    if (log) log(`  [fake] 上游终态拒绝 code=${UPSTREAM_FAIL.code}`);
    throw failure.upstreamFailure(UPSTREAM_FAIL.code, UPSTREAM_FAIL.message);
  }

  for (let i = 0; i < 400; i += 1) {
    ticks += 1;
    if (onTick) {
      const verdict = onTick(Math.min(95, 5 + ticks));
      if (verdict && verdict.stop) {
        const err = new Error('任务已被调用方取消（号池侧已进终态）');
        err.cancelled = true;
        throw err;
      }
    }
    await sleep(step);
    if (ticks >= 3) break;         // 第 3 tick 起「出片」，模拟真实轮询
  }
  if (log) log(`  [fake] 出片（${ticks} tick）`);
  return Object.assign({}, RESULT);
}

async function download() {
  const size = OVERSIZE ? 30 * 1024 * 1024 : 1500000;
  return Buffer.alloc(size, 7);
}

module.exports = { probeSession, submit, poll, download, sleep, selectBest: () => null };
