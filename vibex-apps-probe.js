// 枚举 vibex 账号下全部沙盒 app，并逐个用其 sandbox-sso token 测试 2.5 提交。
const { chromium } = require('playwright-core')
const fs = require('fs')

const CRED_FILE = '/opt/rhnode/.vibex-renew.env'
const RETURN = 'https://console.vibex.cn/'
const SSO_URL = 'https://www.runninghub.cn/sso-login?returnUrl=' + encodeURIComponent(RETURN)

function readCreds() {
  const env = {}
  for (const line of fs.readFileSync(CRED_FILE, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { mobile: env.VIBEX_MOBILE, password: env.VIBEX_PASSWORD }
}

async function main() {
  const { mobile, password } = readCreds()
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
    await page.locator('button:has-text("登录"), .login-btn, [class*="login"] button').last().click()
    await page.waitForTimeout(6000)
    for (let i = 0; i < 20; i++) {
      if (page.url().includes('console.vibex.cn')) break
      await page.waitForTimeout(1000)
    }
    await page.goto('https://console.vibex.cn/dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(4000)
    // 用页面内 fetch 枚举 app 列表（自动带 JWT cookie）
    const apps = await page.evaluate(async () => {
      const tryUrls = ['/api/apps', '/api/sandbox/apps', '/api/app/list', '/api/sandboxes', '/api/console/apps']
      const out = []
      for (const u of tryUrls) {
        try {
          const r = await fetch(u, { credentials: 'include' })
          if (r.status === 200) {
            const text = await r.text()
            out.push({ url: u, status: r.status, body: text.slice(0, 2000) })
          }
        } catch (e) { /* ignore */ }
      }
      return out
    })
    console.log('APP LIST PROBES:', JSON.stringify(apps, null, 1).slice(0, 3000))
    return 0
  } catch (e) {
    console.log('EXCEPTION:', e.message)
    return 1
  } finally {
    await browser.close()
  }
}
main().then((code) => process.exit(code))
