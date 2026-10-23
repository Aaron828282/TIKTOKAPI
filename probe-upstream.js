// 只读探测：上游任务是否已出片（不改号池状态）
const { cfg } = require('./lib/config')
const { createClient } = require('./lib/pool')
const { normalizeSession } = require('./lib/session')
const tiktok = require('./lib/tiktok')

const ACCOUNT_ID = Number(process.argv[2])
const UPSTREAM = String(process.argv[3] || '')

;(async () => {
  const client = createClient(cfg)
  const r = await client.listAccounts('tiktok_r2v')
  const acc = (r.accounts || []).find((a) => Number(a.id) === ACCOUNT_ID)
  if (!acc) throw new Error('account not found in pool list: ' + ACCOUNT_ID)
  const sess = normalizeSession(acc.session || {})
  console.log('session ok · keys=', Object.keys(sess).join(','))
  const out = await tiktok.poll(sess, cfg, UPSTREAM, {
    timeoutMs: 90000,
    intervalMs: 5000,
    log: (m) => console.log(m),
  })
  console.log('RESULT taskId=', out.taskId, 'nVideos=', out.nVideos, 'elapsed=', out.elapsedSec)
  console.log('meta=', JSON.stringify(out.bestMeta))
  console.log('url=', String(out.bestUrl).slice(0, 120))
  console.log('expire=', out.bestExpire || '-')
})().catch((e) => { console.error('ERR:', e.message); process.exit(1) })
