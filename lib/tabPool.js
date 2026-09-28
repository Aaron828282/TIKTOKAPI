'use strict';

/**
 * 全局浏览器 tab 信号量（2026-09-28）。
 *
 * 背景：KV-M2（2 vCPU / 7.8GB）同时承载 AI Studio 与 Genspark 两个浏览器
 * 执行面，用户口径：整机最多同时 8 个 tab，由两个执行器**共享**，按任务
 * 到达时间 FIFO 占用。TikTok r2v 是纯 HTTP 执行面不占 tab（其 cookie 续期
 * 自动登录是偶发短暂拉起，不计入常驻额度）。
 *
 * 语义：
 *   · tryAcquire()      —— 立即拿槽；队列非空或有任务在等时**不插队**返回 null；
 *   · acquire(label)    —— FIFO 排队等槽（按入队顺序发牌），返回 permit；
 *   · release(permit)   —— 归还槽位，只从队首发牌（严格 FIFO）；
 *   · canTakeNow        —— 供「领单前的排队闸」使用：有空闲槽且无人排队
 *                           才允许节点去号池领新单，避免领了单干等槽。
 *
 * permit 是不透明对象，必须原样传回 release()。重复 release 无害。
 */

class TabPool {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 8);
    this.active = 0;
    this.queue = [];   // [{ label, ts, resolve, reject, timer }]
  }

  /** 当前是否有空闲槽且无排队者（领单闸用）。 */
  get canTakeNow() {
    return this.queue.length === 0 && this.active < this.limit;
  }

  get inUse() { return this.active; }
  get waiting() { return this.queue.length; }

  /** 立即尝试拿一个槽；拿不到返回 null（不排队、不插队）。 */
  tryAcquire(label) {
    if (!this.canTakeNow) return null;
    this.active += 1;
    return { __tabPoolPermit: true, label: String(label || '') };
  }

  /**
   * 排队等一个槽（FIFO，按调用顺序发牌）。
   * timeoutMs 为 0/缺省 → 无限等；超时抛 Error('TAB_POOL_TIMEOUT')。
   */
  acquire(label, timeoutMs = 0) {
    const permit = this.tryAcquire(label);
    if (permit) return Promise.resolve(permit);
    return new Promise((resolve, reject) => {
      const w = { label: String(label || ''), ts: Date.now(), resolve, reject, timer: null };
      if (timeoutMs > 0) {
        w.timer = setTimeout(() => {
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          const e = new Error(`全局 tab 池排队超时（>${Math.round(timeoutMs / 1000)}s，`
            + `活跃 ${this.active}/${this.limit}，排队 ${this.queue.length}）`);
          e.errorKind = 'UPSTREAM_ERROR';
          reject(e);
        }, timeoutMs);
      }
      this.queue.push(w);
    });
  }

  /** 归还槽位；队首等待者按 FIFO 立即接棒。 */
  release(permit) {
    if (!permit || !permit.__tabPoolPermit || permit.done) return;
    permit.done = true;
    this.active -= 1;
    while (this.queue.length && this.active < this.limit) {
      const w = this.queue.shift();
      if (w.timer) clearTimeout(w.timer);
      this.active += 1;
      w.resolve({ __tabPoolPermit: true, label: w.label });
    }
  }

  status() {
    return { limit: this.limit, active: this.active, waiting: this.queue.length };
  }
}

module.exports = { TabPool };
