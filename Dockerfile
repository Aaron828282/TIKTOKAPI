# 海外执行节点 —— Docker 部署
#
# 与「Hostinger Web Apps 直接跑 Node」二选一。Docker 的好处是运行时完全可控
# （Node 版本、时区、健康检查都在这里定死），代价是要多维护一份镜像。
#
#   docker build -t tiktok-exec-node .
#   docker run -d --name tiktok-node --restart unless-stopped \
#     -p 8080:8080 \
#     -e RH_POOL_URL=https://39.96.66.94 \
#     -e RH_AGENT_TOKEN=<号池侧同一个值> \
#     -e RH_SESSION_JSON="$(cat session.json | base64 -w0)" \
#     tiktok-exec-node
#
# 证书已内置：certs/pool-ca.crt = 号池 443 那张 IP 自签证书（公钥，非机密），
# 由 RH_POOL_CA_FILE 指过去做身份钉死，**不需要**再开 RH_POOL_INSECURE。
# ⚠️ 号池换证书时，必须把仓库里这份同步换掉，否则所有节点都会连不上。
#
# ⚠️ 时间必须准。cookie 的 3 天有效期靠绝对时间，容器时钟漂了会直接表现为
#    「签名失败 / 会话失效」这种没有堆栈的故障。alpine 默认 UTC，够用。
FROM node:22-alpine

WORKDIR /app

# 零依赖：没有 npm install 这一步，镜像干净且构建秒级
COPY package.json ./
COPY lib ./lib
COPY certs ./certs
COPY index.js preflight.js ./

ENV NODE_ENV=production \
    PORT=8080 \
    RH_POOL_CA_FILE=/app/certs/pool-ca.crt \
    RH_LOG_LEVEL=info

# 不跑 root（node 镜像自带 uid 1000 的 node 用户）
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
