#!/usr/bin/env node
/**
 * vibex sandbox token 无头自动续期（kvm2 侧执行）。
 *
 * 背景（2026-10-19 实锤）：上游 seedance.apps.vibex.cn 改鉴权，旧的
 * x-vibex-scoped-token=RH accesstoken 全废；新链路只能走浏览器 SSO：
 *   runninghub.cn/sso-login（密码登录）→ console.vibex.cn 会话
 *   → /sandbox-sso?app_id=… → redirect fragment 带 vibex-sandbox-token。
 * 纯 HTTP 无法复刻（exchange 对 API 登录 JWT 返回 NOT_FOUND / ORIGIN_FORBIDDEN），
 * 故用 playwright-core + 系统 Chrome 无头跑完整链路。
 *
 * 凭据：/opt/rhnode/.vibex-renew.env（chmod 600）
 *   VIBEX_MOBILE=…  VIBEX_PASSWORD=…   （RunningHub 账号，即号池 accounts 表）
 *
 * 输出协议（stdout，供 rhpool 编排脚本解析）：
 *   续期成功   → "TOKEN\t<token>" 和 "EXPIRES\t<iso>"
 *   仍新鲜跳过 → "SKIP\t<剩余小时>h"
 *   失败       → "ERR\t<原因>"，截图落 /opt/rhnode/renew-debug/
 * 退出码：0=成功或跳过，1=失败。
 *
 * token 落盘：/opt/rhnode/.vibex-sandbox-token（第 1 行 token，第 2 行 expires）。
 * token 有效期 7 天；剩余 <96h 才真正登录续期（每日 cron 触发，自然形成
 * 约每 3~4 天续一次的节奏，避免频繁登录触发风控）。
 */
const { chromium } = require('playwright-core')
const fs = require('fs')

const APP_ID = 'app-6620095f4f9d4cd48f6d667627500d82'
const CRED_FILE = '/opt/rhnode/.vibex-renew.env'
const TOKEN_FILE = '/opt/rhnode/.vibex-sandbox-token'
const DEBUG_DIR = '/opt/rhnode/renew-debug'
const RETURN = 'https://console.vibex.cn/'
const SSO_URL = 'https://www.runninghub.cn/sso-login?returnUrl=' + encodeURIComponent(RETURN)
const FRESH_MS = 96 * 3600 * 1000 // 剩余不足 96h 才续

function log(msg) {
  console.log(`[vibex-renew ${new Date().toISOString()}] ${msg}`)
}
function emit(tag, value) {
  console.log(`${tag}\t${value}`)
}
function readCreds() {
  const text = fs.readFileSync(CRED_FILE, 'utf8')
  const env = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { mobile: env.VIBEX_MOBILE, password: env.VIBEX_PASSWORD }
}
/** 读已落盘 token 的过期时间；读不到/解析不了返回 0（视为已过期）。 */
function currentExpiresMs() {
  try {
    const lines = fs.readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
    return Date.parse(lines[1] || '') || 0
  } catch { return 0 }
}
function isTokenLine(s) {
  // sandbox token 形如 43 位大写字母数字下划线连字符，不含空格/引号
  return /^[A-Za-z0-9_-]{20,}$/.test(s)
}

async function main() {
  const remain = currentExpiresMs() - Date.now()
  if (remain > FRESH_MS) {
    emit('SKIP', `${Math.round(remain / 3600000)}h`)
    log(`token still fresh (${Math.round(remain / 3600000)}h left), skip`)
    return 0
  }
  log(`token expires in ${Math.round(remain / 3600000)}h (or missing), renewing`)
  const { mobile, password } = readCreds()
  if (!mobile || !password) { emit('ERR', 'missing credentials'); return 1 }
  fs.mkdirSync(DEBUG_DIR, { recursive: true })
  const shot = (name) => `${DEBUG_DIR}/${name}.png`

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    })
    const page = await ctx.newPage()
    await page.goto(SSO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(3000)
    await page.getByText('密码登录', { exact: true }).click({ timeout: 10000 })
    await page.waitForTimeout(1000)
    await page.locator('input[type="text"], input[placeholder*="手机"], input[placeholder*="账号"]').first().fill(mobile)
    await page.locator('input[type="password"]').first().fill(password)
    await page.screenshot({ path: shot('01-filled') })
    await page.locator('button:has-text("登录"), .login-btn, [class*="login"] button').last().click()
    await page.waitForTimeout(6000)
    for (let i = 0; i < 20; i++) {
      if (page.url().includes('console.vibex.cn')) break
      await page.waitForTimeout(1000)
    }
    const rhToken = await page.evaluate(() => localStorage.getItem('Rh-Accesstoken') || '')
    if (!rhToken) {
      await page.screenshot({ path: shot('02-no-console-session') })
      emit('ERR', `console session not established, url=${page.url().slice(0, 100)}`)
      return 1
    }
    log(`console session ok (jwt len=${rhToken.length})`)
    const sso = `https://console.vibex.cn/sandbox-sso?app_id=${APP_ID}&return_origin=${encodeURIComponent('https://seedance.apps.vibex.cn')}`
    await page.goto(sso, { waitUntil: 'domcontentloaded', timeout: 45000 })
    for (let i = 0; i < 20; i++) {
      if (page.url().includes('vibex-sandbox-token=')) break
      await page.waitForTimeout(1000)
    }
    const finalUrl = page.url()
    const m = finalUrl.match(/vibex-sandbox-token=([^&]+)/)
    const exp = finalUrl.match(/vibex-sandbox-expires=([^&]+)/)
    if (!m) {
      await page.screenshot({ path: shot('03-no-fragment') })
      emit('ERR', `no sandbox token in url: ${finalUrl.slice(0, 120)}`)
      return 1
    }
    const token = decodeURIComponent(m[1])
    const expires = decodeURIComponent(exp ? exp[1] : '')
    if (!isTokenLine(token)) {
      emit('ERR', 'token failed sanity check')
      return 1
    }
    fs.writeFileSync(TOKEN_FILE, token + '\n' + expires + '\n', { mode: 0o600 })
    fs.chmodSync(TOKEN_FILE, 0o600)
    log(`renewed ok, len=${token.length}, expires=${expires}`)
    emit('TOKEN', token)
    emit('EXPIRES', expires)
    return 0
  } catch (e) {
    try { await (await browser.contexts()[0]?.pages()[0])?.screenshot({ path: shot('99-exception') }) } catch {}
    emit('ERR', e.message)
    return 1
  } finally {
    await browser.close()
  }
}
main().then((code) => process.exit(code)).catch((e) => { emit('ERR', e.message); process.exit(1) })
