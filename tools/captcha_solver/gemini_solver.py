# -*- coding: utf-8 -*-
"""
TikTok「点选两个相同形状」验证码 —— Gemini VLM 求解器（2026-09-28）。

经典 CV 求解器（solver.py）在真实验证码上配对准确率不足（3D 透视 + 奶白
配色 + 软阴影），改用 VLM 读图：这类「找两个同形物体」对多模态大模型是
简单任务，零训练、对旋转/配色/阴影免疫。

用法：python gemini_solver.py <图片路径>
  环境变量：
    GEMINI_API_KEY   必填（sk- 开头的中转 key 或 Google 原生 key）
    GEMINI_BASE_URL  选填。设了就走 OpenAI 兼容中转（如 https://deepkey.top），
                     不设走 Google 原生 generativelanguage.googleapis.com
    GEMINI_MODELS    逗号分隔模型降级链，默认 gemini-3.1-pro-high
    GEMINI_TIMEOUT   单模型超时秒数，默认 40

输入：任意 png/jpg/webp（Login 流程传的是验证码 IMG 的 data:URI 原图）。
输出：stdout 最后一行 JSON（与 solver.py 契约一致）：
  {"ok": true, "score": < confidence 或 1 >,
   "points": [{"rel_x": 0.44, "rel_y": 0.75}, {"rel_x": .., "rel_y": ..}]}
失败：{"ok": false, "reason": "..."}
"""
import base64
import json
import os
import sys
import urllib.request
import urllib.error

API_KEY = os.environ.get('GEMINI_API_KEY', '')
BASE_URL = os.environ.get('GEMINI_BASE_URL', '').rstrip('/')
MODELS = [m.strip() for m in os.environ.get(
    'GEMINI_MODELS', 'gemini-3.1-pro-high').split(',') if m.strip()]
TIMEOUT = int(os.environ.get('GEMINI_TIMEOUT', '40'))

PROMPT = (
    'This is a captcha image. Find the TWO objects that have the SAME shape '
    '(they may differ in color, size, rotation and perspective - ignore those '
    'differences, judge only the outline shape). '
    'Return ONLY a JSON object, no markdown, no explanation: '
    '{"points": [{"rel_x": <0..1 center of first object / image width>, '
    '"rel_y": <0..1 center / image height>}, '
    '{"rel_x": ..., "rel_y": ...}]}. '
    'Each point must be the center of one of the two matching objects, '
    'coordinates normalized by the image width and height.'
)


def call_openai_compat(model, mime, img_b64):
    """中转站：OpenAI 兼容 /v1/chat/completions，图片走 data URI。"""
    url = BASE_URL + '/v1/chat/completions'
    payload = {
        'model': model,
        'messages': [{
            'role': 'user',
            'content': [
                {'type': 'text', 'text': PROMPT},
                {'type': 'image_url',
                 'image_url': {'url': f'data:{mime};base64,{img_b64}'}},
            ],
        }],
        'max_tokens': 2000,
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={'Authorization': 'Bearer ' + API_KEY,
                 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = json.loads(resp.read().decode())
    return ((data.get('choices') or [{}])[0].get('message') or {}).get('content', '').strip()


def call_gemini_native(model, mime, img_b64):
    """Google 原生 v1beta generateContent。"""
    url = ('https://generativelanguage.googleapis.com/v1beta/models/'
           + model + ':generateContent?key=' + API_KEY)
    payload = {
        'contents': [{
            'parts': [
                {'text': PROMPT},
                {'inline_data': {'mime_type': mime, 'data': img_b64}},
            ],
        }],
        'generationConfig': {'temperature': 0, 'maxOutputTokens': 2000},
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = json.loads(resp.read().decode())
    text = ''
    for cand in data.get('candidates', []):
        for part in cand.get('content', {}).get('parts', []):
            text += part.get('text', '')
    return text.strip()


def call_model(model, mime, img_b64):
    if BASE_URL:
        return call_openai_compat(model, mime, img_b64)
    return call_gemini_native(model, mime, img_b64)


def extract_json(text):
    """从模型输出里抠出第一个 JSON 对象（容忍 ```json 包裹/前后杂文本）。"""
    text = text.replace('```json', '```')
    if '```' in text:
        seg = text.split('```')[1]
    else:
        # 找第一个 { 到最后一个 }
        a, b = text.find('{'), text.rfind('}')
        if a < 0 or b <= a:
            return None
        seg = text[a:b + 1]
    a, b = seg.find('{'), seg.rfind('}')
    if a < 0 or b <= a:
        return None
    try:
        return json.loads(seg[a:b + 1])
    except Exception:
        return None


def main():
    out = {"ok": False, "reason": ""}
    try:
        if not API_KEY:
            out["reason"] = "GEMINI_API_KEY 未配置"
            print(json.dumps(out)); return
        src = sys.argv[1]
        img_bytes = open(src, 'rb').read()
        mime = 'image/png' if img_bytes[:4] == b'\x89PNG' else 'image/webp'
        img_b64 = base64.b64encode(img_bytes).decode()
        last_err = ''
        for model in MODELS:
            try:
                text = call_model(model, mime, img_b64)
            except urllib.error.HTTPError as e:
                last_err = f'{model}: HTTP {e.code} {e.read()[:120]}'
                continue
            except Exception as e:  # noqa: BLE001
                last_err = f'{model}: {e}'
                continue
            obj = extract_json(text)
            pts = (obj or {}).get('points') or []
            good = []
            for p in pts:
                try:
                    rx, ry = float(p['rel_x']), float(p['rel_y'])
                    if 0.0 <= rx <= 1.0 and 0.0 <= ry <= 1.0:
                        good.append({'rel_x': round(rx, 4), 'rel_y': round(ry, 4)})
                except Exception:  # noqa: BLE001
                    pass
            if len(good) == 2:
                print(json.dumps({'ok': True, 'score': 1.0, 'model': model,
                                  'points': good}))
                return
            last_err = f'{model}: 输出无法解析为两个坐标: {text[:150]}'
        out["reason"] = f'all models failed: {last_err}'
        print(json.dumps(out))
    except Exception as e:  # noqa: BLE001
        out["reason"] = f'exception: {e}'
        print(json.dumps(out))


if __name__ == '__main__':
    main()
