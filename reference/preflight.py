#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
海外执行节点 —— 上线前置验收（preflight）。

在一台**即将承载执行节点**的机器上运行，用一次性回答三个问题：

    A. 这台机器是不是干活的材料？   （Python / 落地国家 / 时钟 / 规格）
    B. 能不能连上号池？             （拉活通道：claim / heartbeat / result）
    C. 能不能连上 TikTok 上游？     （真正的业务链路：bff / upload-proxy / CDN）

设计约束（别改，改了就不是一次能 scp 上去的脚本了）：

  * **纯标准库、单文件、零第三方依赖** —— 裸机 `python3 preflight.py` 直接跑。
  * **绝不下单、绝不花钱** —— 唯一发出的真实业务请求是「空体探活」，
    上游会因为缺参数回一个业务错误码，这恰好证明整条链路是通的。
  * **不写任何凭据到磁盘**，令牌只从命令行/环境变量读，打印时脱敏。

用法：

    # 最基本（直连出网）
    python3 preflight.py

    # 走代理出网（本机调试用；生产节点应当直连）
    python3 preflight.py --proxy http://127.0.0.1:7890

    # 带 agent 令牌，把「号池侧 agent 通道」也一起验了
    python3 preflight.py --agent-token "$AGENT_TOKEN"

    # 带会话，做更深的 cookie 存活探活
    python3 preflight.py --session /opt/tiktok-node/session.json

