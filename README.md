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
# 1) 全部离线自测（不联网、不需要任何凭据、零额度消耗）
npm run selftest
#    sigv4 7/7 · session 36 项 · offline 5 场景 23 项

# 2) 拿会话凭据（TikTok 广告线登录态）—— 见下一节
node tools/from-curl.js --in curl.txt
#    → 写出 session.json，并打印要填进 RH_SESSION_JSON 的 base64

# 3) 只验会话（换 cookie 后跑这个，秒出、不花额度）
node preflight.js --session-only

# 4) 上线前置验收（机器体检 + 号池链路 + TikTok 链路 + 会话 + 交付路径）
node preflight.js --token "$RH_AGENT_TOKEN"
#    → 必检项全过才算可以上

# 5) 起服务
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

## 拿会话凭据 —— 号池控制台（推荐）或 `RH_SESSION_JSON`

它不是「一串 API key」，而是**一个已登录浏览器会话的完整快照**。
唯一的来源是：**在一台已登录广告线 Creative Studio 的浏览器里抓一条真请求**。
（怎么抓、为什么不能用 `document.cookie`，见下面「三步」。）

★ **2026-09-20 起，这份凭据的持有者是号池，不再必须写在这个节点上。**

| | 老做法 | 现在 |
|---|---|---|
| 凭据放在哪 | 节点的 `RH_SESSION_JSON` 环境变量 | 号池数据库（加密落盘） |
| 换 cookie 的动作 | 改托管面板 → **重新部署** | 控制台粘一下就生效（**几秒内**） |
| 节点如何拿到 | 启动时读一次，改了就重启 | 按版本号**按需索取**，热切换 |

为什么值得搬：广告线 TTL 只有 **3 天**（下面那张表），也就是「换 cookie」是
每 3 天一次的**日常动作**。把高频动作绑在低频流程（改面板 + 重部署）上，
一定会出现「嫌麻烦，拖一拖」—— 然后全量任务以 `10001106` 失败。

### 怎么用

```
号池控制台 →「TikTok 会话凭据」→ 粘贴 → 保存
```

粘贴框认四种输入，**推荐 Copy as cURL 的原文**（只有它带得到 httpOnly 的
`sessionid_ads`）；纯 cookie 串 / JSON / base64(JSON) 也认。
服务端会当场体检并拒绝坏输入，不会「尽力而为」地存一份假凭据。

节点侧对应的三个旋钮（见 `.env.example`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `RH_SESSION_SOURCE` | `auto` | `auto` 号池优先、env 兜底；`pool` 只认号池；`env` 老行为 |
| `RH_SESSION_REFRESH_SECONDS` | `600` | 多久问一次「变了没」（命中版本号时只回几百字节） |
| `RH_SESSION_PROBE_SECONDS` | `21600` | 验活间隔。拉到**新**凭据时会立刻验活，不等定时 |

`/status` 里的 `session_origin` 一眼告诉你现在用的是哪一份：

- `"cache"` —— 号池控制台那份（**换 cookie 去控制台**）
- `"env"` —— 本地环境变量那份（**换 cookie 去托管面板**）

这两个地方的处置路径完全不同，所以刻意分成两个值、不合并。

### 为什么 `pool` 模式不回落环境变量

`RH_SESSION_SOURCE=pool` 时，号池没配就是**任务失败**，不会偷偷用本地那份。
两种凭据并存时，「我以为在控制台换了，其实节点还在用旧的」会变成常态，
而且**没有任何报错**。要的就是「唯一可判」。

同理，节点也**不会**把「号池没配」和「号池报错」混为一谈：

| 号池回应 | 节点处置 |
|---|---|
| `configured:false`（没配） | 正常降级到 env（`auto` 模式），日志有告警 |
| 5xx / 网络不通（报错） | **保留手上那份继续用**，只告警 —— 网络抖一下不该让本地空手 |
| 下发的东西结构不对 | **不覆盖**本地那份好的（坏凭据不能挤走好凭据） |

### 三步（别手抄）

```bash
# 1) 浏览器：登录 ads.tiktok.com → 打开 Creative Studio（图生视频那个页面）
# 2) DevTools → Network → 筛 creative_bff_i18n
#    → 点任意一条请求 → 右键 → Copy → **Copy as cURL (bash)**
#    → 直接粘进号池控制台的粘贴框（推荐）
#      或粘进 ./curl.txt 走下面的本地转换
# 3) 本地转换（可选：想先自己看一眼就懂）
node tools/from-curl.js --in curl.txt
#    → 写出 session.json（0600），并打印可粘贴的 base64
```

转换器会把下面这些一次性挑出来，不需要你手工对齐：

