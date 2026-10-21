// 一次性采集：SSO 后导出 console 会话 Cookie + JWT，随后用纯 HTTP 重放 sandbox-sso
// 验证「免浏览器续签」是否可行（可行 → 高频轻量续签，长期会话成立）。
const { chromium } = require('playwright-core')
const fs = require('fs')

const APP_ID = 'app-6620095f4f9d4cd48f6d667627500d82'
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
    const jwt = await page.evaluate(() => localStorage.getItem('Rh-Accesstoken') || '')
    if (!jwt) { console.log('ERR: no console jwt'); return 1 }
    console.log('jwt len:', jwt.length)
    const cookies = await ctx.cookies('https://console.vibex.cn')
    console.log('console cookies:', JSON.stringify(cookies.map((c) => ({ name: c.name, len: String(c.value).length }))))
    fs.writeFileSync('/tmp/vibex-session.json', JSON.stringify({ jwt, cookies }, null, 1))

    // 在页面内直接调 sandbox-sso（同源 fetch 跟随重定向会被 CORS 拦——改为读重定向 URL）
    const ssoUrl = `https://console.vibex.cn/sandbox-sso?app_id=${APP_ID}&return_origin=${encodeURIComponent('https://seedance.apps.vibex.cn')}`
    const probe = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { redirect: 'manual', credentials: 'include' })
        return { status: r.status, location: r.headers.get('location') || '', type: r.type }
      } catch (e) {
        return { error: String(e) }
      }
    }, ssoUrl)
    console.log('in-page sso probe:', JSON.stringify(probe).slice(0, 500))
    return 0
  } catch (e) {
    console.log('EXCEPTION:', e.message)
    return 1
  } finally {
    await browser.close()
  }
}
main().then((code) => process.exit(code))
