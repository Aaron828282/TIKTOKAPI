// 批量探测：每个上游任务当前 draft/render/video 状态（只读，15s 观察窗）
const { cfg } = require('./lib/config')
const { createClient } = require('./lib/pool')
const { normalizeSession } = require('./lib/session')
const tiktok = require('./lib/tiktok')

const MAP = [
  { pool: '03e72d2fb2c7420a', upstream: '7699767584569458740', account: 59 },
  { pool: '69e5fa33a13b4944', upstream: '7699767796407107585', account: 59 },
  { pool: '0e035c67be6842a5', upstream: '7699769532030779398', account: 59 },
  { pool: '45cd354ef3a4483b', upstream: '7699770917609865217', account: 59 },
  { pool: '41ffb3cbee2e411d', upstream: '7699771361857896454', account: 52 },
  { pool: 'f94c25c90dc14397', upstream: '7699772175948185606', account: 89 },
  { pool: '1aaa35babf7244ca', upstream: '7699772423185727494', account: 89 },
  { pool: 'a35c079ceeff4c45', upstream: '7699772915215368193', account: 89 },
]

;(async () => {
  const client = createClient(cfg)
  const r = await client.listAccounts('tiktok_r2v')
  const sessions = new Map()
  for (const acc of (r.accounts || [])) sessions.set(Number(acc.id), normalizeSession(acc.session || {}))

  for (const item of MAP) {
    const sess = sessions.get(item.account)
    if (!sess) { console.log(item.pool, 'NO SESSION', item.account); continue }
    const lines = []
    try {
      const out = await tiktok.poll(sess, cfg, item.upstream, {
        timeoutMs: 12000,
        intervalMs: 4000,
        log: (m) => lines.push(String(m).trim()),
      })
      console.log(item.pool, 'DONE', 'n=', out.nVideos, 'url=', String(out.bestUrl).slice(0, 60))
    } catch (e) {
      console.log(item.pool, 'STILL_PENDING_OR_ERR', '|', lines.slice(-1)[0] || e.message)
    }
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1) })