| 字段 | 从哪取 | 必需 |
|---|---|---|
| `cookie` | `cookie:` 请求头原文（**含 httpOnly**） | ✅ |
| `x_csrftoken` | `x-csrftoken` 头；没有就从 cookie 的 `csrftoken=` 补 | ✅ |
| `device_id` | URL 里的 `device_id=` / `did=` 查询参数 | ✅ |
| `x_fp_id` | `x-fp-id` 头（实测可省，有就带上） | — |
| `user_agent` | `user-agent` 头（建议与真实浏览器版本一致） | — |

### 🔴 为什么不能用 `document.cookie`

`document.cookie` **读不到 httpOnly**，而身份层认的 `sessionid_ads` 正是 httpOnly。
在 Console 里 `copy(document.cookie)` 会得到一份「看着很长、其实少了关键几项」的
假凭据 —— 它不会当场报错，而是在**第一次出片**时才以 `10001106 Login Required`
的形式炸出来，很容易被误判成「刚取的就过期了」。Copy as cURL 是 DevTools 从网络层
导出的，**包含 httpOnly**，这才是真凭据。
（`from-curl.js` 与号池控制台**都会**替你检查 `sessionid_ads` 在不在，缺了就拒绝。）

### ⏰ 它是**耗材**：广告线 3 天，通用线 180 天

| cookie | 声明 TTL | 属于 |
|---|---|---|
| `sid_guard` | `15551999` 秒 ≈ **180 天** | 通用登录态（号池**不认**） |
| `sid_guard_ads` | `259200` 秒 = **3 天** | **广告线登录态（号池认这个）** |

所以「多久换一次」不是策略问题，是硬约束：
`from-curl.js` 会直接告诉你还剩几小时，号池控制台与节点的启动日志、`/status` 的
`session_lifetime` 也会报 —— **剩不足 12 小时就开始告警**，别等它变成 `10001106`。

### 谁在验活

号池在北京，`ads.tiktok.com` 的 DNS 被污染成 `2001::1`，它**自己验不了**这份 cookie。
所以控制台上「有效 / 已失效」的结论**只能由节点给**：节点拿到凭据后会发一枪空体请求
（不消耗额度），把业务码回报给号池（`POST /api/v1/agent/session/report`）。

没有这条回报，控制台最多显示「已配置」—— 而「已配置、其实是死的」正是最坏的状态：
界面全绿，订单一来就 `10001106`。

### 安全

这份 cookie 等同**账号控制权**（含 `tt_ticket_guard_client_data` 里的 EC 私钥）。
`curl.txt` / `session.json` 都已在 `.gitignore` 里，**别提交、别贴聊天记录**。
号池侧是**加密落盘**的（Fernet，`RH_SECRET_KEY`），日志只记「版本号 + 剩余寿命 +
cookie 键数」，**不记凭据值** —— 节点日志与 `/status` 同理。
换 cookie 的副作用是旧会话不一定立刻失效 —— 想彻底踢掉旧的，去后台「登出所有设备」。


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
| `RH_POOL_CA_FILE` 或 `RH_POOL_INSECURE` | 号池 443 是 IP 自签证书，二选一。仓库里已带 `certs/pool-ca.crt`；Docker 镜像里默认就是 `/app/certs/pool-ca.crt` |
| `RH_SESSION_SOURCE` | 凭据来源：`auto`（默认，号池优先 + env 兜底）/ `pool`（只认号池）/ `env`（老行为） |
| `RH_SESSION_REFRESH_SECONDS` | 多久问一次号池「凭据变了没」，默认 `600` |
| `RH_SESSION_PROBE_SECONDS` | 验活间隔，默认 `21600`（6h）。**拉到新凭据时立刻验活**，不等定时 |

**可选**（`RH_SESSION_SOURCE=env`，或号池还没配时的兜底）：

| 变量 | 说明 |
|---|---|
| `RH_SESSION_JSON` | TikTok 登录态 `{cookie, x_csrftoken, device_id}`，原样或 base64（可带可选字段 `x_fp_id` / `user_agent`，会原样透传） |
| `RH_SESSION_FILE` | 同上，给一个文件路径（本地调试用） |
| `RH_SESSION_BACKEND` | 用哪个 backend 的凭据，留空 = `RH_BACKENDS` 的第一个 |

交付路径必填一项：`RH_MIRROR_URL`（`RH_OUTPUT_MODE` 默认就是 `mirror`）。

> ⚠️ `agent_token` 为空时号池会回 **503 `AGENT_DISABLED`** —— 它刻意 fail closed，
> 不会退化成「谁都能拉活」。

## 目录

