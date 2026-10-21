// 2.5 提交决定性实验：SSO → 落地 seedance 页 → 页面内 fetch 提交（带全部 Cookie）
// 同时导出 cookie 清单，验证「缺 Cookie」假设。
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
    const sso = `https://console.vibex.cn/sandbox-sso?app_id=${APP_ID}&return_origin=${encodeURIComponent('https://seedance.apps.vibex.cn')}`
    await page.goto(sso, { waitUntil: 'domcontentloaded', timeout: 45000 })
    for (let i = 0; i < 20; i++) {
      if (page.url().includes('vibex-sandbox-token=')) break
      await page.waitForTimeout(1000)
    }
    // 落地 seedance 页（带 fragment），等待页面把 token 收进 localStorage
    await page.goto('https://seedance.apps.vibex.cn/', { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(4000)
    const scoped = await page.evaluate(() => localStorage.getItem('vibex-scoped-token') || localStorage.getItem('sandbox-token') || '')
    const allLS = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage).map(([k, v]) => [k, String(v).slice(0, 60)]))))
    console.log('scoped-ish localStorage keys:', allLS)
    const cookies = await ctx.cookies('https://seedance.apps.vibex.cn')
    console.log('cookies:', JSON.stringify(cookies.map((c) => ({ name: c.name, len: String(c.value).length }))))
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

    // 页面内 fetch 提交（同源，自动带 cookie + localStorage 里的 token）
    const result = await page.evaluate(async (model) => {
      const headers = { 'Content-Type': 'application/json' }
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (/token/i.test(k)) headers['X-Vibex-Scoped-Token'] = localStorage.getItem(k)
      }
      const body = {
        model,
        prompt: '一只小猫在草地上奔跑，阳光明媚，电影感镜头',
        duration: '4', resolution: '480p', ratio: '9:16',
        generateAudio: true, realPersonMode: true, bitrateMode: 'high',
        conversionSlots: ['all'], returnLastFrame: false,
      }
      const resp = await fetch('/__pb/api/aigc/submit', { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) })
      const text = await resp.text()
      return { status: resp.status, text: text.slice(0, 300), usedHeader: Boolean(headers['X-Vibex-Scoped-Token']) }
    }, 'bytedance/seedance-2.5-token/multimodal-video')
    console.log('in-page submit:', JSON.stringify(result))
    // 导出 cookie 供服务端复验
    fs.writeFileSync('/tmp/vibex-cookies.json', JSON.stringify(cookies))
    console.log('cookies saved:', cookieHeader.slice(0, 120), '...')
    return 0
  } catch (e) {
    console.log('EXCEPTION:', e.message)
    return 1
  } finally {
    await browser.close()
  }
}
main().then((code) => process.exit(code))
