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

# 2) 离线集成自测（假号池 + 假上游，不联网、零额度消耗）
node selftest/offline.js
#    → 5 个场景 / 23 项断言，覆盖取消检测、mirror 标识、变体形状、体积闸门

# 3) 上线前置验收（机器体检 + 号池链路 + TikTok 链路 + 交付路径）
node preflight.js --token "$RH_AGENT_TOKEN"
#    → 必检项全过才算可以上

# 4) 起服务
RH_POOL_URL=https://39.96.66.94 \
RH_AGENT_TOKEN=xxx \
RH_POOL_CA_FILE=certs/pool-ca.crt \
RH_MIRROR_URL=https://<网站域名>/api/relay/assets \
RH_SESSION_JSON="$(cat session.json | base64 -w0)" \
node index.js
```

> 起来之后先看两处：`GET /healthz`（平台探活）与 `GET /status`（自述状态）。
> `/status` 里的 `output_ready` 是 false 就说明交付路径没配好 —— 别等出片才发现。
> 启动日志会先把配置问题一次说全（缺令牌 / 缺会话 / 缺收件端 / 证书没钉），
> 这是这台机器上最直接的排障入口。

> `certs/pool-ca.crt` 已经躺在仓库里，就是号池 443 那张 IP 自签证书（**纯公钥，不是私钥**），
> 用它可以做身份钉死。**不要**图省事用 `RH_POOL_INSECURE=1` —— 那只加密、不验身份，
> 等于给中间人留门。只有在这张证书本身被换掉、一时拿不到新的时才临时用它。

## 在 Hostinger 上部署

1. hPanel → **Web Apps** → 部署 Node.js 应用 → **导入 Git 存储库** → 选本仓库
   （`Aaron828282/TIKTOKAPI`，分支 `main`）。
2. 部署方式选 **从 GitHub 部署**（之后每次 push 自动重新部署）。
3. 启动命令 `node index.js`，Node 版本 **≥ 18**（需要全局 `fetch`）。
4. 在 **环境变量** 里填「必填」那几条（见下表）。
5. 部署完成后访问 `https://<你的域名>/status`，确认：
   - `agent_token_set: true`
   - `session_ready: true`、`session_probe.ok: true`
   - `pool_reachable: true`
   - `output_ready: true`
   四项都对了再去号池控制台看「外部后端」面板里这台节点是否在线。

| 变量 | 值 |
|---|---|
| `RH_POOL_URL` | `https://39.96.66.94` |
| `RH_AGENT_TOKEN` | 号池 `config.json` 里的 `agent_token`（**别写进仓库**） |
| `RH_POOL_CA_FILE` | `certs/pool-ca.crt`（仓库里已带；Docker 镜像里默认就是 `/app/certs/pool-ca.crt`） |
| `RH_SESSION_JSON` | TikTok 登录态 JSON 的 **base64**（面板里塞多行 JSON 很别扭） |
| `RH_MIRROR_URL` | 网站侧收件端点的完整 URL |
| `RH_AGENT_ID` | 建议显式写一个（默认取主机名，托管平台的主机名是随机串，看板上认不出来） |

### Docker 方式（可选）

```bash
docker build -t tiktok-exec-node .
docker run -d --name tiktok-node --restart unless-stopped -p 8080:8080 \
  -e RH_POOL_URL=https://39.96.66.94 \
  -e RH_AGENT_TOKEN=<号池侧同一个值> \
  -e RH_MIRROR_URL=https://<网站域名>/api/relay/assets \
  -e RH_SESSION_JSON="$(cat session.json | base64 -w0)" \
  tiktok-exec-node
```

> 镜像里已经把 `certs/pool-ca.crt` COPY 进去，并把 `RH_POOL_CA_FILE` 默认指到
> `/app/certs/pool-ca.crt` —— 所以 Docker 路径**不必**再传证书相关变量。

## 环境变量

完整清单见 `.env.example`。必填四项：

| 变量 | 说明 |
|---|---|
| `RH_POOL_URL` | 号池地址。**用 IP 字面量** —— IP 不发 SNI，正好绕过阿里云对未备案域名的 SNI 拦截 |
| `RH_AGENT_TOKEN` | 号池 `config.json` 里的 `agent_token`，**两边必须一致** |
| `RH_SESSION_JSON` | TikTok 登录态 `{cookie, x_csrftoken, device_id}`，原样或 base64（可带可选字段 `x_fp_id` / `user_agent`，会原样透传） |
| `RH_POOL_CA_FILE` 或 `RH_POOL_INSECURE` | 号池 443 是 IP 自签证书，二选一。仓库里已带 `certs/pool-ca.crt`；Docker 镜像里默认就是 `/app/certs/pool-ca.crt` |

交付路径必填一项：`RH_MIRROR_URL`（`RH_OUTPUT_MODE` 默认就是 `mirror`）。

> ⚠️ `agent_token` 为空时号池会回 **503 `AGENT_DISABLED`** —— 它刻意 fail closed，
> 不会退化成「谁都能拉活」。

## 目录

```
index.js            入口：HTTP 服务 + 取活循环（含取消检测、交付、回报）
preflight.js        上线前置验收（单文件可跑：配置 / 机器 / 号池 / TikTok / 交付）
selftest/offline.js 离线集成自测：假号池 + 假上游，把 index.js 的编排真跑一遍
selftest/boot.js    自测入口（把上游 I/O 换成假的，再加载真的 index.js）
selftest/fake-*.js  假上游 / 假参考图上传
lib/config.js       配置（全部来自环境变量）+ 配置自检
lib/pool.js         号池 agent 通道客户端（严格对齐 agent_gateway.py）
lib/payload.js      R2V 请求体构造
lib/sigv4.js        AWS SigV4 签名器 + 官方向量自证
lib/upload.js       参考图五步上传（STS → Apply → TOS → Commit → CDN URL）
lib/tiktok.js       提交 / 轮询 / 下载 / 会话探活
certs/pool-ca.crt   号池 443 那张 IP 自签证书（**纯公钥**），用于身份钉死
reference/sigv4.py  SigV4 的 Python 参考实现（lib/sigv4.js 的移植来源）
reference/preflight.py  preflight.js 的 Python 前身
```