```
index.js            入口：HTTP 服务 + 取活循环（含取消检测、交付、回报）
preflight.js        上线前置验收（配置 / 机器 / 号池 / TikTok / 会话 / 交付）
                    --session-only 只跑会话那段（换 cookie 后秒验）
tools/from-curl.js  「Copy as cURL」→ session.json + RH_SESSION_JSON 的 base64
selftest/offline.js 离线集成自测：假号池 + 假上游，把 index.js 的编排真跑一遍
selftest/session.js 会话层断言（cookie 解析 / 寿命推算 / 三档判定）
selftest/sessionpool.js
                    会话凭据「号池持有 → 节点索取」的离线自测
                    （协议分支 + 真进程接线 + 泄漏扫描）
selftest/probe-stub.js
                    上游探活打桩（`node -r` 预加载），让离线测试不碰 ads.tiktok.com
selftest/boot.js    自测入口（把上游 I/O 换成假的，再加载真的 index.js）
selftest/fake-*.js  假上游 / 假参考图上传
lib/config.js       配置（全部来自环境变量）+ 配置自检
lib/session.js      会话解析与寿命推算（纯函数，工具与运行时共用一份）
lib/sessioncache.js 运行时会话缓存（按 backend 存当前那份 + 号池版本号）
lib/sessionruntime.js
                    会话运行时：向号池取 / 验活 / 回报 / 10001106 强刷重试
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

### 收件端还没上线时，能验到哪一步

分三档，可以逐档推进 —— **第一档不需要任何 TikTok 凭据**：

| 阶段 | 需要配的东西 | 能证明什么 |
|---|---|---|
| ① 链路验收 | `RH_AGENT_TOKEN` + `RH_POOL_CA_FILE` | 节点进程活着、能 `claim`/`heartbeat`/`result`、号池看板里这台在线 |
| ② 全链路验收 | 再加 `RH_SESSION_JSON`，并**临时** `RH_OUTPUT_MODE=cdn` | 参考图上传 → 建单 → 出片 → 回报，整条业务链路真的跑通 |
| ③ 生产出片 | 再加 `RH_MIRROR_URL`（收件端上线后切回 `mirror`） | 成品落在自家存储上，下游归档不再撞那三道门 |

② 阶段拿到的是 TikTok CDN 直链 —— 想人工看一眼片子，**必须带 `Referer`** 才下得动：

```bash
curl -H 'Referer: https://ads.tiktok.com/creative/creativestudio/image-to-video' \
     -o out.mp4 '<回报回来的 MainUrl>'
