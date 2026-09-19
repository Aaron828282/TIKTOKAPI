'use strict';
/**
 * 号池 agent 通道客户端 —— 严格对齐 `server/app/agent_gateway.py` 的契约。
 *
 * 号池侧一共四个端点，全部要求 `Authorization: Bearer <agent_token>`，
 * 且令牌为空时整条通道 503（fail closed，不会退化成「无需鉴权」）：
 *
 *   GET  /api/v1/agent/stats          自检
 *   POST /api/v1/agent/claim          取活
 *   POST /api/v1/agent/heartbeat      续命
 *   POST /api/v1/agent/result         回报（终态只从这里进）
 *   GET  /api/v1/agent/task/{id}      查任务是否还被需要
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
  };
}

module.exports = { createClient, PoolError, buildAgent };
