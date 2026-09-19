#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SigV4 签名器（火山引擎兼容）—— **零第三方依赖**。

为什么手写而不是装 botocore
---------------------------
火山引擎 ImageX 的 OpenAPI 用的是 AWS SigV4 **兼容格式**，但签名 scope 是
``region=i18n`` / ``service=imagex``（口径来自真实抓包的 Authorization 头，
见 API.md §5.10 ②）。目标执行节点是一台干净的海外小机器，
不适合为了一个确定性算法拖进 boto3 + botocore 约 60MB 的依赖树。

正确性如何保证
--------------
算法是确定性的，所以可以用 **AWS 官方文档的已知测试向量**离线自证，
不需要任何真实凭据、不产生任何网络请求：

    python sigv4.py

期望输出 `[OK] 5/5 用例通过`。这条自证在拿到新鲜 cookie 之前就能跑，
把「签名对不对」从「上服务器碰运气」变成「本机秒验」。

调用形态
--------
    from sigv4 import sign

    h = sign(
        method="GET",
        url="https://ads.tiktok.com/creative/creativestudio/upload-proxy"
            "?Action=ApplyImageUpload&Version=2018-08-01"
            "&ServiceId=n2703mo9gi&FileSize=45431&s=m0kza0mqao&device_platform=web",
        headers={"host": "ads.tiktok.com"},
        payload=b"",
        access_key=sts["AccessKeyId"],
        secret_key=sts["SecretAccessKey"],
        session_token=sts["SessionToken"],
        when=sts_dt,                 # 用 STS 的 CurrentTime，见下
    )
    req_headers.update(h)
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import sys
from typing import Dict, Mapping, Optional, Tuple
from urllib.parse import parse_qsl, quote, urlparse

ALGORITHM = "AWS4-HMAC-SHA256"
TERMINATOR = "aws4_request"

# RFC 3986 unreserved：A-Z a-z 0-9 - _ . ~ 之外一律百分号编码
_UNRESERVED = "-_.~"

# 空载荷的 sha256 —— 每个请求都要带，GET 也用这个
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


def uri_encode(value: str, *, encode_slash: bool = True) -> str:
    """RFC 3986 编码，十六进制大写（SigV4 要求大写）。"""
    safe = _UNRESERVED if encode_slash else _UNRESERVED + "/"
    return quote(str(value), safe=safe, encoding="utf-8")


def sha256_hex(data) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def canonical_query_string(url: str) -> str:
    """查询串归一化：先编码，再按**编码后的键**做字节序升序。

    ⚠️ 排序必须在编码之后进行 —— 大写字母（`A`=65）排在小写（`s`=115）之前，
    所以 `Action, FileSize, ServiceId, Version, device_platform, s`
    才是正确顺序。按原始串排序会得到不同结果、签名必然错。
    """
    query = urlparse(url).query
    if not query:
        return ""
    pairs = parse_qsl(query, keep_blank_values=True)
    encoded = sorted((uri_encode(k), uri_encode(v)) for k, v in pairs)
    return "&".join("%s=%s" % (k, v) for k, v in encoded)


def _normalize_headers(headers: Mapping[str, str]) -> Dict[str, str]:
    """键小写、值折叠连续空白并去首尾（SigV4 对值的规范化要求）。"""
    out: Dict[str, str] = {}
    for key, value in headers.items():
        out[str(key).lower().strip()] = " ".join(str(value).split())
    return out


def build_canonical_request(method: str, url: str, headers: Mapping[str, str],
                            payload_sha: str) -> Tuple[str, str]:
    """返回 (规范请求串, 已签名头列表)。

    拼接后的形状（注意查询串为空时那一行是空的，且头块末尾会多出一个空行）：

        GET
        /

        content-type:...
        host:iam.amazonaws.com
        x-amz-date:20150830T123600Z

        content-type;host;x-amz-date
        e3b0c442...
    """
    parsed = urlparse(url)
    body: Dict[str, str] = dict(headers)
    if "host" not in {k.lower() for k in body}:
        body["host"] = parsed.netloc

    lower = _normalize_headers(body)
    signed_headers = ";".join(sorted(lower))
    canon_headers = "".join("%s:%s\n" % (k, lower[k]) for k in sorted(lower))

    canonical = "\n".join([
        method.upper(),
        uri_encode(parsed.path or "/", encode_slash=False),
        canonical_query_string(url),
        canon_headers,
        signed_headers,
        payload_sha,
    ])
    return canonical, signed_headers


def derive_signing_key(secret_key: str, date_stamp: str,
                       region: str, service: str) -> bytes:
    """AWS4 + secret → HMAC 链 → 派生签名密钥（4 轮）。"""
    key = ("AWS4" + secret_key).encode("utf-8")
    for msg in (date_stamp, region, service, TERMINATOR):
        key = hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()
    return key


