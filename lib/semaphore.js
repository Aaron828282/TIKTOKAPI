'use strict';
/**
 * FIFO 计数信号量 —— 通用并发闸（2026-10-14 用户口径）。
 *
 * 为什么需要它
 * ------------
 * TikTok 领单不设上限（100-200 条并发任务正常接），但每条任务在最后的
 * 「下载成片+转存」窗口会把整个成片缓冲进节点内存（上限 ~24MB/条）。
 * 极端场景下几十条任务同时挤进下载窗口 = GB 级瞬时内存峰值。
 *
 * 对策：下载窗口整体套一个全局信号量（默认 10 槽）——
 *   · 先完成任务先到 acquire，先占槽（FIFO 队列天然保证「按生成完成
 *     时间先后依次下载」）；
 *   · 同时完成的任务在队列里按到达顺序竞争，谁排前面谁先上（等效
 *     「随机竞争」，且无饥饿：FIFO 不插队）；
 *   · 排队的任务只是等一个 Promise，内存占用约等于零 —— 闸本身不产生
 *     新的内存压力。
 *
 * 刻意零依赖、不联网、不读 env（配置在 config.js 做好传进来）。
 */
class Semaphore {
  /**
   * @param {number} slots 总槽位数（>=1）
   */
  constructor(slots) {
    const n = Math.max(1, Math.trunc(Number(slots) || 1));
    this.slots = n;
    this.free = n;
    this.queue = [];       // 等待者的 resolve 函数，FIFO
    this.waiting = 0;      // 当前排队数（观测用）
    this.acquired = 0;     // 历史累计发出去的槽次数（观测用）
  }

  /** 占一个槽；没槽就按到达顺序排队（resolve 后即持有槽，无需再判）。 */
  async acquire() {
    if (this.free > 0) {
      this.free -= 1;
      this.acquired += 1;
      return;
    }
    this.waiting += 1;
    try {
      await new Promise((resolve) => this.queue.push(resolve));
    } finally {
      this.waiting -= 1;
    }
    // release() 直接把槽移交给队首（不经过 free），这里不用再扣计数。
    this.acquired += 1;
  }

  /** 还一个槽；队首等待者直接继承，否则归还池子。 */
  release() {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.free = Math.min(this.slots, this.free + 1);
  }

  /** 一行观测摘要：占用/总数 + 排队数。 */
  view() {
    return `${this.slots - this.free}/${this.slots}`
      + (this.waiting ? `（排队 ${this.waiting}）` : '');
  }
}

module.exports = { Semaphore };
