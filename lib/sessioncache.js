'use strict';
/**
 * 运行时会话缓存 —— 按 backend 存「当前这一份」凭据。
 *
 * 为什么要有这么个东西
 * --------------------
 * 会话凭据的**持有者从节点搬到了号池**（控制台切换、节点按需索取）。
 * 但节点里读凭据的地方（`config.loadSession()`）是**同步**调用，散在
 * `executeTask` / 启动自检 / `/status` 里 —— 不可能为了拿 cookie 把整条
 * 调用链改成 async。
 *
 * 所以：拉取是异步的（`lib/sessionruntime.js` 定时做），落地是同步的（这里）。
 * `loadSession()` 只管读缓存，读到就用，读不到再回落到环境变量。
 *
 * 为什么按 backend 分槽
 * --------------------
 * 号池的 `/agent/session` 是**按 backend** 存的（`agent_sessions.backend` 是主键）。
 * 现在线上只有 `tiktok_r2v` 一个后端，但缓存按 key 分槽的成本是零 ——
 * 将来多一个后端时，不至于把 A 的 cookie 发给 B。
 *
 * 本模块**不读 env、不联网、不加密**：纯内存状态，好测。
 */

/** backend → { session, version, source, at, from } */
const slots = new Map();

/**
 * 写入一份凭据。
 *
 * `version` 是**号池侧的版本号**（由号池自增），不是本地计数器 ——
 * 节点拿它当 `since` 去问「变了没」，所以必须原样保存，不能自己编。
 *
 * `source`: 'pool' | 'env' | 'file' —— 出问题时第一个要看的就是这个字段。
 */
function set(backend, session, { version = 0, source = 'pool', from = '' } = {}) {
  const key = String(backend || '');
  if (!key) return null;
  const entry = {
    session,
    version: Number(version) || 0,
    source: String(source || ''),
    from: String(from || ''),
    at: Date.now(),
  };
  slots.set(key, entry);
  return entry;
}

/** 取一份凭据（快照，调用方改它不影响缓存）。没有就返回 `null`。 */
function get(backend) {
  const e = slots.get(String(backend || ''));
  return e ? e.session : null;
}

/** 元信息，**不含凭据本体** —— `/status` 与日志只准用这个。 */
function info(backend) {
  const e = slots.get(String(backend || ''));
  if (!e) return null;
  return { version: e.version, source: e.source, from: e.from, at: e.at };
}

function has(backend) {
  return slots.has(String(backend || ''));
}

/**
 * 拿掉一份凭据。
 *
 * 只在「号池明确说这份没配了 / 确实换了 key 且新的一份也拉不到」时调用。
 * ⚠️ **网络抖动不要调这个** —— 号池短暂不可达就把本地缓存清掉，等于
 *    自己把正在跑的任务的风控面扩大；保留旧凭据继续用，比空手强。
 */
function clear(backend) {
  return slots.delete(String(backend || ''));
}

function clearAll() {
  slots.clear();
}

/** 所有槽的元信息（观测用）。 */
function dump() {
  const out = {};
  for (const [k, v] of slots) {
    out[k] = { version: v.version, source: v.source, at: v.at };
  }
  return out;
}

module.exports = { set, get, info, has, clear, clearAll, dump };
