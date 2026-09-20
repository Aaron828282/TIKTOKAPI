'use strict';
/**
 * 走代理的 `fetch` 适配器 —— 给**墙内开发机**验证海外链路用。
 *
 * `lib/tiktok.js` 的只读采集全部吃 `opts.fetchImpl`，契约就是 `fetch` 的形状
 * （返回 `{status, text()}`）。节点在墙外直连，开发机得借代理才够得到
 * `ads.tiktok.com`。走这条路验的是**同一段解析代码** —— 这正是
 * `fetchImpl` 这个口子存在的理由（`preflight.js --proxy` 也是同款用法）。
 *
 * ⚠️ 不要用全局 `fetch` 打代理：Node 的 `fetch`（undici）**不认 `HTTP_PROXY`**，
 *    要支持得额外引依赖包。这里用 curl 换个出口是最省事又最不容易出岔子的做法。
 */
const { spawnSync } = require('node:child_process');

function curlFetch(proxy) {
  return async (url, opts = {}) => {
    const args = ['-sS', '-m', '40', '-w', '\n__HTTP__%{http_code}',
                  '-X', opts.method || 'GET'];
    for (const [k, v] of Object.entries(opts.headers || {})) {
      args.push('-H', `${k}: ${v}`);
    }
    if (proxy) args.push('--proxy', proxy);
    if (opts.body) args.push('--data-binary', '@-');
    args.push(url);

    const p = spawnSync('curl.exe', args, {
      input: opts.body || undefined,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (p.error) throw p.error;
    const out = p.stdout.toString('utf8');
    const i = out.lastIndexOf('\n__HTTP__');
    const status = i >= 0 ? Number(out.slice(i + 9).trim()) || 0 : 0;
    const text = i >= 0 ? out.slice(0, i) : out;
    return { status, text: async () => text };
  };
}

module.exports = { curlFetch };
