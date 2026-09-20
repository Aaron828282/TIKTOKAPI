'use strict';
/**
 * TikTok 上游的三个动作 —— 提交、轮询、下载。**全部直连，不经过浏览器。**
 *
 * 为什么可以不用浏览器（实测结论）
 * --------------------------------
 * 旧文档曾静态推断「必须有页面续期的 ticket-guard 签名」，实测**推翻了**：
 * 只要有 cookie + `x-creative-source`，完整 body 直连就能真的建单
 * （单图 4s 时长，132 秒出片）。浏览器只剩「每 ~3 天刷 cookie」这一个用途。
 *
 * 两个会静默出错的坑
 * ------------------
 * 1. 🔴 **下载 `MainUrl` 必须带 `Referer`**（编辑器页）。只给 UA → **403**。
 *    看到 403 别急着判定「链接过期」——先补 Referer。
 * 2. 🔴 **`VideoInfos` 顺序不稳定**，取片必须按 `max(Width × Height)` 选档，
 *    不能按索引。Fast 一次给 4 档，`VideoInfos[0]` 是**最低档 360p**。
 */
const { SOURCE_HEADER, queryOf } = require('./payload');

const GEN_PATH = '/creative_bff_i18n/api/cue/i2v/gen_r2v_video';
const HISTORY_PATH = '/creative_bff_i18n/api/cue/history/tasks';

const HISTORY_BODY = {
  isAbridged: false,
  showPlayInfo: true,
  sorted: 2,
  pageOffset: 0,
  pageLimit: 10,
};

/** 会话已失效的业务码（空体打 history 时返回它）。 */
const LOGIN_REQUIRED_CODE = 10001106;

function headersOf(session, cfg, withContentType = true) {
  const h = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    origin: cfg.origin,
    referer: cfg.referer,
    'user-agent': session.user_agent || cfg.userAgent,
    'x-creative-source': SOURCE_HEADER,
    'x-csrftoken': session.x_csrftoken,
    'agw-js-conv': 'str',
    cookie: session.cookie,
  };
  if (withContentType) h['content-type'] = 'application/json';
  if (session.x_fp_id) h['x-fp-id'] = session.x_fp_id;
  return h;
}

async function postJson(url, headers, obj) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(obj),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留原文用于报错 */ }
  return { status: res.status, json, text };
}

/**
 * 会话探活：发空体，看业务码。
 *
 * - `10001106 Login Required` ⟹ cookie 已经死了，需要重新取
 * - 其它（例如「缺少参数 model」）⟹ 会话有效
 *
 * 广告线会话 TTL 只有 **3 天**（通用线 180 天），所以这个探活要定期跑。
 */
async function probeSession(session, cfg) {
  const url = `${cfg.origin}${HISTORY_PATH}?${queryOf(session.device_id)}`;
  const { status, json, text } = await postJson(url, headersOf(session, cfg), {});
  if (!json) {
    return { alive: false, code: null, status, message: `响应不是 JSON：${String(text).slice(0, 160)}` };
  }
  const code = json.code;
  return {
    alive: code !== LOGIN_REQUIRED_CODE,
    code,
    status,
    message: json.message || '',
  };
}

/** 提交建单。返回 { taskId, draftId, draftInfo, raw }。 */
async function submit(session, cfg, payload, log) {
  const url = `${cfg.origin}${GEN_PATH}?${queryOf(session.device_id)}`;
  const { status, json, text } = await postJson(url, headersOf(session, cfg), payload);
  if (!json || json.code !== 0 || !json.data) {
    throw new Error(`建单失败：HTTP ${status} code=${json && json.code} ` +
      `message=${json && json.message} ${String(text).slice(0, 240)}`);
  }
  const taskId = json.data.task_id;
  const d0 = (json.data.draft_infos || [])[0] || {};
  if (!taskId) throw new Error(`建单响应没有 task_id：${String(text).slice(0, 240)}`);
  if (log) {
    log(`  已建单 task=${taskId} draft=${d0.id} ` +
      `draftStatus=${d0.draftTaskStatus} renderStatus=${d0.renderTaskStatus}`);
  }
  return { taskId, draftId: d0.id, draftInfo: d0, raw: json };
}

/** 取 max(Width × Height) —— **不能按索引**，顺序不稳定。 */
function selectBest(videoInfos) {
  let best = null;
  let bestArea = -1;
  for (const v of videoInfos || []) {
    const m = v.VideoMeta || {};
    const area = Number(m.Width || 0) * Number(m.Height || 0);
    if (area > bestArea) {
      bestArea = area;
      best = v;
    }
  }
  return best;
}

function videoArea(v) {
  const m = (v || {}).VideoMeta || {};
  return Number(m.Width || 0) * Number(m.Height || 0);
}

/**
 * 轮询直到出片。
 *
 * 三套 Status 别混：
 *   draftTaskStatus 2 生成中 / 0 完成 / 3 **失败**
 *   renderTaskStatus 2 渲染中 / 0 完成
 *   videoInfo.Status 2 渲染中 / **10 成功**   ← 成功值是 10，不是 0
 *
 * `onTick` 会被反复调用（每轮一次），用来给号池打心跳 —— 心跳一停，
 * 号池就会按 agent_timeout 判失败收尸。`onTick` 返回 `{stop:true}` 表示
 * 任务已被调用方取消，提前抛出（抛出的错误带 `.cancelled = true`，
 * 调用方据此把它算成「取消」而不是「失败」）。
 */