## 成品回传 —— 必须走 mirror

TikTok 的 `MainUrl` 有三个坑叠在一起，**「回报直链让下游自己下」这条路是走不通的**：

1. **域名白名单**：下游（生视频网站）的归档只认名单内的域名，TikTok 成片域名
   `v16-ad-creative.tiktokcdn-row.com` 不在其中 → 归档直接抛错；
2. **缺 `Referer` 必 403**：归档请求只带 `Accept`，TikTok CDN 会拒（403 ≠ 链接过期）；
3. **`UrlExpire` 是小时级的**，而归档有重试 → 过期之后重试永久失败。

所以 `RH_OUTPUT_MODE` 默认就是 **`mirror`**，而且这是**故意 fail closed**：
没配 `RH_MIRROR_URL` 时任务会带着一句「要补哪个变量」的报错失败，
而不是把一个下游注定归档不了的直链当成成功交出去。

```
节点 ──带 Referer 下载字节──▶ 收件端（网站侧专用令牌端点）
                                │  X-Relay-Task-Id = 号池任务号
                                └─ 由收件方决定落点 → 回一个稳定 URL
```

- **上传标识必须是「号池任务号」**（= 下游 `generation_jobs.upstream_task_id`）。
  TikTok 侧的任务号下游拿不到，用它落库只会得到孤儿资产。
- **落点由收件方决定** —— 让上传方指定存储路径，等于把别人资产的开写权限交出去。
- `RH_OUTPUT_MODE=cdn` 只为人工验证保留（比如手动看一眼片子）。切过去时 `/status`
  会带 `output_mode=cdn`，日志里也会打一行警告。

## 排障速查

| 现象 | 真实原因 |
|---|---|
| 号池回 503 `AGENT_DISABLED` | 号池 `config.json` 的 `agent_token` 还是空串 |
| 号池回 401 `AGENT_UNAUTHORIZED` | 两侧令牌不一致 |
| 自签证书报错 | 装 `RH_POOL_CA_FILE`（推荐）或临时 `RH_POOL_INSECURE=1` |
| 每个任务都失败「未提供会话凭据」 | `RH_SESSION_JSON` 没配、base64 写坏、或少了必填键 |
| 交付环节失败「没配 RH_MIRROR_URL」 | 补上；**别指向号池的 `/api/v1/upload`**（那是图片口） |
| 转存 413 / 「超过收件端上限」 | 收件端体积闸门；两边上限要一起抬 |
| 控制台取消了任务，节点照跑到底 | `RH_PEEK_SECONDS=0` 关掉了取消检测（默认 20s 问一次） |
| 看板上同一个 agent 忽上忽下 / 任务被别的执行体抢走 | 这台机器上还跑着**另一个** agent（旧的 Python `agent.py`）。同 hostname 会覆盖登记 —— 先把它停掉 |
| `history` 回 `10001106` | 会话已死（广告线 TTL 只有 3 天），刷 cookie |
| 提交回 `illegal url` | 参考图不在 ibyteimg 上；本节点会自动重传，若仍报错看上传日志 |
| 下载 403 | **没带 `Referer`**，不是链接过期 |
| 取到的片子分辨率偏低 | 别按索引取 `VideoInfos[0]`（那是最低档），要按 `max(W×H)` |
| `ETIMEDOUT` 到某个陌生 IP | 本机 DNS 被污染；确认节点真的在墙外 |
| `/status` 里 `ok:true` 但任务没人领 | 号池侧 `agent_id` 认的是**最近一次 claim 的 agent**；确认控制台「外部后端」面板里这台在线 |

## 当前验证状态

**已离线验证**（不需要任何凭据、不消耗额度）

- `lib/sigv4.js` — 7/7，含 **AWS 官方 ListUsers 向量**（不是自说自话的本地用例）
- `selftest/offline.js` — **5 个场景 / 23 项断言全过**，钉住四类「不报错但结果不对」的坏法：
  取消检测没接上、mirror 用了错的任务号、`output_variants` 被压成字符串、体积闸门缺失
- `lib/config.js` 的配置自检 — 逐案例验过 fail-closed（默认 mirror、缺收件端要点到、
  非法模式是致命、会话可选字段透传）
- 全部文件 `node --check` 通过
- `preflight.js` — 经海外出口实跑，必检项全过，并拿到真实业务码
  （`history` → `code=10001106`、`upload-proxy` → 带 `ResponseMetadata` 的 400）

**已在线验证（号池侧）**

- 三款模型（`2000004 / 2000009 / 2000012`）在号池侧全部就位：面板可见、通道 enabled、
  入口按名/按 ID 都能解析、错误值 400、真提交落 `PENDING_AGENT`、
  agent 领到的载荷 `model_id` 与提交的模型一一对应、回报幂等

**尚未验证（需要真实 TikTok 凭据 + 收件端）**

- 端到端跑通一个真实任务（claim → 上传 → 提交 → 出片 → mirror → 回报）
- `lib/upload.js` 的 `SignedHeaders` 取舍与真实服务端是否完全一致
  *（签名算法本身已验证；风险在于服务端是否额外要求某些头进签名。
  若报签名错误，把 `upload.js` 里 `sign()` 调用的 headers 参数补上
  `content-type` 等即可 —— 规范上任何自洽子集都合法）*
