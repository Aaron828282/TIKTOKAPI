# -*- coding: utf-8 -*-
"""
TikTok「点选两个相同形状」验证码求解器 —— VPS 部署版 v2（2026-09-28）。

v1（影刀方案：Canny+轮廓+灰度SSIM）在真实验证码上连错 6 轮，根因：
  ① 3D 字母带软阴影，Canny 轮廓分裂/粘连；
  ② 灰度 patch 做 SSIM —— 一对「同形」字母颜色不同（紫S vs 土S），
     灰度差异反而拉低同形对的分；「同色不同形」（蓝6 vs 蓝e）却因
     颜色接近拿到虚高分。

v2 改法：
  ① 物体检测 = HSV 饱和度分割（字母是彩色、背景/阴影是低饱和灰白，
     天然分离）+ 连通域，不再用 Canny；
  ② 配对特征 = 二值形状掩码（pad 成方再缩 64×64），Hu 矩（log 变换，
     旋转不变）+ 掩码 SSIM；再叠加镜像容忍（3D 透视翻面）取 min；
  ③ 坐标输出相对**整图**的归一化比例（rel_x/rel_y），调用方按元素
     boundingBox 映射，与截图分辨率/DPR 无关。

依赖刻意只留 opencv-python-headless + numpy。
调试：环境变量 CAP_DEBUG=1 时在 /tmp/capdbg/ 落检测可视化。

用法：python solver.py <图片路径>
输出：stdout 最后一行 JSON：
  {"ok": true, "pair": [i, j], "score": 0.83,
   "points": [{"px":..,"py":..,"rel_x":0.44,"rel_y":0.75}, ...]}
失败：{"ok": false, "reason": "..."}
"""
import json
import os
import sys
import cv2
import numpy as np

DEBUG = os.environ.get('CAP_DEBUG') == '1'
DBG_DIR = '/tmp/capdbg'


# ---------------------------------------------------------------- SSIM（手写）
def _ssim(a, b):
    """单通道 float → SSIM。高斯窗 11x11 sigma=1.5，与 skimage 默认口径一致。"""
    C1 = (0.01 * 255) ** 2
    C2 = (0.03 * 255) ** 2
    mu_a = cv2.GaussianBlur(a, (11, 11), 1.5)
    mu_b = cv2.GaussianBlur(b, (11, 11), 1.5)
    mu_a2, mu_b2 = mu_a * mu_a, mu_b * mu_b
    mu_ab = mu_a * mu_b
    s_a2 = cv2.GaussianBlur(a * a, (11, 11), 1.5) - mu_a2
    s_b2 = cv2.GaussianBlur(b * b, (11, 11), 1.5) - mu_b2
    s_ab = cv2.GaussianBlur(a * b, (11, 11), 1.5) - mu_ab
    num = (2 * mu_ab + C1) * (2 * s_ab + C2)
    den = (mu_a2 + mu_b2 + C1) * (s_a2 + s_b2 + C2)
    return float(np.mean(num / den))


# ---------------------------------------------------------------- 主流程
def load_image(path):
    return cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)


