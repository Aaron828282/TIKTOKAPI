# TIKTOKAPI — 海外执行节点

替 **api号池**（阿里云北京）执行 **TikTok Creative Studio「Reference to Video」** 任务的执行节点。

## 为什么需要它

号池那台机器**出不了墙**：`ads.tiktok.com` 被 DNS 污染成 `2001::1`，TCP 永久超时。
实测三台国内机器（阿里云北京 / 京东云 / 腾讯云）全部打不通。

**也不该在号池上挂代理** —— 号池承载 UltiVox / Dify / 计费，封机成本远大于收益。

所以把数据面外移：

```
        号池（控制面 · 阿里云北京）                本节点（数据面 · 墙外）
        ┌──────────────────────────┐             ┌──────────────────────────────┐
        │ 落库 PENDING_AGENT        │             │  HTTP 服务（/healthz /status）│
        │ 只排活，不执行            │             │  ＋ 后台取活循环              │
        └────────────┬─────────────┘             └───────────────┬──────────────┘
                     ▲                                           │
                     │  claim / heartbeat / result               │
                     └───────────────────────────────────────────┘
                          **出站拉活** —— 节点不需要开任何入站端口

                                                          │
                                                          ▼
                                    ads.tiktok.com · ibyteimg CDN · tiktokcdn
                                    上传参考图 → 提交 → 轮询 → 下载
```

号池侧的 agent 通道协议**一行都没改**（`server/app/agent_gateway.py` 原样复用），
换的只是「谁在另一端执行」。

## 为什么不用浏览器

早期结论是「必须在已登录的页面上下文里发」——实测**推翻了**：
cookie + `x-creative-source` 直连就能建单、轮询、下载；
参考图也能靠 **AWS SigV4** 自己签着传上去（火山引擎 ImageX 用的是 SigV4 兼容格式）。

浏览器只剩「每 ~3 天刷一次 cookie」这一个用途，而那件事在哪儿做都行。

**收益**：节点从「1–2GB 内存 + 一堆脆弱的选择器」降到 **1 vCPU / 2GB 起的纯 HTTP 小进程**。

## 快速开始

零 npm 依赖 —— 不需要 `npm install`。

```bash
# 1) 签名算法自证（不联网、不需要任何凭据）
node lib/sigv4.js
#    → 7/7 通过

# 2) 上线前置验收（机器体检 + 号池链路 + TikTok 链路）
node preflight.js --token "$RH_AGENT_TOKEN"
#    → 必检 13 项全过才算可以上

# 3) 起服务
RH_POOL_URL=https://39.96.66.94 \
RH_AGENT_TOKEN=xxx \
RH_POOL_INSECURE=1 \
RH_SESSION_JSON="$(cat session.json | base64 -w0)" \
node index.js
```

## 在 Hostinger 上部署

1. hPanel → **Web Apps** → 部署 Node.js 应用 → **导入 Git 存储库** → 选本仓库。
2. 部署方式选 **从 GitHub 部署**（之后每次 push 自动重新部署）。
3. 启动命令 `node index.js`，Node 版本 **≥ 18**（需要全局 `fetch`）。
4. 在 **环境变量** 里填下面「必填」那几条。
5. 部署完成后访问 `https://<你的域名>/status` 看节点自述状态。

### Docker 方式（可选）

```bash
docker build -t tiktok-exec-node .
docker run -d --name tiktok-node --restart unless-stopped -p 8080:8080 \
  -e RH_POOL_URL=https://39.96.66.94 \
  -e RH_AGENT_TOKEN=<号池侧同一个值> \
  -e RH_POOL_INSECURE=1 \
  -e RH_SESSION_JSON="$(cat session.json | base64 -w0)" \
  tiktok-exec-node
```

## 环境变量

完整清单见 `.env.example`。必填四项：

