#!/usr/bin/env node
/**
 * 人工首登 Outlook（2026-10-14 用户口径：接码平台通道已砍，OTP 读码只走
 * 本机 Outlook profile 会话；邮箱**首次**登录由人工在 VPS 上完成一次）。
 *
 * 用法（SSH 到节点后）：
 *   node tools/manual_mail_login.js <邮箱>
 *
 * 行为：在 Xvfb :98（noVNC 可视化入口，浏览器打开 http://<节点IP>:6080/vnc.html）
 * 用与自动接码**完全相同**的 profile 目录（data/mail-profiles/<邮箱前缀>）拉起
 * Chromium 并打开 Outlook 登录页。人工在 noVNC 里完成登录（含微软二次验证、
 * 「保持登录状态」选是），窗口保持不关即可 —— 之后节点读码走同一 profile，全自动。
 *
 * 注意：跑之前确保该邮箱没有正在进行/残留的自动登录浏览器（tt-login 会话），
 * 否则 profile 会被锁。登录完成后可直接关闭浏览器窗口（profile 已落盘）。
 */
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('用法: node tools/manual_mail_login.js <邮箱>   例如 node tools/manual_mail_login.js someone@outlook.com');
  process.exit(1);
}
const local = email.split('@')[0];
const profile = path.join('/opt/rhnode/data/mail-profiles', local);

(async () => {
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1340, height: 860 },
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1340,860'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://outlook.live.com/').catch(() => {});
  console.log('[manual-mail-login] 浏览器已打开（profile=' + profile + '）');
  console.log('[manual-mail-login] 请在 noVNC（http://<节点IP>:6080/vnc.html）里完成登录：');
  console.log('[manual-mail-login]   · 微软若弹「验证身份」二次验证 → 人工通过');
  console.log('[manual-mail-login]   · 「保持登录状态？」→ 选「是」');
  console.log('[manual-mail-login] 登录完成后可直接关闭浏览器；此后节点自动读码走该 profile。');
  // 不自动退出：人工登录期间保持窗口。登录完成后 Ctrl+C 或关窗即可（profile 已落盘）。
  await new Promise(() => {});
})().catch((e) => {
  console.error('[manual-mail-login] 启动失败：' + e.message);
  process.exit(1);
});
