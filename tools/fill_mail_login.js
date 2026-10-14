#!/usr/bin/env node
/**
 * 批量人工首登 Outlook —— 自动填表版（2026-10-14）。
 *
 * 与 batch_mail_login.js 的区别：本版自动把邮箱/密码填进微软登录页并提交，
 * 然后停在二次验证/保持登录等人工步骤上；用户在 noVNC 里完成剩余步骤后
 * **关闭窗口即视为完成**，槽位自动取清单下一个邮箱重新填表。
 *
 * 用法（DISPLAY=:98）：
 *   node tools/fill_mail_login.js
 *   MAIL_LIST=data/mail-list.json MAIL_PASS=data/mail-pass.json
 *   MAIL_CONCURRENCY=4（默认）
 *
 * 微软登录页选择器（login.microsoftonline.com）：
 *   邮箱 input[name=loginfmt] · 密码 input[name=passwd] · 提交按钮 #idSIButton9
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LIST_FILE = process.env.MAIL_LIST || path.join('data', 'mail-list.json');
const PASS_FILE = process.env.MAIL_PASS || path.join('data', 'mail-pass.json');
const CONCURRENCY = Math.max(1, Number(process.env.MAIL_CONCURRENCY || 4));
const PROFILE_ROOT = path.join('data', 'mail-profiles');
const W = 710, H = 440;
const SLOT_POS = [[0, 0], [726, 0], [0, 456], [726, 456]];

const passMap = JSON.parse(fs.readFileSync(PASS_FILE, 'utf8'));
const emails = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'))
  .map((s) => String(s).trim()).filter(Boolean);

(async () => {
  const queue = emails.slice();
  console.log(`清单 ${emails.length} 个邮箱（自动填表版），并发 ${CONCURRENCY}`);
  const done = [], manual = [], failed = [];

  async function fillAndSubmit(page, email, pass, log) {
    // 1) 等登录页邮箱框（outlook.live.com 会 302 到 login.microsoftonline.com）
    await page.waitForSelector('input[name="loginfmt"]', { timeout: 60_000 });
    // 2) profile 里若留有旧账户瓦片（选择账户页），先点匹配的那个
    try {
      const tile = page.locator(`div[data-test-id="${email}"]`);
      if (await tile.count()) { await tile.first().click(); log('点击已有账户瓦片'); }
    } catch { /* 没有瓦片页，正常直填 */ }
    await page.fill('input[name="loginfmt"]', email);
    await page.click('#idSIButton9');
    // 3) 「个人/工作学校账户」二选一页（同邮箱双账户时出现）→ 点个人
    try {
      const chooser = page.locator('text=Personal account').or(page.locator('text=个人帐户'));
      await chooser.first().click({ timeout: 6000 });
      log('选择了「个人账户」');
    } catch { /* 无此页 */ }
    // 4) 密码页
    await page.waitForSelector('input[name="passwd"]', { timeout: 45_000 });
    await page.fill('input[name="passwd"]', pass);
    await page.click('#idSIButton9');
    log('密码已提交 —— 停在人工步骤（二次验证 / 保持登录状态 / 收件箱）');
  }

  async function worker(id) {
    while (queue.length) {
      const email = queue.shift();
      const pass = passMap[email] || passMap[email.toLowerCase()];
      const local = email.split('@')[0];
      const profile = path.join(PROFILE_ROOT, local);
      const [x, y] = SLOT_POS[(id - 1) % SLOT_POS.length];
      const log = (m) => console.log(`[slot${id}] ${email} ${m}`);
      if (!pass) { failed.push(`${email} :: 清单里没有该邮箱的密码`); continue; }
      try {
        const ctx = await chromium.launchPersistentContext(profile, {
          headless: false,
          viewport: null,
          args: ['--disable-blink-features=AutomationControlled',
            `--window-size=${W},${H}`, `--window-position=${x},${y}`],
        });
        const page = ctx.pages()[0] || await ctx.newPage();
        await page.goto('https://outlook.live.com/').catch(() => {});
        let state = 'opened';
        try {
          await fillAndSubmit(page, email, pass, log);
          state = 'submitted';
        } catch (e) {
          log(`自动填表中断（${String(e.message).slice(0, 90)}）—— 窗口保留，请人工处理`);
          state = 'manual';
        }
        await new Promise((res) => ctx.on('close', res));
        (state === 'submitted' ? done : state === 'manual' ? manual : failed)
          .push(email);
        console.log(`[slot${id}] ${email} 窗口已关（${state}），剩余 ${queue.length}`);
      } catch (e) {
        failed.push(`${email} :: ${e.message}`);
        console.error(`[slot${id}] ${email} 启动失败：${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
  console.log(`\n全部完成：自动填表 ${done.length}，人工介入 ${manual.length}，失败 ${failed.length}`);
  for (const x of [...done, ...manual, ...failed]) console.log(' - ' + x);
})().catch((e) => {
  console.error('[fill-mail-login] 启动失败：' + e.message);
  process.exit(1);
});