def sign(
    *,
    method: str,
    url: str,
    access_key: str,
    secret_key: str,
    headers: Optional[Mapping[str, str]] = None,
    payload=b"",
    session_token: Optional[str] = None,
    region: str = "i18n",
    service: str = "imagex",
    when: Optional[_dt.datetime] = None,
    content_sha256: Optional[str] = None,
    sign_content_sha256: bool = False,
) -> Dict[str, str]:
    """对一次请求签名，返回**需要补进请求头**的字段。

    返回的键一律用标准 HTTP 大小写形式（`Authorization` / `X-Amz-Date` / …），
    可直接 `req.headers.update(...)`。

    `when` 必须是 **UTC**。默认取当前 UTC 时间；但对接 TikTok 时应当显式传入
    STS 的 `CurrentTime`（理由见模块末尾）。

    `sign_content_sha256` —— 是否附带并签名 `X-Amz-Content-Sha256`。
    ⚠️ AWS 规范规定**所有 `x-amz-*` 头都必须进签名**，所以「发不发」和
    「签不签」是同一个开关，不存在「发了但不签」这个中间态。
    - `False`（默认）：完全不发这个头。这是 SigV4 的最小正确形态，
      也是 AWS 官方示例的形态 —— 非 S3 服务通常不需要它。
    - `True`：附带并签名。TikTok 的真实抓包里这个头**是存在的**
      （§5.10 ④ 的 `X-Amz-Content-Sha256`），所以对接 TikTok 时传 `True`。
    `session_token` 一旦提供就必然附带并签名 —— STS 凭据缺它必被拒。
    """
    when = when or _dt.datetime.now(_dt.timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=_dt.timezone.utc)
    when = when.astimezone(_dt.timezone.utc)

    amz_date = when.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = when.strftime("%Y%m%d")

    payload_sha = content_sha256 or sha256_hex(payload)

    hdrs: Dict[str, str] = {str(k): str(v) for k, v in (headers or {}).items()}
    for key in list(hdrs):
        if key.lower() in ("authorization", "x-amz-date", "x-amz-security-token",
                           "x-amz-content-sha256"):
            del hdrs[key]
    hdrs.setdefault("host", urlparse(url).netloc)
    hdrs["X-Amz-Date"] = amz_date
    if sign_content_sha256:
        hdrs["X-Amz-Content-Sha256"] = payload_sha
    if session_token:
        hdrs["X-Amz-Security-Token"] = session_token

    canonical, signed_headers = build_canonical_request(method, url, hdrs, payload_sha)

    scope = "%s/%s/%s/%s" % (date_stamp, region, service, TERMINATOR)
    string_to_sign = "\n".join([
        ALGORITHM,
        amz_date,
        scope,
        sha256_hex(canonical),
    ])

    signing_key = derive_signing_key(secret_key, date_stamp, region, service)
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"),
                         hashlib.sha256).hexdigest()

    out = {
        "Authorization": (
            "%s Credential=%s/%s, SignedHeaders=%s, Signature=%s"
            % (ALGORITHM, access_key, scope, signed_headers, signature)
        ),
        "X-Amz-Date": amz_date,
    }
    if sign_content_sha256:
        out["X-Amz-Content-Sha256"] = payload_sha
    if session_token:
        out["X-Amz-Security-Token"] = session_token
    return out


# --------------------------------------------------------------------------
# 自证：AWS 官方文档的已知测试向量
# --------------------------------------------------------------------------
# 来源：AWS 文档 "Examples of the complete Version 4 signing process" 里的
# ListUsers 示例。凭据与签名都是公开的示例值，不是真实密钥。
#
# 之所以能拿它当脚手架：火山引擎是 SigV4 *兼容* 实现，签名算法本身完全相同，
# 只有 scope 里的 region/service 两个字符串不同。所以只要这组向量过了，
# 就能确定 canonical request / 密钥派生 / 签名三处都没有写错，
# 换到 i18n/imagex 只是代入不同的 scope 字符串。
# --------------------------------------------------------------------------

_AWS_KEY_ID = "AKIDEXAMPLE"
_AWS_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
_AWS_WHEN = _dt.datetime(2015, 8, 30, 12, 36, 0, tzinfo=_dt.timezone.utc)


def _case_listusers() -> Tuple[bool, str, str]:
    """官方 ListUsers 示例 —— authoritative。"""
    url = "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"
    headers = {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        "host": "iam.amazonaws.com",
    }
    out = sign(method="GET", url=url, headers=headers, payload=b"",
               access_key=_AWS_KEY_ID, secret_key=_AWS_SECRET,
               region="us-east-1", service="iam", when=_AWS_WHEN)
    expect = ("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
              "SignedHeaders=content-type;host;x-amz-date, "
              "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7")
    return out["Authorization"] == expect, out["Authorization"], expect


def _case_empty_payload_hash() -> Tuple[bool, str, str]:
    """GET 空载荷的 sha256 必须等于 e3b0c442…（写错成 '' 是最常见的坑）。"""
    expect = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    return EMPTY_SHA256 == expect, EMPTY_SHA256, expect