def locate_captcha_region(img):
    """整页截图时自动定位浅色验证码图像块；元素截图则整图即验证码。"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    bg = ((v > 200) & (s < 40)).astype(np.uint8) * 255
    bg = cv2.morphologyEx(bg, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    cnts, _ = cv2.findContours(bg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best, best_area = None, 0
    full = img.shape[0] * img.shape[1]
    for c in cnts:
        x, y, w, hh = cv2.boundingRect(c)
        area = w * hh
        if area > full * 0.85:
            continue  # 整图浅色 → 对元素截图，没有独立块可定位
        if area > best_area and w > img.shape[1] * 0.5 and hh > img.shape[0] * 0.3:
            best, best_area = (x, y, w, hh), area
    return best


def find_objects(img_bgr, region):
    """HSV 饱和度分割 + 连通域。返回 (roi, objs)；objs 每项 (x,y,w,h,mask)。"""
    x0, y0, x1, y1 = region
    roi = img_bgr[y0:y1, x0:x1]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    s, v = hsv[:, :, 1].astype(np.int16), hsv[:, :, 2].astype(np.int16)
    # 字母/形状是彩色（S 高）；背景近白（S 低 V 高）、阴影是灰（S 低 V 中低）
    mask = ((s > 55) & (v > 60)).astype(np.uint8) * 255
    # 闭运算把同一字母的笔画连起来；开运算去零星噪点
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    objs = []
    roi_area = mask.size
    for i in range(1, n):
        x, y, w, hh, area = stats[i]
        if area < 150 or w < 12 or hh < 12:
            continue
        if area < roi_area * 0.0012:
            continue
        objs.append((int(x), int(y), int(w), int(hh),
                     (labels == i).astype(np.uint8) * 255))
    return roi, objs


def square_pad(mask):
    """掩码 pad 成正方形（保持形状纵横比，不拉伸）。"""
    h, w = mask.shape[:2]
    side = max(h, w)
    out = np.zeros((side, side), dtype=mask.dtype)
    oy, ox = (side - h) // 2, (side - w) // 2
    out[oy:oy + h, ox:ox + w] = mask
    return out


def hu_desc(mask):
    m = cv2.moments(mask, binaryImage=True)
    hu = cv2.HuMoments(m).flatten()[:7]
    return np.sign(hu) * (-1e-1 - np.log10(np.abs(hu) + 1e-30))


def rotate_mask(m, ang):
    """掩码绕中心旋转 ang 度（保持尺寸，边界补 0）。"""
    h, w = m.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), ang, 1.0)
    return cv2.warpAffine(m, M, (w, h), flags=cv2.INTER_NEAREST)


def pair_score(m1_64, m2_64):
    """旋转+镜像搜索后的最大 IoU —— 直接实现「旋转后同形」的题意。

    Hu 矩对这类带透视的胖 3D 字母分辨力不足（实测紫S配蓝g），
    IoU 在 64×64 二值掩码上区分度显著更高，且计算量可忽略。
    """
    best = 0.0
    variants = [m2_64, m2_64[:, ::-1]]  # 原始 + 镜像（3D 翻面）
    for mv in variants:
        for ang in range(0, 180, 15):
            r = rotate_mask(mv, ang)
            inter = float(np.logical_and(m1_64 > 0, r > 0).sum())
            union = float(np.logical_or(m1_64 > 0, r > 0).sum())
            if union > 0:
                best = max(best, inter / union)
    return best


def main():
    out = {"ok": False, "reason": ""}
    try:
        src = sys.argv[1]
        img = load_image(src)
        if img is None:
            out["reason"] = "图片解码失败"
            print(json.dumps(out, ensure_ascii=False)); return
        H, W = img.shape[:2]
        box = locate_captcha_region(img)
        region = ((box[0], box[1], box[0] + box[2], box[1] + box[3])
                  if box else (0, 0, W, H))
        roi, objs = find_objects(img, region)
        if DEBUG:
            os.makedirs(DBG_DIR, exist_ok=True)
            base = os.path.splitext(os.path.basename(src))[0]
            vis = roi.copy()
            for k, (x, y, w, hh, _m) in enumerate(objs):
                cv2.rectangle(vis, (x, y), (x + w, y + hh), (0, 0, 255), 2)
                cv2.putText(vis, str(k), (x + 2, y + 18),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 0, 0), 2)
            cv2.imwrite(os.path.join(DBG_DIR, base + '.boxes.png'), vis)
        if len(objs) < 2:
            out["reason"] = f"objects<2 ({len(objs)})"
            print(json.dumps(out, ensure_ascii=False)); return

        # 特征：二值形状掩码（pad 方 → 64×64 float），Hu 矩 + SSIM 用同一掩码
        feats = []
        for (x, y, w, hh, m) in objs:
            m64 = cv2.resize(square_pad(m), (64, 64),
                             interpolation=cv2.INTER_AREA).astype(np.float64) / 255.0
            feats.append((hu_desc(m), m64,
                          (x + w / 2.0, y + hh / 2.0)))

        best_score, best_pair = -1.0, None
        for i in range(len(feats)):
            for j in range(i + 1, len(feats)):
                score = pair_score(feats[i][1], feats[j][1])
                if DEBUG:
                    print(f'# pair {i}-{j}: iou={score:.3f}', file=sys.stderr)
                if score > best_score:
                    best_score, best_pair = score, (i, j)

        i, j = best_pair
        ox, oy = region[0], region[1]
        pts = []
        for k in (i, j):
            cx, cy = feats[k][2]
            px, py = cx + ox, cy + oy
            pts.append({"px": int(px), "py": int(py),
                        "rel_x": round(px / W, 4), "rel_y": round(py / H, 4)})
        out = {"ok": True, "pair": [int(i), int(j)],
               "score": round(best_score, 3), "points": pts}
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        out = {"ok": False, "reason": f"exception: {e}"}
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
