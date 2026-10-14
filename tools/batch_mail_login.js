#!/usr/bin/env node
/**
 * 批量人工首登 Outlook（2026-10-14 用户口径：接码平台通道已砍，OTP 读码只走
 * 本机 Outlook profile 会话；邮箱**首次**登录由人工在 VPS 上完成一次）。
 *
 * 用法（SSH 到节点后，DISPLAY=:98）：
 *   node tools/batch_mail_login.js            # 读 data/mail-list.json
 *   MAIL_LIST=data/xxx.json node tools/batch_mail_login.js
 *   MAIL_CONCURRENCY=4 node tools/batch_mail_login.js
 *
 * 行为：
 *   · 从清单逐个取邮箱，在 Xvfb :98 桌面用与自动读码**完全相同**的 profile
 *     目录（data/mail-profiles/<邮箱前缀>）拉起 Chromium 打开 Outlook 登录页；
 *   · 同屏最多 MAIL_CONCURRENCY（默认 4）个窗口，2×2 网格排布（1440x900 桌面）；
 *   · 人工在 noVNC（http://<节点IP>:6080/vnc.html）里完成登录（微软二次验证
 *     人工通过、「保持登录状态」选是），**关闭该窗口即视为完成**，槽位立刻
 *     自动弹出清单里的下一个邮箱；
 *   · 全部跑完输出汇总（成功/失败清单），profile 均已落盘，节点读码全自动。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LIST_FILE = process.env.MAIL_LIST || path.join('data', 'mail-list.json');
const CONCURRENCY = Math.max(1, Number(process.env.MAIL_CONCURRENCY || 4));
const PROFILE_ROOT = path.join('data', 'mail-profiles');
// 1440x900 桌面 2×2 网格
const W = 710, H = 440;
const SLOT_POS = [[0, 0], [726, 0], [0, 456], [726, 456]];

(async () => {
  const emails = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'))
    .map((s) => String(s).trim()).filter(Boolean);
  const queue = emails.slice();
  console.log(`清单 ${emails.length} 个邮箱，并发 ${CONCURRENCY}，开始…`);
  const done = [];
  const failed = [];

  async function worker(id) {
    while (queue.length) {
      const email = queue.shift();
      const local = email.split('@')[0];
      const profile = path.join(PROFILE_ROOT, local);
      const [x, y] = SLOT_POS[(id - 1) % SLOT_POS.length];
      try {
        const ctx = await chromium.launchPersistentContext(profile, {
          headless: false,
          viewport: null,   // 尊重窗口尺寸
          args: ['--disable-blink-features=AutomationControlled',
            `--window-size=${W},${H}`, `--window-position=${x},${y}`],
        });
        const page = ctx.pages()[0] || await ctx.newPage();
        await page.goto('https://outlook.live.com/').catch(() => {});
        console.log(`[slot${id}] 已打开 ${email}（登录完成后关闭该窗口即自动换下一个）`);
        await new Promise((res) => ctx.on('close', res));
        done.push(email);
        console.log(`[slot${id}] ${email} 窗口已关（会话已落盘），剩余 ${queue.length}`);
      } catch (e) {
        failed.push(`${email} :: ${e.message}`);
        console.error(`[slot${id}] ${email} 启动失败：${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
  console.log(`\n全部完成：成功 ${done.length}，失败 ${failed.length}`);
  if (failed.length) console.log(failed.join('\n'));
})().catch((e) => {
  console.error('[batch-mail-login] 启动失败：' + e.message);
  process.exit(1);
});
