'use strict';
/**
 * 上游探活打桩 —— **仅供离线自测使用**，用 `node -r` 预加载。
 *
 *     node -r ./selftest/probe-stub.js index.js
 *
 * 为什么需要它
 * ------------
 * 会话链路一旦升级为「启动时向号池取凭据 → 立刻验活 → 回报结论」，
 * 离线自测就绕不开一个矛盾：**验活本身是对 ads.tiktok.com 发真请求**。
 * 而自测的全部意义就是「不联网、不消耗额度、可重放」。
 *
 * 做法：把 `lib/tiktok.js` 的 `probeSession` 换成一个按环境变量返回预定结论的
 * 函数。**只替换这一个函数**，编排逻辑（谁来调、拿到结论做什么）仍跑真代码 ——
 * 这正是我们要测的部分。
 *
 * `SELFTEST_PROBE`：
 *   alive（默认）→ `{alive:true, code:0}`
 *   dead         → `{alive:false, code:10001106, message:'Login Required'}`
 *   error        → 抛错（模拟网络不通，用于验证「网络问题不得被当成凭据失效」）
 */
const path = require('node:path');

const tiktokPath = path.resolve(__dirname, '..', 'lib', 'tiktok.js');
const tiktok = require(tiktokPath);

const MODE = String(process.env.SELFTEST_PROBE || 'alive').toLowerCase();

tiktok.probeSession = async () => {
  if (MODE === 'error') {
    throw new Error('selftest：探活请求失败（模拟网络不通）');
  }
  if (MODE === 'dead') {
    return { alive: false, code: 10001106, status: 200, message: 'Login Required' };
  }
  return { alive: true, code: 0, status: 200, message: '' };
};

// 打桩是自测设施，不该悄悄影响别的东西 —— 打印一行让日志里看得见
process.stdout.write(`[selftest] 已打桩 probeSession（SELFTEST_PROBE=${MODE}）\n`);
