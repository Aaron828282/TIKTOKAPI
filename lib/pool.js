'use strict';
/**
 * 号池 agent 通道客户端 —— 严格对齐 `server/app/agent_gateway.py` 的契约。
 *
 * 号池侧的端点，全部要求 `Authorization: Bearer <agent_token>`，
 * 且令牌为空时整条通道 503（fail closed，不会退化成「无需鉴权」）：
 *
 *   GET  /api/v1/agent/stats                自检
 *   POST /api/v1/agent/claim                取活
 *   POST /api/v1/agent/heartbeat            续命
 *   POST /api/v1/agent/result               回报（终态只从这里进）
 *   GET  /api/v1/agent/task/{id}            查任务是否还被需要
 *   GET  /api/v1/agent/session              取会话凭据（带 since 版本号）
 *   POST /api/v1/agent/session/report       回报会话验活结果
 *   POST /api/v1/agent/session/lease        按任务租一个账号（占槽位）
 *   POST /api/v1/agent/session/release      归还槽位
 *   GET  /api/v1/agent/accounts             账号清单（含凭据，**不占槽位**）
 *   POST /api/v1/agent/account/report       回报账号信息快照（积分等）
 *
 * ⚠️ 鉴权头是 `Authorization: Bearer`，**不是** `X-Agent-Token`。
 *    写成后者会被号池的默认拒绝中间件当成普通请求，回一个 401 ——
 *    看现象像是「令牌不对」，其实压根没路由到 agent 通道。
 *
 * ⚠️ 故意用 node:https 而不是全局 fetch
 * 号池 443 挂的是 **IP 自签证书**，要用 `ca` 把身份钉死就得能逐请求控制 TLS。
 * 全局 fetch 的 dispatcher 需要额外依赖包，不值得。另外这里显式声明
 * `Accept-Encoding: identity`，省掉手动解压的麻烦（都是几百字节的小 JSON）。
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

class PoolError extends Error {
  /** status 用于区分「令牌错」(401) 与「通道关闭」(503) —— 两者处置完全不同。 */
  constructor(status, body) {
    const brief = typeof body === 'string' ? body : JSON.stringify(body);
    super(`HTTP ${status}: ${String(brief).slice(0, 300)}`);
    this.name = 'PoolError';
    this.status = status;
    this.body = body;
  }
}

function buildAgent(cfg) {
  if (!String(cfg.poolUrl).startsWith('https')) return null;
  if (cfg.poolInsecure) {
    return new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  }
  if (cfg.poolCaFile) {
    if (!fs.existsSync(cfg.poolCaFile)) {
      throw new Error(`RH_POOL_CA_FILE 指向的证书不存在：${cfg.poolCaFile}`);
    }
    return new https.Agent({ ca: fs.readFileSync(cfg.poolCaFile), keepAlive: true });
  }
  return new https.Agent({ keepAlive: true });
}