async function poll(session, cfg, taskId, opts = {}) {
  const {
    timeoutMs = 1500000,
    intervalMs = 8000,
    onTick = null,
    log = null,
  } = opts;

  const url = `${cfg.origin}${HISTORY_PATH}?${queryOf(session.device_id)}`;
  const started = Date.now();
  let lastSig = null;

  while (Date.now() - started < timeoutMs) {
    if (onTick) {
      const verdict = onTick(Math.min(95, 5 + Math.floor((Date.now() - started) / 12000)));
      if (verdict && verdict.stop) {
        const err = new Error('任务已被调用方取消（号池侧已进终态）');
        err.cancelled = true;
        throw err;
      }
    }

    const { json } = await postJson(url, headersOf(session, cfg), HISTORY_BODY);
    const elapsed = Math.round((Date.now() - started) / 1000);

    if (!json || json.code !== 0) {
      if (json && json.code === LOGIN_REQUIRED_CODE) {
        throw new Error('会话在轮询期间失效（10001106 Login Required）—— 需要刷新 cookie');
      }
      if (log) log(`  +${elapsed}s 轮询异常 code=${json && json.code} ${String(json && json.message).slice(0, 70)}`);
      await sleep(intervalMs);
      continue;
    }

    const items = (json.data || {}).draft_infos || [];
    const me = items.find((x) => x.taskId === taskId);
    if (!me) {
      if (log) log(`  +${elapsed}s 列表 ${items.length} 条，尚未出现目标 task`);
      await sleep(intervalMs);
      continue;
    }

    const vi = me.videoInfo || {};
    const vinfos = vi.VideoInfos || [];
    const sig = `${me.draftTaskStatus}/${me.renderTaskStatus}/${vi.Status}/${vinfos.length}`;
    if (sig !== lastSig) {
      if (log) {
        log(`  +${elapsed}s draft=${me.draftTaskStatus} render=${me.renderTaskStatus} ` +
          `video=${vi.Status} 变体=${vinfos.length}`);
      }
      lastSig = sig;
    }

    // 终态失败：draftTaskStatus=3。失败原因只在 generateError* 里 ——
    // 只回一个 videoInfo.Status=2 是无法定位的。
    if (Number(me.draftTaskStatus) === 3) {
      const reason = me.generateErrorMessage || me.errorMsg || vi.Message || '上游未给出原因';
      const code = me.generateErrorCode || me.errorCode || '';
      throw new Error(`上游生成失败 [${code}] ${reason}`.slice(0, 500));
    }

    const done = Number(me.renderTaskStatus) === 0 && Number(me.draftTaskStatus) === 0 && vinfos.length > 0;
    const videoOk = vi.Status === 10 || vi.Status === '10' || vi.Message === 'success';
    if (done || videoOk) {
      const best = selectBest(vinfos) || {};
      const meta = best.VideoMeta || {};
      return {
        taskId,
        draftId: me.id,
        vid: me.vid || '',
        bestUrl: best.MainUrl || '',
        bestMeta: meta,
        // ⚠️ UrlExpire 挂在 **videoInfo** 上，不在 VideoMeta 里
        bestExpire: best.UrlExpire || '',
        // 变体原样带上 VideoMeta 的全部字段（Width/Height/Format/Codec/Size/
        // Definition/BizQualityType…），只补两个我们才知道的键。
        // **别把它压成「只有 url 的字符串数组」** —— 分辨率阶梯是这条记录
        // 唯一的分析价值（选了哪一档、上游给了几档），压掉就再也看不出来。
        variants: vinfos.map((v) => ({
          ...(v.VideoMeta || {}),
          url: v.MainUrl,
          expire: v.UrlExpire,
        })),
        nVideos: vinfos.length,
        elapsedSec: elapsed,
        raw: me,
      };
    }

    await sleep(intervalMs);
  }

  throw new Error(`本地轮询超时（>${Math.round(timeoutMs / 1000)}s）`);
}

/**
 * 下载成片。
 *
 * 🔴 **必须带 `Referer`**：`MainUrl` 是 CDN 签名直链，签名只解决「这条 URL
 * 合不合法」，CDN 还会单独校验 Referer。裸 GET（只给 UA）实测 **403**，
 * 补上编辑器页 Referer 立刻 200。所以 403 ≠ 链接过期。
 */
async function download(url, cfg) {
  const res = await fetch(url, {
    headers: {
      'user-agent': cfg.userAgent,
      referer: cfg.referer,
      accept: 'video/*,*/*;q=0.8',
    },
  });
  if (!res.ok) {
    throw new Error(`成片下载失败 HTTP ${res.status}` +
      (res.status === 403 ? '（403 通常是没带 Referer，不是链接过期）' : ''));
  }
  return Buffer.from(await res.arrayBuffer());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  GEN_PATH,
  HISTORY_PATH,
  HISTORY_BODY,
  LOGIN_REQUIRED_CODE,
  headersOf,
  probeSession,
  submit,
  selectBest,
  videoArea,
  poll,
  download,
  sleep,
};
