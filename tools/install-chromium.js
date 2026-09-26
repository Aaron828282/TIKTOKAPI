'use strict';
/**
 * postinstall：尽力而为地安装 Chromium（AI Studio 生图执行面需要）。
 *
 * 为什么存在这个脚本而不是直接在 postinstall 里写
 *   `npx playwright install chromium`：
 *
 * 1. **下载失败绝不能拖垮整个构建** —— TikTok 视频链路是零浏览器纯 HTTP，
 *    Chromium 装不上只影响 AI Studio 生图。postinstall 非零退出 = npm ci 失败
 *    = 整个应用部署不了 = TikTok 节点也被连坐。所以这里**任何失败都只警告、
 *    恒定退出 0**，运行时没 Chromium 的症状是「aistudio 任务报未安装」，
 *    与 lib/aistudio.js 的 fail-closed 行为一致。
 * 2. TikTok 日常发版想跳过这步（快几分钟）：环境变量 RH_SKIP_CHROMIUM=1。
 *
 * 环境约束：构建环境多半没有 apt/sudo 权限，所以**不带 --with-deps**——
 * 系统 .so 缺不缺只能等运行时 launch 才知道，那正是部署实验要回答的问题。
 */

const { spawnSync } = require('node:child_process');

if (process.env.RH_SKIP_CHROMIUM === '1') {
  console.log('[install-chromium] RH_SKIP_CHROMIUM=1，跳过 Chromium 安装（TikTok 链路不需要它）');
  process.exit(0);
}

let npxCmd = 'npx';
if (process.platform === 'win32') npxCmd = 'npx.cmd';

const res = spawnSync(npxCmd, ['playwright', 'install', 'chromium'], {
  stdio: 'inherit',
  timeout: 10 * 60 * 1000,
  shell: process.platform === 'win32',
});

if (res.error || res.status !== 0) {
  console.warn('[install-chromium] Chromium 安装失败（不阻塞构建）：'
    + (res.error ? res.error.message : `exit ${res.status}`));
  console.warn('[install-chromium] 影响：AI Studio 生图不可用；TikTok 视频链路不受影响。');
  console.warn('[install-chromium] 手动补装：npx playwright install chromium');
  process.exit(0);
}

console.log('[install-chromium] Chromium 安装完成');