function request(cfg, agent, path, { method = 'GET', body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(cfg.poolUrl + path);
    } catch (err) {
      reject(new Error(`号池地址不合法：${cfg.poolUrl}${path} → ${err.message}`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');

    const headers = {
      Authorization: 'Bearer ' + String(cfg.agentToken || ''),
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      'User-Agent': 'tiktok-node/1.0',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }

    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      agent: isHttps ? agent : undefined,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(text || '{}'));
          } catch {
            reject(new PoolError(res.statusCode, text));
          }
        } else {
          let parsed = text;
          try { parsed = JSON.parse(text); } catch { /* 保留原文 */ }
          reject(new PoolError(res.statusCode, parsed));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error(`号池请求超时（${timeout}ms）：${path}`)));
    req.on('error', (err) => {
      // 自签证书是最常见的首次失败，直接把处置写进报错里，省一轮排查
      if (/self-signed|unable to verify|self signed/i.test(err.message)) {
        reject(new Error(
          `${err.message}\n` +
          '  → 号池 443 是 IP 自签证书。二选一：\n' +
          '     a) 把号池的 CA 放到节点上，设 RH_POOL_CA_FILE=/path/pool.crt（推荐）\n' +
          '     b) 临时联调设 RH_POOL_INSECURE=1（只加密、不验身份）'));
        return;
      }
      reject(err);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function createClient(cfg) {
  const agent = buildAgent(cfg);
  const call = (path, opts) => request(cfg, agent, path, opts);

  return {
    /** 通道自检。401 = 令牌不匹配；503 = 号池侧 agent_token 还没配。 */
    stats: () => call('/api/v1/agent/stats', { timeout: 20000 }),

    /**
     * 取活。队列为空时返回 `{ task: null }`（不是错误）。
     *
     * 号池侧把这次调用同时当作「进程还活着」的心跳证据，所以空闲时也要
     * 按 pollSeconds 持续调用 —— 停掉的话控制台会误报离线。
     */
    claim: (agentId, backends) => call('/api/v1/agent/claim', {
      method: 'POST',
      body: { agent_id: agentId, backends },
      timeout: 30000,
    }),

    /**
     * 续命。
     *
     * ⚠️ 号池只接受 `UPLOADING` / `SUBMITTING` / `AGENT_RUNNING` 三个中间态，
     *    **不允许借这个口写终态** —— 终态必须走 result。
     *    状态变化时务必立刻上报（而不是等节流窗口），否则控制台里
     *    「卡在 SUBMITTING 半小时」看不出是在跑还是挂了。
     */
    heartbeat: (taskId, { status = null, progress = null, agentId = null } = {}) => {
      const body = { task_id: taskId };
      if (agentId) body.agent_id = agentId;
      if (status) body.status = status;
      if (progress !== null && progress !== undefined) body.progress = progress;
      return call('/api/v1/agent/heartbeat', { method: 'POST', body, timeout: 20000 });
    },

    /**
     * 回报。成功时 `output_url` **必填**（号池会 400 打回）。
     *
     * 幂等：号池对已有终态的任务直接返回 `already_final`，不会覆盖。
     * 所以「回报超时后重发」是安全的。
     */
    result: (body) => call('/api/v1/agent/result', { method: 'POST', body, timeout: 30000 }),

    /** 查任务是否已被调用方取消/判失败（长任务期间用）。 */
    peek: (taskId) => call(`/api/v1/agent/task/${encodeURIComponent(taskId)}`, { timeout: 20000 }),

    /**
     * 取会话凭据（TikTok 登录态）。
     *
     * `since` = 本地那份的**版本号**（号池自增的，不是本地计数器）。
     * 命中就读作「没变」，号池只回 `{changed:false}` —— **一个字节的 cookie
     * 都不过线**。所以这个接口可以放心高频调（claim 每 8s 一次，顺手搬
     * 几十 KB cookie 才是真的浪费）。
     *
     * 四种返回，节点必须**分别处置**（别把后三种都当失败）：
     *   `configured:false`           号池还没配 → 正常降级，回落本地 env
     *   `changed:false`              本地那份就是最新的 → 什么都不做
     *   `changed:true` + `session`   新的一份 → 写入缓存
     *   抛 `PoolError`               号池连不上/报错 → **故障**，保留旧凭据并告警
     *
     * 最后那个区分是关键：把「没配」当成「报错」会让人以为号池坏了；
     * 把「报错」当成「没配」会静默退到一份过期的本地 cookie，然后出片时才
     * 以 10001106 炸出来。号池侧为此专门用 200 + `configured:false` 而不是 404。
     */
    session: (backend, since = 0, agentId = '') => {
      const q = new URLSearchParams({ backend: String(backend || '') });
      if (since) q.set('since', String(since));
      if (agentId) q.set('agent_id', String(agentId));
      return call(`/api/v1/agent/session?${q.toString()}`, { timeout: 20000 });
    },

    /**
     * 回报会话验活结果。
     *
     * 号池在北京，够不到 `ads.tiktok.com`（DNS 被污染）—— 它**自己验不了**
     * 这份 cookie。所以控制台上「有效 / 已失效」的结论只能由节点给。
     * 缺了这条，看板最多显示「已配置」，而「已配置、其实是死的」正是最坏的
     * 状态：界面全绿，订单一来就 10001106。
     */
    reportSession: (body) => call('/api/v1/agent/session/report', {
      method: 'POST',
      body,
      timeout: 20000,
    }),

    /**
     * 账号池清单（**含凭据**）—— 空闲期只读采集的入口。
     *
     * 为什么需要它：号池够不到 TikTok，控制台上「每个号剩多少积分」只能由
     * 节点采。而节点原本只在 `lease` 那一刻才知道自己拿到了哪个号，于是
     * 「刚加完号、还没跑过任务」的账号积分栏会一直空着。
     *
     * ⚠️ 这条路径**不占槽位**（号池侧只读 `agent_accounts`，不碰 `running`）。
     *    真正跑任务仍然走 `leaseSession`。两条路混用会出现「采集把槽位占满、
     *    任务反而租不到号」。
     */
    accounts: (backend) => call(
      `/api/v1/agent/accounts?backend=${encodeURIComponent(String(backend || ''))}`,
      { timeout: 25000 }),

    /**
     * 回报账号信息快照（积分 / 并发上限 / 广告户名…），与验活结论同一个口。
     *
     * 载荷可以只带一种：
     *   `info`                    只更新快照（**按字段合并**，不报的保留）
     *   `ok` + `code` + `message` 只更新验活结论
     * 两个都给就是一次调用干两件事 —— 采集时通常这么用。
     */
    reportAccount: (body) => call('/api/v1/agent/account/report', {
      method: 'POST',
      body,
      timeout: 25000,
    }),

    /**
     * 按任务租一个账号（**占槽位**）。返回 `{ok, account, session, pool}`。
     *
     * - `ok:false`（no_account）**不是错误**：池子空或全忙 —— 节点该做的是
     *   等一会儿再试，任务在号池侧仍是已认领状态，不能判失败。
     * - 幂等：同一 task_id 再租**返回原账号**（节点重试/网络超时都安全）。
     * - 拿到后必须 `releaseSession` 归还 —— 成功、失败、取消都要调，
     *   漏一次就永久少一个槽位。
     */
    leaseSession: ({ backend, taskId, exclude = [] } = {}) => call('/api/v1/agent/session/lease', {
      method: 'POST',
      body: { backend, task_id: taskId, agent_id: cfg.agentId, exclude },
      timeout: 25000,
    }),

    /**
     * 归还槽位。幂等：重复归还回 `released:false`，不是错误。
     */
    releaseSession: ({ taskId, accountId = null } = {}) => call('/api/v1/agent/session/release', {
      method: 'POST',
      body: { task_id: taskId, agent_id: cfg.agentId, account_id: accountId },
      timeout: 20000,
    }),
  };
}

module.exports = { createClient, PoolError, buildAgent };
