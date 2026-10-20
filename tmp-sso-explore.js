const { chromium } = require('playwright-core')

const SSO_URL = 'https://www.runninghub.cn/sso-login?returnUrl=' + encodeURIComponent('https://console.vibex.cn/')

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  const page = await ctx.newPage()
  const urls = []
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) urls.push(f.url()) })
  try {
    await page.goto(SSO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(5000)
    console.log('final url:', page.url())
    console.log('nav chain:', urls.slice(0, 6).join('\n  -> '))
    const info = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 500),
      localStorageKeys: Object.keys(localStorage),
      hasToken: !!localStorage.getItem('Rh-Accesstoken'),
    }))
    console.log('page:', JSON.stringify(info, null, 2).slice(0, 1200))
    await page.screenshot({ path: '/tmp/sso-login.png', fullPage: false })
    const cookies = await ctx.cookies()
    console.log('cookie names:', cookies.map((c) => c.name).join(','))
  } catch (e) {
    console.log('ERR', e.message)
  }
  await browser.close()
}
main()