| 变量 | 说明 |
|---|---|
| `RH_POOL_URL` | 号池地址。**用 IP 字面量** —— IP 不发 SNI，正好绕过阿里云对未备案域名的 SNI 拦截 |
| `RH_AGENT_TOKEN` | 号池 `config.json` 里的 `agent_token`，**两边必须一致** |
| `RH_SESSION_JSON` | TikTok 登录态 `{cookie, x_csrftoken, device_id}`，原样或 base64 |
| `RH_POOL_CA_FILE` 或 `RH_POOL_INSECURE` | 号池 443 是 IP 自签证书，二选一 |

> ⚠️ `agent_token` 为空时号池会回 **503 `AGENT_DISABLED`** —— 它刻意 fail closed，
> 不会退化成「谁都能拉活」。

## 目录

```
index.js            入口：HTTP 服务 + 取活循环
preflight.js        上线前置验收（单文件可跑）
lib/config.js       配置（全部来自环境变量）
lib/pool.js         号池 agent 通道客户端（严格对齐 agent_gateway.py）
lib/payload.js      R2V 请求体构造
lib/sigv4.js        AWS SigV4 签名器 + 官方向量自证
lib/upload.js       参考图五步上传（STS → Apply → TOS → Commit → CDN URL）
lib/tiktok.js       提交 / 轮询 / 下载 / 会话探活
reference/sigv4.py  SigV4 的 Python 参考实现（lib/sigv4.js 的移植来源）
reference/preflight.py  preflight.js 的 Python 前身
```

## 成品回传 —— ⚠️ 尚未定案

TikTok 的 `MainUrl` 有两个坑：**必须带 `Referer` 才下得动**（不带 → 403，403 ≠ 过期），
而且**会过期**。所以「直接把它交给下游」是有隐患的。

`RH_OUTPUT_MODE` 提供两条路：

- **`cdn`（默认）** — 原样回报直链 + 变体列表 + 过期时间。最省事，下游自理。
- **`mirror`** — 节点先带 `Referer` 把片子下载下来，再 POST 到 `RH_MIRROR_URL`
  换一个稳定 URL 回来。需要一个接收端。

选哪条取决于下游怎么存归档，**需要业务侧拍板**。

## 排障速查

| 现象 | 真实原因 |
|---|---|
| 号池回 503 `AGENT_DISABLED` | 号池 `config.json` 的 `agent_token` 还是空串 |
| 号池回 401 `AGENT_UNAUTHORIZED` | 两侧令牌不一致 |
| 自签证书报错 | 装 `RH_POOL_CA_FILE`（推荐）或临时 `RH_POOL_INSECURE=1` |
| `history` 回 `10001106` | 会话已死（广告线 TTL 只有 3 天），刷 cookie |
| 提交回 `illegal url` | 参考图不在 ibyteimg 上；本节点会自动重传，若仍报错看上传日志 |
| 下载 403 | **没带 `Referer`**，不是链接过期 |
| 取到的片子分辨率偏低 | 别按索引取 `VideoInfos[0]`（那是最低档），要按 `max(W×H)` |
| `ETIMEDOUT` 到某个陌生 IP | 本机 DNS 被污染；确认节点真的在墙外 |

## 当前验证状态

**已离线验证**

- `lib/sigv4.js` — 7/7，含 **AWS 官方 ListUsers 向量**（不是自说自话的本地用例）
- `preflight.js` — 经海外出口（新加坡）实跑 **必检 13/13 通过**，
  并拿到真实业务码：`history` → `code=10001106`、`upload-proxy` → 带 `ResponseMetadata` 的 400
- 全部文件 `node --check` 通过

**尚未验证（需要真实凭据 + 号池 `agent_token`）**

- 端到端跑通一个真实任务（claim → 上传 → 提交 → 出片 → 回报）
- `lib/upload.js` 的 `SignedHeaders` 取舍与真实服务端是否完全一致
  *（签名算法本身已验证；风险在于服务端是否额外要求某些头进签名。
  若报签名错误，把 `upload.js` 里 `sign()` 调用的 headers 参数补上
  `content-type` 等即可 —— 规范上任何自洽子集都合法）*