```

验收完就把 `RH_OUTPUT_MODE` 切回 `mirror`（或者干脆删掉这个变量，默认就是 `mirror`）。

## 排障速查

| 现象 | 真实原因 |
|---|---|
| 号池回 503 `AGENT_DISABLED` | 号池 `config.json` 的 `agent_token` 还是空串 |
| 号池回 401 `AGENT_UNAUTHORIZED` | 两侧令牌不一致 |
| 号池回 404 到 `/api/v1/agent/session` | 号池镜像还是**旧版**（没有这条端点）；升级号池即可在控制台换 cookie |
| 自签证书报错 | 装 `RH_POOL_CA_FILE`（推荐）或临时 `RH_POOL_INSECURE=1` |
| 每个任务都失败「未提供会话凭据」 | 号池控制台没配凭据；日志里那句会告诉你去控制台（`auto` 模式的 env 兜底也没配时才这样） |
| 在控制台换了 cookie，但节点好像在跑旧的 | 看 `/status` 的 `session_origin`：`env` = 用的是托管面板里那份，**控制台换了不影响它**。要么清掉 `RH_SESSION_JSON`，要么设 `RH_SESSION_SOURCE=pool` |
| 换了 cookie 半天没生效 | 节点侧 `RH_SESSION_REFRESH_SECONDS`（默认 600s）。想立刻生效就重启节点 |
| 控制台显示「已配置」但一直没验活结论 | 节点还没启动过、或够不到 `ads.tiktok.com`。**号池自己验不了这份 cookie**（DNS 被污染），结论只能由节点回报 |
| 控制台显示「已失效」但你觉得 cookie 是新的 | 看 `verify_note` 里的错误码。`10001106` 才是真失效；其它文案（如超时）属于网络问题，别急着换 |
| 提交时 `10001106`，日志说「重试一次」 | 会话过期；节点会向号池强刷一次再试。**只有提交阶段会重试** —— 轮询阶段重提会重复建单、白烧额度 |
| 交付环节失败「没配 RH_MIRROR_URL」 | 补上；**别指向号池的 `/api/v1/upload`**（那是图片口） |
| 转存 413 / 「超过收件端上限」 | 收件端体积闸门；两边上限要一起抬 |
| 控制台取消了任务，节点照跑到底 | `RH_PEEK_SECONDS=0` 关掉了取消检测（默认 20s 问一次） |
| 看板上同一个 agent 忽上忽下 / 任务被别的执行体抢走 | 这台机器上还跑着**另一个** agent（旧的 Python `agent.py`）。同 hostname 会覆盖登记 —— 先把它停掉 |
| `history` 回 `10001106` | 会话已死（广告线 TTL 只有 3 天），到号池控制台换一份 |
| 刚取到的 cookie 就回 `10001106` | 多半是**用 `document.cookie` 取的** —— 漏了 httpOnly 的 `sessionid_ads`。改用 Copy as cURL（`tools/from-curl.js` 与号池控制台都会替你检查这一项） |
| `from-curl.js` 报「没找到 cookie 请求头」 | 点的是「Copy URL」而不是 **Copy as cURL (bash)** |
| `/status` 的 `session_lifetime.level` 是 `warn` | 广告线会话剩不足 12 小时，该换 cookie 了（此时探活仍然通过） |
| 提交回 `illegal url` | 参考图不在 ibyteimg 上；本节点会自动重传，若仍报错看上传日志 |
| 下载 403 | **没带 `Referer`**，不是链接过期 |
| 取到的片子分辨率偏低 | 别按索引取 `VideoInfos[0]`（那是最低档），要按 `max(W×H)` |
| `ETIMEDOUT` 到某个陌生 IP | 本机 DNS 被污染；确认节点真的在墙外 |
| `/status` 里 `ok:true` 但任务没人领 | 号池侧 `agent_id` 认的是**最近一次 claim 的 agent**；确认控制台「外部后端」面板里这台在线 |

## 当前验证状态

**已离线验证**（不需要任何凭据、不消耗额度）

- `lib/sigv4.js` — 7/7，含 **AWS 官方 ListUsers 向量**（不是自说自话的本地用例）
- `selftest/session.js` — **36 项断言全过**：重复 cookie 键取末值、`x_fp_id`/`user_agent`
  透传、`sid_guard_ads` 的编码/未编码两种形态、过期与「读不出」的处理、`describe()` 的三档
- `selftest/sessionpool.js` — **121 项断言全过**。A 段进程内把协议分支逐条钉住：
  `since` 命中时不重复验活、号池不可达**保留**旧凭据、结构不对的凭据**不覆盖**好的、
  `auto` 回落 env / `pool` 不回落 / `env` 完全不动号池、探活网络故障**不得**回报成失效、
  以及一条**结构守卫**（`withSubmitRetry` 只出现一次、且轮询的 catch 分支里没有重新提交）。
  B 段子进程起真 `index.js` 打假号池，验接线与 `/status` 观测面，并做凭据泄漏扫描
- `selftest/offline.js` — **5 个场景 / 23 项断言全过**，钉住四类「不报错但结果不对」的坏法：
  取消检测没接上、mirror 用了错的任务号、`output_variants` 被压成字符串、体积闸门缺失
- `tools/from-curl.js` — 对合成的 cURL 实跑：广告线样本解析出 8 个 cookie 键并算出
  「还剩 2 天 22 小时」；通用线样本（缺 `sessionid_ads`）正确报错退出（码 2）
- `lib/config.js` 的配置自检 — 逐案例验过 fail-closed（默认 mirror、缺收件端要点到、
  非法模式是致命、会话可选字段透传）
- 全部文件 `node --check` 通过
- `preflight.js` — 经海外出口实跑，必检项全过，并拿到真实业务码
  （`history` → `code=10001106`、`upload-proxy` → 带 `ResponseMetadata` 的 400）；
  新增的 C2 段（会话）经 Clash 代理实跑，直连时正确报 `ETIMEDOUT`（DNS 污染），
  走代理时拿到 `HTTP 401 code=10001106` —— 两条路径的判定都对

**已端到端验证**（真号池进程 ↔ 真节点进程，见号池仓库 `deploy/verify-node-session-e2e.py`）

覆盖 5 段、41 项断言，全程**在节点运行期间**从控制台换凭据：

| 场景 | 证明的事 |
|---|---|
| ① 号池没配 + 本地也没配 | 节点**明确不可用**，日志指向控制台（不是偷偷用本地那份） |
| ② 控制台写入 v1 | 运行中的节点在数秒内自己换上，**没有重启**；`/status`、控制台面板同步可见 |
| ③ 控制台写入 v2 | 版本号自增、节点再次跟上；`uptime` 连续增长 ⟹ **同一个进程** |
| ④ 泄漏扫描 | 凭据值不出现在节点 stdout、`/status`、面板响应里（8 个 sentinel 全 0 命中） |
| ⑤ 带凭据冷启动 | 启动摘要点明「来源 号池控制台」，并报出「还剩多久」 |
| 附加 | 写入新凭据后验活结论**归零**（不被上一份背书）；节点换用后重新验活并回报 |

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
