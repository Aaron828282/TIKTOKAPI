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
const { SOURCE_HEADER, QUERY_AID, queryOf } = require('./payload');
const failure = require('./failure');

const GEN_PATH = '/creative_bff_i18n/api/cue/i2v/gen_r2v_video';
const GEN_I2I_PATH = '/creative_bff_i18n/api/cue/i2v/gen_i2i_image';
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

/**
 * `fetchImpl` 是为了让 `preflight.js` 能**经代理**发这一枪 —— 全局 `fetch`
 * 不认 `HTTP_PROXY`，而国内开发机必须走代理才够得到 TikTok。
 * 不传就是全局 `fetch`（节点在墙外，直连）。
 */
async function postJson(url, headers, obj, fetchImpl = null) {
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(url, {
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
async function probeSession(session, cfg, opts = {}) {
  const url = `${cfg.origin}${HISTORY_PATH}?${queryOf(session.device_id)}`;
  const { status, json, text } = await postJson(
    url, headersOf(session, cfg), {}, opts.fetchImpl || null);
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

// --------------------------------------------------------------- 只读采集
//
// 下面四个都是**免费只读**接口。跑任务前后顺手打一枪，把账号的积分 / 额度 /
// 并发上限捎回号池 —— 号池在北京够不到 `ads.tiktok.com`（DNS 被污染），
// 控制台那张表格里的每一个数字都只能从这条路来。
//
// ⚠️ 查询串用 `QUERY_AID`，**不带 `did`/`device_id`**：did 是「用哪个设备查」
//    的参数，只读查询用不上，带着反而多暴露一个本地标识。实测不带也稳定 200。
//    （提交/轮询/下载那三条路径仍然要带，那是有状态的会话操作。）

const CREDIT_PATH = '/CreativeOne/SymphonyPlatform/QueryUserCreditAccount';
const MAXCOUNT_PATH = '/creative_bff_i18n/api/cue/get_generate_max_count';
const TASKCOUNT_PATH = '/creative_bff_i18n/api/cue/generating-task-count';
const QUOTA_PATH = '/creative_bff_i18n/api/cue/batch_query_generation_quota';

/** 号池 models.py 里的三个档位（顺序即看板顺序）。 */
const QUOTA_STRATEGIES = ['2000009', '2000004', '2000012'];
const QUOTA_SOURCE = 'CreativeStudio/ReferenceToVideo/ReferenceToVideo';

/** 与 `postJson` 同构的 GET 版（只读查询全走 GET）。 */
async function getJson(url, headers, fetchImpl = null) {
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(url, { method: 'GET', headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留原文用于报错 */ }
  return { status: res.status, json, text };
}

/**
 * 查积分账户。
 *
 * ★ 口径（2026-09-17 对照官方 settings/credit 页面校准，血泪教训）：
 *   页面那个大数字是 **`credits + bonus`**，不是 `credits` 单独一个字段。
 *   实测某号 `credits=6148`、`bonus=8000`，页面显示 **14,148** —— 只读
 *   `credits` 会让看板整整少一个 bonus 的量，看着像快用完了，其实很宽裕。
 *   这里把两个原始字段**都**报给号池，合并口径由号池算（`main._credit_of`）：
 *   两边各算一遍迟早会漂。
 *
 * ⚠️ 这个接口走 CreativeOne 网关，返回体**没有 `code` 字段**，成败看
 *    `BaseResp.StatusCode`。照 `code !== 0` 判会把正常响应当成失败。
 */
async function creditAccount(session, cfg, opts = {}) {
  const url = `${cfg.origin}${CREDIT_PATH}?${QUERY_AID}`;
  const { status, json, text } =
    await getJson(url, headersOf(session, cfg, false), opts.fetchImpl || null);
  if (!json) {
    return { ok: false, status, error: `响应不是 JSON：${String(text).slice(0, 160)}` };
  }
  const base = json.BaseResp || {};
  if (status !== 200 || (base.StatusCode !== undefined && base.StatusCode !== 0)) {
    return { ok: false, status, code: base.StatusCode,
             error: `StatusCode=${base.StatusCode} ${base.StatusMessage || ''}`.trim().slice(0, 200) };
  }
  const d = json.user_credit_account || {};
  const num = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  };
  const credits = num(d.credits);
  const bonus = num(d.bonus);
  const grant = num(d.credit_grant);
  return {
    ok: true,
    status,
    credits,
    bonus,
    credit_grant: grant,
    total: credits + bonus,        // 页面口径的「本周剩余」
    total_grant: grant + bonus,    // 页面口径的「本周总额度」
    adv_name: d.primary_adv_name || '',
    adv_id: d.aio_id ? String(d.aio_id) : '',
    // 有的环境回字符串 "false"，直接 Boolean() 会得到 true —— 显式判一次
    frozen: d.frozen === true || d.frozen === 'true' || d.frozen === 1,
    tier: d.credit_tier,
    raw: json,
  };
}

/** 各工具并发上限（返回 {map, max}）。 */
async function generateMaxCount(session, cfg, opts = {}) {
  const url = `${cfg.origin}${MAXCOUNT_PATH}?${QUERY_AID}`;
  const { status, json } =
    await getJson(url, headersOf(session, cfg, false), opts.fetchImpl || null);
  if (!json || json.code !== 0) {
    return { ok: false, status, code: json && json.code };
  }
  const map = json.data || {};
  const vals = Object.values(map).filter((v) => Number.isFinite(Number(v)));
  return { ok: true, status, map, max: vals.length ? Math.max(...vals.map(Number)) : null };
}

/** 当前正在生成的任务数（免费，可高频）。 */
async function runningCount(session, cfg, opts = {}) {
  const url = `${cfg.origin}${TASKCOUNT_PATH}?${QUERY_AID}`;
  const { status, json } =
    await postJson(url, headersOf(session, cfg), {}, opts.fetchImpl || null);
  if (!json || json.code !== 0) {
    return { ok: false, status, code: json && json.code };
  }
  return { ok: true, status, total: Number((json.data || {}).total) || 0 };
}

/** 分档位每日额度（UTC 0 点重置 = 北京 08:00）。 */
async function generationQuota(session, cfg, opts = {}) {
  const body = {
    targets: QUOTA_STRATEGIES.map((s) => ({ source: QUOTA_SOURCE, strategy_id: s })),
  };
  const url = `${cfg.origin}${QUOTA_PATH}?${QUERY_AID}`;
  const { status, json } =
    await postJson(url, headersOf(session, cfg), body, opts.fetchImpl || null);
  if (!json || json.code !== 0) {
    return { ok: false, status, code: json && json.code };
  }
  const daily = {};
  let reset = 0;
  let level = '';
  for (const item of ((json.data || {}).results || [])) {
    const sid = (item.target || {}).strategy_id;
    if (!sid) continue;
    const q = item.quota || {};
    daily[sid] = {
      remaining: q.remaining, quota: q.quota, used: q.used, matched: q.matched,
    };
    if (q.reset_at_ms) reset = Math.floor(Number(q.reset_at_ms) / 1000);
    if (!level && q.user_level) level = q.user_level;
  }
  return { ok: true, status, daily, reset_ts: reset, user_level: level };
}

/**
 * 把上面几个只读接口拼成一份「账号快照」，交给号池落库。
 *
 * 三条约束，破一条看板就会骗人：
 *
 * 1. **单项失败不影响整体**。积分接口被限流了，额度那一项照样该报回去；
 *    一处失败就整包丢弃，控制台会显示成「什么都没采到」，运维会去查一个
 *    根本不存在的网络问题。
 * 2. **只报原始字段**，不自己做 `credits + bonus` 的合并 —— 那是号池的
 *    `_credit_of` 的活儿。两边各算一遍，迟早漂成两个数。
 * 3. **采不到就少报几个字段**，不要写 `null` 顶掉上一轮的好数据。
 *    （号池那边 `set_agent_account_info` 是按字段合并的，不报就是保留。）
 */
async function collectAccountInfo(session, cfg, opts = {}) {
  const { log = null } = opts;
  const note = (m) => { if (log) log(`  ${m}`, 'debug'); };
  const info = { ts: Math.floor(Date.now() / 1000) };

  try {
    const c = await creditAccount(session, cfg, opts);
    if (c.ok) {
      info.credits = c.credits;
      info.bonus = c.bonus;
      info.credit_grant = c.credit_grant;
      info.credits_total = c.total_grant;
      info.adv_name = c.adv_name;
      info.adv_id = c.adv_id;
      info.frozen = c.frozen;
      info.credit_tier = c.tier;
    } else {
      note(`积分查询失败：${c.error || `code=${c.code}`}`);
    }
  } catch (err) {
    note(`积分查询异常（不影响其它项）：${err.message}`);
  }

  try {
    const m = await generateMaxCount(session, cfg, opts);
    if (m.ok) {
      info.max_count = m.max;
      info.max_count_map = m.map;
    } else {
      note(`并发上限查询失败：code=${m.code}`);
    }
  } catch (err) {
    note(`并发上限查询异常：${err.message}`);
  }

  try {
    const q = await generationQuota(session, cfg, opts);
    if (q.ok) {
      info.daily = q.daily;
      info.reset_ts = q.reset_ts;
      if (q.user_level) info.user_level = q.user_level;
    } else {
      note(`额度查询失败：code=${q.code}`);
    }
  } catch (err) {
    note(`额度查询异常：${err.message}`);
  }

  try {
    const r = await runningCount(session, cfg, opts);
    if (r.ok) info.running_count = r.total;
  } catch (err) {
    note(`在跑任务数查询异常：${err.message}`);
  }

  return info;
}

/** 提交建单。返回 { taskId, draftId, draftInfo, raw }。 */
async function submit(session, cfg, payload, log) {
  const url = `${cfg.origin}${GEN_PATH}?${queryOf(session.device_id)}`;
  const { status, json, text } = await postJson(url, headersOf(session, cfg), payload);
  if (!json || json.code !== 0 || !json.data) {
    // 挂上业务码：提交阶段靠 `isAuthExpired` 认 10001106（那时上游还没建单，
    // 强刷凭据重试一次是安全的）；内容策略码挂上也只是为了归类准确。
    throw failure.tagUpstream(
      new Error(`建单失败：HTTP ${status} code=${json && json.code} ` +
        `message=${json && json.message} ${String(text).slice(0, 240)}`),
      json && json.code, json && json.message);
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

/**
 * 提交 Nano Banana 生图建单（`gen_i2i_image`）。
 *
 * 与视频 submit 的差异只有路径与语义：返回体里 `draft_infos` 是**本次要出的
 * 每一张图**（2026-09-23 实测一次 4 张），条数就是 `expectedDrafts` —— 轮询
 * 以它为完成判据，不写死 4（上游改张数时这里自动跟上）。
 * 返回 { taskId, expectedDrafts, draftIds, raw }。
 */
async function submitImage(session, cfg, payload, log) {
  const url = `${cfg.origin}${GEN_I2I_PATH}?${queryOf(session.device_id)}`;
  const { status, json, text } = await postJson(url, headersOf(session, cfg), payload);
  if (!json || json.code !== 0 || !json.data) {
    throw failure.tagUpstream(
      new Error(`生图建单失败：HTTP ${status} code=${json && json.code} ` +
        `message=${json && json.message} ${String(text).slice(0, 240)}`),
      json && json.code, json && json.message);
  }
  const taskId = json.data.task_id;
  const drafts = json.data.draft_infos || [];
  if (!taskId) throw new Error(`生图建单响应没有 task_id：${String(text).slice(0, 240)}`);
  if (!drafts.length) throw new Error(`生图建单响应没有 draft_infos（一张图都不会出）：${String(text).slice(0, 240)}`);
  if (log) log(`  已建生图单 task=${taskId} · 期望 ${drafts.length} 张图`);
  return { taskId, expectedDrafts: drafts.length, draftIds: drafts.map((d) => d.id), raw: json };
}

/**
 * 生图轮询：直到本次建单的**每一条** draft 都完成并带出图片直链。
 *
 * 完成态（2026-09-23 实测）：`draftTaskStatus=0 && renderTaskStatus=0` 且
 * `previewLink` 非空。实测 27s 全部出片；直链 `x-expires` 约**一年**（不是
 * 视频的小时级），且 CDN **不带 Referer 也 200** —— 所以直链可以放心交给
 * 下游自己下载归档，无需 mirror。
 *
 * 结果 url 取 `previewLink`（`imageSrcSet.origin` 是备胎；coverImage 是同一张）。
 * 失败态与视频一致：`draftTaskStatus=3`，原因在 `generateError*`。
 */
async function pollImage(session, cfg, taskId, expectedDrafts, opts = {}) {
  const {
    timeoutMs = 600000,
    intervalMs = 6000,
    onTick = null,
    log = null,
    fetchImpl = null,
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

    const { json } = await postJson(url, headersOf(session, cfg), HISTORY_BODY, fetchImpl);
    const elapsed = Math.round((Date.now() - started) / 1000);

    if (!json || json.code !== 0) {
      if (json && json.code === LOGIN_REQUIRED_CODE) {
        throw failure.tagUpstream(
          new Error('会话在轮询期间失效（10001106 Login Required）—— 需要刷新 cookie'),
          LOGIN_REQUIRED_CODE);
      }
      if (log) log(`  +${elapsed}s 轮询异常 code=${json && json.code} ${String(json && json.message).slice(0, 70)}`);
      await sleep(intervalMs);
      continue;
    }

    const items = ((json.data || {}).draft_infos || [])
      .filter((x) => x.taskId === taskId);

    // 终态失败优先判：任一条 draft 失败，整单按失败处理（上游按张计费，
    // 失败的 draft 不扣 —— 报错文案里带上成功张数方便对账）。
    const failed = items.find((x) => Number(x.draftTaskStatus) === 3);
    if (failed) {
      const reason = failed.generateErrorMessage || failed.errorMsg || '上游未给出原因';
      const code = failed.generateErrorCode || failed.errorCode || '';
      const okCount = items.filter((x) => Number(x.draftTaskStatus) === 0).length;
      throw failure.upstreamFailure(code, `${reason}（该单 ${okCount}/${expectedDrafts} 张已成功，失败的张数不扣额度）`);
    }

    const done = items.length >= expectedDrafts
      && items.every((x) => Number(x.draftTaskStatus) === 0
        && (x.previewLink || (x.imageSrcSet || {}).origin || x.coverImage));
    const sig = `${items.length}/${items.map((x) => `${x.draftTaskStatus}`).join('')}`;
    if (sig !== lastSig) {
      if (log) log(`  +${elapsed}s 图 ${items.length}/${expectedDrafts} · 状态 ${sig}`);
      lastSig = sig;
    }
    if (done) {
      const urls = items.map((x) => x.previewLink || (x.imageSrcSet || {}).origin || x.coverImage);
      return {
        taskId,
        urls,
        draftIds: items.map((x) => x.id),
        elapsedSec: elapsed,
        raw: items,
      };
    }

    await sleep(intervalMs);
  }

  const err = new Error(`本地生图轮询超时（>${Math.round(timeoutMs / 1000)}s）`);
  err.localTimeout = true;
  throw err;
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
    // 与其它几个函数一致：让调用方能换掉 fetch。
    // 这里不是为了代理，而是为了**能拿真解析代码跑失败分支** ——
    // 「draftTaskStatus=3 时到底抛出了什么」是本次改造的核心，不能只靠桩来证明。
    fetchImpl = null,
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

    const { json } = await postJson(url, headersOf(session, cfg), HISTORY_BODY, fetchImpl);
    const elapsed = Math.round((Date.now() - started) / 1000);

    if (!json || json.code !== 0) {
      if (json && json.code === LOGIN_REQUIRED_CODE) {
        throw failure.tagUpstream(
          new Error('会话在轮询期间失效（10001106 Login Required）—— 需要刷新 cookie'),
          LOGIN_REQUIRED_CODE);
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
    //
    // ⚠️ 抛的是**结构化**错误：`upstreamCode` 与 `upstreamMessage` 分开挂。
    //    号池要靠这个码把「内容不合规」与「会话过期」「节点掉线」区分开 ——
    //    三者现在的呈现完全一样，而处置方式完全不同（前者重发必再失败且照扣额度）。
    //    码拼进 message 只是为了让日志可读；分类**不许**去正则抠 message。
    if (Number(me.draftTaskStatus) === 3) {
      const reason = me.generateErrorMessage || me.errorMsg || vi.Message || '上游未给出原因';
      const code = me.generateErrorCode || me.errorCode || '';
      throw failure.upstreamFailure(code, reason);
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

  // 本地放弃等了 —— 这不是上游拒绝，上游可能还在闷头生成。
  // 打上 `localTimeout` 免得被 `lib/failure.js` 归类成内容策略类失败。
  const err = new Error(`本地轮询超时（>${Math.round(timeoutMs / 1000)}s）`);
  err.localTimeout = true;
  throw err;
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

/** 下载生成图（直链一年有效；Referer 带上无妨，实测不带也 200）。 */
async function downloadImage(url, cfg) {
  const res = await fetch(url, {
    headers: {
      'user-agent': cfg.userAgent,
      referer: cfg.referer,
      accept: 'image/*,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`成图下载失败 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  GEN_PATH,
  GEN_I2I_PATH,
  HISTORY_PATH,
  HISTORY_BODY,
  LOGIN_REQUIRED_CODE,
  CREDIT_PATH,
  MAXCOUNT_PATH,
  TASKCOUNT_PATH,
  QUOTA_PATH,
  QUOTA_STRATEGIES,
  QUOTA_SOURCE,
  headersOf,
  probeSession,
  creditAccount,
  generateMaxCount,
  runningCount,
  generationQuota,
  collectAccountInfo,
  submit,
  submitImage,
  selectBest,
  videoArea,
  poll,
  pollImage,
  download,
  downloadImage,
  sleep,
};