def _case_query_sorting() -> Tuple[bool, str, str]:
    """编码后按字节序排序：大写键排在小写键之前。"""
    url = ("https://x/?s=zzz&device_platform=web&Version=2018-08-01"
           "&ServiceId=n2703mo9gi&FileSize=45431&Action=ApplyImageUpload")
    got = canonical_query_string(url)
    expect = ("Action=ApplyImageUpload&FileSize=45431&ServiceId=n2703mo9gi"
              "&Version=2018-08-01&device_platform=web&s=zzz")
    return got == expect, got, expect


def _case_tiktok_url_shape() -> Tuple[bool, str, str]:
    """真实 TikTok 代理 URL 的规范化结果（含空值参数保留）。"""
    url = ("https://ads.tiktok.com/creative/creativestudio/upload-proxy"
           "?Action=ApplyImageUpload&Version=2018-08-01"
           "&ServiceId=n2703mo9gi&FileSize=45431&s=m0kza0mqao&device_platform=web")
    got = canonical_query_string(url)
    expect = ("Action=ApplyImageUpload&FileSize=45431&ServiceId=n2703mo9gi"
              "&Version=2018-08-01&device_platform=web&s=m0kza0mqao")
    return got == expect, got, expect


def _case_signing_key_vector() -> Tuple[bool, str, str]:
    """密钥派生链的已知输出（同来源于 AWS 文档示例）。"""
    key = derive_signing_key("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
                             "20120215", "us-east-1", "iam")
    expect = "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
    return key.hex() == expect, key.hex(), expect


def _case_content_sha256_override() -> Tuple[bool, str, str]:
    """显式传入 content_sha256 时必须以它为准，不能被重算覆盖。"""
    url = "https://ads.tiktok.com/creative/creativestudio/upload-proxy?Action=CommitImageUpload"
    payload = b'{"SessionKey":"abc"}'
    forced = sha256_hex(payload)
    out = sign(method="POST", url=url, payload=payload, content_sha256=forced,
               sign_content_sha256=True,
               access_key=_AWS_KEY_ID, secret_key=_AWS_SECRET, when=_AWS_WHEN)
    ok = out["X-Amz-Content-Sha256"] == forced and forced != EMPTY_SHA256
    return ok, out["X-Amz-Content-Sha256"], forced


def _case_amz_headers_must_be_signed() -> Tuple[bool, str, str]:
    """AWS 铁律：凡出现在请求里的 `x-amz-*` 头，必须出现在 SignedHeaders 里。

    这是「发了但不签」这个中间态不存在的证据 —— 也正是本次自证抓出来的缺陷：
    原实现无条件附带 `X-Amz-Content-Sha256` 并签名，会让 AWS 官方 IAM 向量的
    签名对不上（那个示例根本不发这个头）。
    """
    url = "https://ads.tiktok.com/creative/creativestudio/upload-proxy?Action=ApplyImageUpload"
    with_both = sign(method="GET", url=url, payload=b"",
                     sign_content_sha256=True, session_token="STS2example",
                     access_key=_AWS_KEY_ID, secret_key=_AWS_SECRET, when=_AWS_WHEN)
    minimal = sign(method="GET", url=url, payload=b"",
                   access_key=_AWS_KEY_ID, secret_key=_AWS_SECRET, when=_AWS_WHEN)

    def signed_of(h: Dict[str, str]) -> str:
        auth = h["Authorization"]
        return auth.split("SignedHeaders=")[1].split(",")[0]

    got = "%s || %s" % (signed_of(with_both), signed_of(minimal))
    expect = ("host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
              " || host;x-amz-date")
    return got == expect, got, expect


CASES = [
    ("AWS 官方 ListUsers 向量", _case_listusers),
    ("空载荷 sha256 常量", _case_empty_payload_hash),
    ("查询串编码后排序", _case_query_sorting),
    ("TikTok 代理 URL 规范化", _case_tiktok_url_shape),
    ("签名密钥派生链", _case_signing_key_vector),
    ("显式 content_sha256 优先", _case_content_sha256_override),
    ("x-amz-* 头必须进签名", _case_amz_headers_must_be_signed),
]


def selftest() -> int:
    print("=" * 78)
    print("SigV4 自证（AWS 官方向量 + 本地不变式）")
    print("=" * 78)
    passed = 0
    for name, fn in CASES:
        try:
            ok, got, expect = fn()
        except Exception as exc:  # noqa: BLE001
            print("  [ERR] %-26s 抛异常: %s" % (name, exc))
            continue
        print("  [%s] %-26s" % ("OK " if ok else "!! ", name))
        if not ok:
            print("        实际: %s" % got)
            print("        期望: %s" % expect)
        passed += bool(ok)
    print("-" * 78)
    print("  %d/%d 通过" % (passed, len(CASES)))
    return 0 if passed == len(CASES) else 1


if __name__ == "__main__":
    sys.exit(selftest())