退出码：0 = 全部必检项通过；1 = 有必检项失败。
"""
from __future__ import annotations

import argparse
import email.utils
import json
import os
import platform
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ---------------------------------------------------------------------------
# 常量
#
# ⚠️ 与 ../../tiktok_i2v_client.py 是同一套契约。能 import 就 import，
#    import 不到才用下面的默认值（保证单文件扔到裸机上也能跑）。
# ---------------------------------------------------------------------------
DEFAULT_ENDPOINT = "https://ads.tiktok.com/creative_bff_i18n/api/cue/i2v/gen_r2v_video"
DEFAULT_REFERER = "https://ads.tiktok.com/creative/creativestudio/image-to-video"
DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")

HISTORY_PATH = "/creative_bff_i18n/api/cue/history/tasks"
HISTORY_URL = ("https://ads.tiktok.com" + HISTORY_PATH +
               "?aid=585599&app_name=creative_aio_client&device_platform=web")
UPLOAD_PROXY_PATH = "/creative/creativestudio/upload-proxy"
CDN_HOST = "p19-creative-tool-sg.ibyteimg.com"

POOL_DEFAULT = "39.96.66.94"

try:
    _ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if _ROOT not in sys.path:
        sys.path.insert(0, _ROOT)
    import tiktok_i2v_client as _tc  # type: ignore
    ENDPOINT = getattr(_tc, "ENDPOINT", DEFAULT_ENDPOINT)
    REFERER = getattr(_tc, "REFERER", DEFAULT_REFERER)
    UA = getattr(_tc, "DEFAULT_UA", DEFAULT_UA)
    CONST_SRC = "tiktok_i2v_client.py"
except Exception:
    ENDPOINT, REFERER, UA = DEFAULT_ENDPOINT, DEFAULT_REFERER, DEFAULT_UA
    CONST_SRC = "内置默认值"

from urllib.parse import urlparse  # noqa: E402

OK, NG, WARN = "[ OK ]", "[FAIL]", "[WARN]"

RESULTS: list = []          # (必需?, 名称, 通过?, 说明)
START = time.time()


def rec(name: str, ok, detail: str = "", required: bool = True) -> bool:
    RESULTS.append((required, name, bool(ok), detail))
    if ok:
        mark = OK
    elif required:
        mark = NG
    else:
        mark = WARN
    print("  %s %-42s %s" % (mark, name, detail))
    return bool(ok)


def head(title: str) -> None:
    print()
    print("-" * 86)
    print(title)
    print("-" * 86)


# ---------------------------------------------------------------------------
# HTTP 底座：显式关掉系统代理，避免被环境变量带偏
# ---------------------------------------------------------------------------
def opener(proxy: str, ctx: ssl.SSLContext):
    handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {})]
    if ctx is not None:
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(*handlers)


STRICT = ssl.create_default_context()
LAX = ssl.create_default_context()
LAX.check_hostname = False
LAX.verify_mode = ssl.CERT_NONE


def call(url: str, *, proxy: str = "", ctx=STRICT, method: str = "GET",
         body: bytes = None, headers: dict = None, timeout: int = 20):
    """返回 (status, text, resp_headers)。HTTPError 也算成功返回，便于读业务码。"""
    h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    if headers:
        h.update(headers)
    if body is not None:
        h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    t0 = time.time()
    try:
        with opener(proxy, ctx).open(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace"), dict(r.headers), time.time() - t0
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        return e.code, raw, dict(e.headers or {}), time.time() - t0
    except Exception as e:
        raise RuntimeError("%s: %s" % (type(e).__name__, e))


def tcp(host: str, port: int, timeout: float = 8.0):
    t0 = time.time()
    s = socket.create_connection((host, port), timeout=timeout)
    s.close()
    return time.time() - t0


def tcp_proxy(host: str, port: int, proxy: str, timeout: float = 10.0):
    """经 HTTP 代理做 CONNECT 隧道，拿回一个已连通的裸 socket。

    ⚠️ 裸 `create_connection` **不认代理**：带 --proxy 跑时如果不走隧道，
    探测结果反映的是「本机直连」而不是「代理出口」，会给出完全错误的结论
    （实测表现：代理明明通，TCP 却报 timed out）。
    """
    p = urlparse(proxy)
    t0 = time.time()
    s = socket.create_connection((p.hostname, p.port), timeout=timeout)
    s.sendall(("CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n\r\n"
               % (host, port, host, port)).encode("ascii"))
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    if b" 200 " not in buf.split(b"\r\n")[0]:
        s.close()
        raise RuntimeError("CONNECT 被拒: %r" % buf.split(b"\r\n")[0][:70])
    return (time.time() - t0), s


def reach(host: str, port: int, proxy: str, timeout: float = 10.0):
    """直连或经代理，统一返回耗时。"""
    if proxy:
        dt, s = tcp_proxy(host, port, proxy, timeout)
        s.close()
        return dt
    return tcp(host, port, timeout)


def resolve(host: str):
    infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    return sorted({i[4][0] for i in infos})


def tls_peer(host: str, proxy: str, timeout: float = 10.0):
    """拿到对端证书的 (CN, notAfter)；走代理时先打 CONNECT 隧道再握手。"""
    ctx = ssl.create_default_context()
    if proxy:
        _, s = tcp_proxy(host, 443, proxy, timeout)
    else:
        s = socket.create_connection((host, 443), timeout=timeout)
    with s:
        with ctx.wrap_socket(s, server_hostname=host) as ss:
            c = ss.getpeercert()
    return dict(x[0] for x in c["subject"]).get("commonName", "?"), c.get("notAfter")


def bad_ip(ip: str) -> bool:
    """污染/内网地址识别。GFW 污染 TikTok 域名时会回 2001::1 这类假地址。"""
    if ip.startswith("2001:") or ip in ("::1", "0.0.0.0"):
        return True
    if ip.startswith(("10.", "127.", "169.254.", "192.168.")):
        return True
    if ip.startswith("172."):
        try:
            return 16 <= int(ip.split(".")[1]) <= 31
        except Exception:
            return True
    return False


# ---------------------------------------------------------------------------
# A. 机器体检
# ---------------------------------------------------------------------------
def part_a(proxy: str) -> None:
    head("A. 机器体检 —— 这台机器是不是干活的材料")

    v = sys.version_info
    rec("Python >= 3.8", v >= (3, 8), "Python %d.%d.%d" % (v[0], v[1], v[2]))

    # 落地国家：决定 TikTok 业务链路的时延与可用性，必须确认不是「以为在美国」
    try:
        st, txt, _, _ = call("http://ip-api.com/json/?fields=status,country,regionName,"
                             "city,isp,org,as,query", proxy=proxy, ctx=LAX, timeout=20)
        info = json.loads(txt)
        if info.get("status") == "success":
            where = "%s / %s / %s" % (info.get("country"), info.get("city"), info.get("as", "")[:28])
            rec("出网公网 IP 落地国家", True, "IP=%s  %s" % (info.get("query"), where))
            # 只提示，不判失败：节点应当在美国，落到别处说明选购时选错机房
            c = (info.get("country") or "").lower()
            rec("落地在美国（节点选型预期）", c in ("united states", "usa"),
                "%s（非美国不影响功能，但 TikTok 上游时延会变）" % info.get("country"),
                required=False)
            PUBLIC_IP[0] = info.get("query")
        else:
            rec("出网公网 IP 落地国家", False, txt[:80], required=False)
    except Exception as e:
        rec("出网公网 IP 落地国家", False, str(e)[:90], required=False)

    # 时钟：cookie 3 天过期靠的是绝对时间，漂移会静默搞坏签名与轮询。
    # ⚠️ 用**只读语义**的 history 端点取 Date，绝不拿提交端点(gen_r2v_video)做探针。
    try:
        _, _, hdrs, _ = call(HISTORY_URL, proxy=proxy, ctx=LAX, method="POST", body=b"{}", timeout=20)
        d = hdrs.get("Date") or hdrs.get("date")
        if d:
            skew = time.time() - email.utils.parsedate_to_datetime(d).timestamp()
            rec("时钟偏移 < 120s", abs(skew) < 120, "偏移 %.1f 秒" % skew)
        else:
            rec("时钟偏移 < 120s", False, "上游未返回 Date 头", required=False)
    except Exception as e:
        rec("时钟偏移 < 120s", False, str(e)[:90], required=False)

    try:
        ncpu = os.cpu_count() or 0
        mem = "?"
        for line in open("/proc/meminfo", encoding="utf-8"):
            if line.startswith("MemTotal"):
                mem = "%.1f GB" % (int(line.split()[1]) / 1048576.0)
                break
        du = os.statvfs("/")
        free = du.f_bavail * du.f_frsize / 1073741824.0
        rec("规格满足最低要求（1 核 1G 起）", ncpu >= 1,
            "%s / CPU %d 核 / 内存 %s / 根分区余 %.1f GB" % (platform.system(), ncpu, mem, free))
    except Exception:
        rec("规格满足最低要求（1 核 1G 起）", True, "非 Linux 或读不到 /proc", required=False)


PUBLIC_IP = [""]


# ---------------------------------------------------------------------------
# B. 节点 -> 号池
# ---------------------------------------------------------------------------
def part_b(pool: str, proxy: str, agent_token: str) -> None:
    head("B. 节点 → 号池 —— 拉活通道（claim / heartbeat / result）")

    host = urlparse("//" + pool).hostname or pool
    port = urlparse("//" + pool).port or 443
    try:
        dt = reach(host, port, proxy)
        rec("TCP 握手 %s:%d" % (host, port), True, "connect=%.3fs%s" % (dt, "（经代理）" if proxy else ""))
    except Exception as e:
        rec("TCP 握手 %s:%d" % (host, port), False, "%s: %s" % (type(e).__name__, e))
        return
    try:
        rec("TCP 握手 :80", reach(host, 80, proxy), "ok")
    except Exception as e:
        rec("TCP 握手 :80", False, str(e)[:60], required=False)

    # HTTP 80：只有加密关掉才过；用来确认「不校验也能通」的兜底路径
    try:
        st, txt, _, el = call("http://%s/api/v1/health" % pool, proxy=proxy, ctx=LAX, timeout=20)
        rec("HTTP  :80  /api/v1/health  → 200", st == 200, "HTTP %s  %.2fs  %s" % (st, el, txt[:70]))
    except Exception as e:
        rec("HTTP  :80  /api/v1/health  → 200", False, str(e)[:90], required=False)

    # HTTPS 443：严格校验必然失败（号池是 IP 自签证书），这一步在验「证书长什么样」
    tls_info = ""
    try:
        st, txt, _, el = call("https://%s/api/v1/health" % pool, proxy=proxy, ctx=LAX, timeout=20)
        rec("HTTPS :443 /api/v1/health  → 200（跳过校验）", st == 200,
            "HTTP %s  %.2fs  %s" % (st, el, txt[:60]))
    except Exception as e:
        rec("HTTPS :443 /api/v1/health  → 200（跳过校验）", False, str(e)[:90])

    try:
        cn, _ = tls_peer(host, proxy)
        tls_info = "CN=%s" % cn
    except ssl.SSLCertVerificationError as e:
        tls_info = "自签/IP 证书，校验失败（预期）"
        rec("HTTPS 严格校验可过", False,
            "%s —— 节点侧需信任 /etc/nginx/certs/rh-pool-ip/fullchain.pem 或改用 http" % str(e)[:50],
            required=False)
    except Exception as e:
        tls_info = str(e)[:60]
    if tls_info:
        rec("号池 TLS 证书信息", True, tls_info, required=False)

    # agent 通道：这是部署完要真正打交道的接口
    if agent_token:
        try:
            st, txt, _, _ = call("https://%s/api/v1/agent/stats" % pool, proxy=proxy, ctx=LAX,
                                 headers={"Authorization": "Bearer " + agent_token}, timeout=20)
            if st == 200:
                try:
                    d = json.loads(txt)
                    be = d.get("external_backends") or d.get("backends") or {}
                    rec("GET /api/v1/agent/stats（带令牌）→ 200", True,
                        "enabled=%s 后端=%s" % (d.get("enabled"), list(be.keys())[:3]))
                except Exception:
                    rec("GET /api/v1/agent/stats（带令牌）→ 200", True, txt[:70])
            elif st == 401:
                rec("GET /api/v1/agent/stats（带令牌）→ 200", False, "401 令牌无效")
            elif st == 503:
                rec("GET /api/v1/agent/stats（带令牌）→ 200", False,
                    "503 —— 号池 config.json 的 agent_token 还是空串，通道整体关闭")
            else:
                rec("GET /api/v1/agent/stats（带令牌）→ 200", False, "HTTP %s %s" % (st, txt[:60]))
        except Exception as e:
            rec("GET /api/v1/agent/stats（带令牌）→ 200", False, str(e)[:90])
    else:
        rec("GET /api/v1/agent/stats（带令牌）→ 200", False, "未提供 --agent-token，跳过", required=False)


# ---------------------------------------------------------------------------
# C. 节点 -> TikTok 上游
# ---------------------------------------------------------------------------
def part_c(proxy: str, session_path: str) -> None:
    head("C. 节点 → TikTok 上游 —— 真正的业务链路")

    host = urlparse(ENDPOINT).hostname

    # DNS：这一步是「国内机」与「海外机」的分水岭
    try:
        ips = resolve(host)
        polluted = [i for i in ips if bad_ip(i)]
        if proxy:
            # 走代理时 DNS 由代理侧解析，本机解析结果只作参考，不参与判定
            rec("解析 %s（本机，仅供参考）" % host, True,
                "→ %s%s" % (", ".join(ips[:3]),
                            "   ⚠ 本机 DNS 已污染（代理解析不受影响）" if polluted else ""),
                required=False)
        else:
            rec("解析 %s" % host, not polluted,
                "→ %s%s" % (", ".join(ips[:3]),
                            "   ⚠ 出现污染/内网地址" if polluted else ""))
            if polluted:
                return
    except Exception as e:
        rec("解析 %s" % host, False, "%s: %s" % (type(e).__name__, e))
        return

    try:
        dt = reach(host, 443, proxy)
        rec("TCP 443 → %s" % host, True, "connect=%.3fs%s" % (dt, "（经代理）" if proxy else ""))
    except Exception as e:
        rec("TCP 443 → %s" % host, False, "%s: %s" % (type(e).__name__, e))
        return

    try:
        sub, exp = tls_peer(host, proxy)
        rec("TLS 握手 + 证书校验", True, "CN=%s  有效期至 %s" % (sub, exp))
    except Exception as e:
        rec("TLS 握手 + 证书校验", False, str(e)[:90])

    # 业务探活：空体打 history，上游必然回业务错误码 —— 这恰好证明链路直达
    try:
        st, txt, _, el = call("https://%s%s?aid=585599&app_name=creative_aio_client&device_platform=web"
                              % (host, HISTORY_PATH), proxy=proxy, ctx=STRICT, method="POST",
                              body=b"{}", headers={"Referer": REFERER, "Origin": "https://%s" % host},
                              timeout=25)
        try:
            code = json.loads(txt).get("code")
            rec("POST %s 可直达" % HISTORY_PATH, True,
                "HTTP %s  %.2fs  code=%s（缺参数回业务码＝链路通）" % (st, el, code))
        except Exception:
            rec("POST %s 可直达" % HISTORY_PATH, st < 500,
                "HTTP %s  %.2fs  %s" % (st, el, txt[:60]))
    except Exception as e:
        rec("POST %s 可直达" % HISTORY_PATH, False, str(e)[:90])

    # 上传代理：不带签名打它，期望 4xx JSON —— 证明路由存在而不是 404/超时
    try:
        st, txt, _, el = call("https://%s%s?Action=ApplyImageUpload&Version=2018-08-01"
                              "&ServiceId=n2703mo9gi&FileSize=45431" % (host, UPLOAD_PROXY_PATH),
                              proxy=proxy, ctx=STRICT,
                              headers={"Referer": REFERER, "Origin": "https://%s" % host}, timeout=25)
        rec("upload-proxy 路由存在", st not in (404, 502, 503),
            "HTTP %s  %.2fs  %s" % (st, el, txt[:60]))
    except Exception as e:
        rec("upload-proxy 路由存在", False, str(e)[:90])

    # CDN：成品下载落点
    try:
        dt = reach(CDN_HOST, 443, proxy)
        rec("CDN %s 可达" % CDN_HOST, True, "connect=%.3fs%s" % (dt, "（经代理）" if proxy else ""))
    except Exception as e:
        rec("CDN %s 可达" % CDN_HOST, False, str(e)[:80], required=False)

    # 会话存活（可选）：空体探活的经典判据
    if session_path and os.path.exists(session_path):
        try:
            sess = json.load(open(session_path, encoding="utf-8"))
            did = str(sess.get("device_id") or "")
            st, txt, _, _ = call(
                "https://%s%s?aid=585599&app_name=creative_aio_client&device_platform=web&did=%s&device_id=%s"
                % (host, HISTORY_PATH, did, did),
                proxy=proxy, ctx=STRICT, method="POST", body=b"{}",
                headers={"Referer": REFERER, "Origin": "https://%s" % host,
                         "x-csrftoken": str(sess.get("x_csrftoken") or ""),
                         "Cookie": str(sess.get("cookie") or "")},
                timeout=25)
            code = json.loads(txt).get("code")
            alive = code != 10001106
            rec("会话 cookie 存活", alive,
                "code=%s %s" % (code, "有效" if alive else "10001106 Login Required → 需刷 cookie"))
        except Exception as e:
            rec("会话 cookie 存活", False, str(e)[:90], required=False)
    else:
        rec("会话 cookie 存活", False, "未提供 --session，跳过", required=False)


# ---------------------------------------------------------------------------
def summary() -> int:
    head("汇总")
    req = [r for r in RESULTS if r[0]]
    bad = [r for r in req if not r[2]]
    warn = [r for r in RESULTS if not r[0] and not r[2]]
    print("  必检 %d 项，通过 %d 项，失败 %d 项；提示项 %d 个；耗时 %.0f 秒"
          % (len(req), len(req) - len(bad), len(bad), len(warn), time.time() - START))
    if bad:
        print()
        print("  未通过：")
        for _, n, _, d in bad:
            print("    %s %s" % (NG, n))
            if d:
                print("         %s" % d)
    print()
    if bad:
        print("  结论：**这台机器还不能上** —— 先解决上面列出的必检项。")
    else:
        print("  结论：**前置验收全部通过，可以开始部署执行节点。**")
        if PUBLIC_IP[0]:
            print("  节点公网 IP = %s（记下来，号池侧要用/放行）" % PUBLIC_IP[0])
    print("  常量来源：%s" % CONST_SRC)
    print("=" * 86)
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="海外执行节点上线前置验收")
    ap.add_argument("--pool", default=os.environ.get("RH_POOL_HOST", POOL_DEFAULT),
                    help="号池地址，形如 39.96.66.94 或 39.96.66.94:443")
    ap.add_argument("--proxy", default=(os.environ.get("PREFLIGHT_PROXY") or ""),
                    help="出网代理，如 http://127.0.0.1:7890；生产节点留空=直连")
    ap.add_argument("--agent-token", default=(os.environ.get("RH_AGENT_TOKEN") or ""),
                    help="号池 config.json 的 agent_token")
    ap.add_argument("--session", default="", help="会话文件路径，做 cookie 存活探活")
    ap.add_argument("--skip-upstream", action="store_true", help="只验号池链路，不碰 TikTok")
    args = ap.parse_args()

    proxy = "" if str(args.proxy).lower() in ("none", "-", "") else args.proxy

    print("=" * 86)
    print("海外执行节点 —— 上线前置验收")
    print("  主机 %s / %s" % (platform.node(), platform.platform()))
    print("  时间 %s（本机）" % time.strftime("%Y-%m-%d %H:%M:%S"))
    print("  出网 %s" % ("代理 " + proxy if proxy else "直连"))
    print("  号池 %s" % args.pool)
    print("=" * 86)

    part_a(proxy)
    part_b(args.pool, proxy, args.agent_token)
    if not args.skip_upstream:
        part_c(proxy, args.session)
    return summary()


if __name__ == "__main__":
    raise SystemExit(main())
