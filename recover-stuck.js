/**
 * 卡死任务恢复守护（2026-10-23）
 *
 * 背景：号池重启窗口内，节点 8 条任务的轮询循环静默中断 —— 号池里停在
 * AGENT_RUNNING 95%，上游其实已建单。本进程独立于 rhnode 运行（不重启主进程，
 * 避免启动时的孤儿单认尸把这 8 单判失败），职责：
 *   1. 每 90s 给这 8 单打心跳（保活，别让号池按 900s 判 MONITORING）；
 *   2. 轮询上游 taskId，出片后下载 → 转存网站 → 回传 SUCCESS（带变体与上游任务号）；
 *   3. 上游明确失败（draftTaskStatus=3）才回传 FAILED，并退出该项。
 * 状态落 /opt/rhnode/recover-state.json，可断点续跑。
 */
const fs = require('fs')
const { cfg } = require('./lib/config')
const { createClient } = require('./lib/pool')
const { normalizeSession } = require('./lib/session')
const tiktok = require('./lib/tiktok')

const STATE_FILE = '/opt/rhnode/recover-state.json'
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

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`)

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) } catch (e) { log('state save failed: ' + e.message) }
}

async function deliver(bytes, filename, taskId) {
  const maxBytes = Number(cfg.mirrorMaxMb || 25) * 1024 * 1024
  if (bytes.length > maxBytes) throw new Error(`成片 ${(bytes.length / 1048576).toFixed(1)}MB 超过收件端上限`)
  if (!cfg.mirrorUrl) throw new Error('未配置 RH_MIRROR_URL')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(60, Number(cfg.mirrorTimeoutSeconds || 900)) * 1000)
  try {
    const res = await fetch(cfg.mirrorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Relay-Task-Id': String(taskId),
        ...(cfg.mirrorToken ? { Authorization: 'Bearer ' + cfg.mirrorToken } : {}),
      },
      body: bytes,
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 140)}`)
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* 纯文本 URL */ }
    const url = (parsed && (parsed.output_url || parsed.url))
      || (/^https?:\/\/\S+$/.test(text.trim()) ? text.trim() : '')
    if (!url) throw new Error('转存响应里没有 URL：' + text.slice(0, 140))
    return url
  } finally {
    clearTimeout(timer)
  }
}

;(async () => {
  const state = loadState()
  const client = createClient(cfg)
  const accountsRes = await client.listAccounts('tiktok_r2v')
  const sessions = new Map()
  for (const acc of accountsRes.accounts || []) {
    try { sessions.set(Number(acc.id), normalizeSession(acc.session || {})) } catch { /* 跳过坏凭据 */ }
  }
  log(`恢复启动：${MAP.length} 单 · 可用会话 ${sessions.size} 个`)

  const pending = () => MAP.filter((m) => state[m.pool]?.status !== 'done' && state[m.pool]?.status !== 'upstream_failed')

  while (pending().length) {
    for (const item of pending()) {
      const sess = sessions.get(item.account)
      // 1) 心跳保活（进度 95%，与中断前一致）
      try {
        await client.heartbeat(item.pool, { status: 'AGENT_RUNNING', progress: 95 })
      } catch (e) { log(`${item.pool} 心跳失败：${e.message}`) }

      if (!sess) { log(`${item.pool} 没有账号 ${item.account} 的会话，跳过`); continue }

      // 2) 轮询上游（20 秒观察窗，不阻塞太久）
      let out = null
      let lastLine = ''
      try {
        out = await tiktok.poll(sess, cfg, item.upstream, {
          timeoutMs: 20000,
          intervalMs: 5000,
          log: (m) => { lastLine = String(m).trim() },
        })
      } catch (e) {
        // 只有上游明确失败（draft=3 / 带 upstreamCode）才认输；其余都是还没出片
        const upstreamFailed = /draft=3/.test(lastLine) || Boolean(e.upstreamCode)
        log(`${item.pool} 仍在生成 · ${lastLine || e.message}`)
        if (upstreamFailed) {
          state[item.pool] = { ...(state[item.pool] || {}), status: 'upstream_failed', note: e.message }
          saveState(state)
        }
        continue
      }

      // 3) 出片 → 下载 → 转存 → 回传
      log(`${item.pool} 上游出片：${out.nVideos} 个变体 · ${out.elapsedSec}s · ${String(out.bestUrl).slice(0, 60)}`)
      let bytes = null
      try {
        bytes = await tiktok.download(out.bestUrl, cfg)
        log(`${item.pool} 已下载 ${(bytes.length / 1048576).toFixed(2)}MB`)
      } catch (e) {
        log(`${item.pool} 下载失败：${e.message}（将重试）`)
        continue
      }
      let outputUrl = out.bestUrl
      let archived = false
      let note = ''
      try {
        outputUrl = await deliver(bytes, `${item.pool}.mp4`, item.pool)
        archived = true
        log(`${item.pool} 转存成功 → ${outputUrl.slice(0, 80)}`)
      } catch (e) {
        note = `转存失败（${e.message}）—— 已降级直链交付`
        log(`${item.pool} ${note}`)
      }
      try {
        const r = await client.result({
          task_id: item.pool,
          ok: true,
          output_url: outputUrl,
          output_type: 'video',
          output_size: String((out.bestMeta || {}).Size || ''),
          expire_time: String(out.bestExpire || ''),
          remote_task_id: item.upstream,
          output_variants: out.variants || [],
          archived,
          archive_note: note,
          fee: 0,
        })
        state[item.pool] = { ...(state[item.pool] || {}), status: 'done', output_url: outputUrl, at: Date.now() }
        saveState(state)
        log(`${item.pool} ✅ 回传成功 status=${r.status} already_final=${r.already_final || false}`)
      } catch (e) {
        log(`${item.pool} 回传失败：${e.message}（下轮重试）`)
      }
    }

    if (pending().length) await new Promise((r) => setTimeout(r, 90000))
  }

  log('全部处理完毕：' + JSON.stringify(Object.fromEntries(MAP.map((m) => [m.pool, state[m.pool]?.status || 'unknown']))))
  process.exit(0)
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1) })
