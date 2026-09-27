# -*- coding: utf-8 -*-
"""
TikTok「点选两个相同形状」验证码求解器 —— VPS 部署版。

来源：影刀社区方案（Canny 边缘 + 轮廓筛选 + 相似度配对），2026-09-28 经
真实验证码截图实测改造（本机 F:/api号池/captcha_test/ 实测通过）：

  1. 输入 = Playwright 元素截图文件（中文路径安全：np.fromfile + imdecode）；
  2. 配对 = Hu 矩（log 变换，旋转不变）+ SSIM 混合打分 —— 防止
     「同色不同形」误配（真实验证码里 U/3/V 三个都是蓝色）；
  3. 尺寸/阈值动态化；坐标输出**归一化比例** rel_x/rel_y —— 调用方
     （tiktok_login.js）按元素 boundingBox 映射到任意渲染尺寸。

依赖刻意只留 opencv-python-headless + numpy（scikit-image 的 SSIM 用
~20 行高斯窗实现替代，VPS venv 体积从 ~500MB 降到 ~90MB）。

用法：python solver.py <图片路径>
输出：stdout 最后一行 JSON：
  {"ok": true, "pair": [i, j], "score": 0.83,
   "points": [{"px":..,"py":..,"rel_x":0.44,"rel_y":0.75}, ...]}
失败：{"ok": false, "reason": "..."}
"""
import sys
import cv2
import numpy as np


# ---------------------------------------------------------------- SSIM（手写）
def _ssim(a, b):
    """单通道 uint8 → SSIM。高斯窗 11x11 sigma=1.5，与 skimage 默认口径一致。"""
    C1 = (0.01 * 255) ** 2
    C2 = (0.03 * 255) ** 2
    a = a.astype(np.float64)
    b = b.astype(np.float64)
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


def preprocess(gray):
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    return cv2.Canny(blur, 40, 140)


def find_objects(img_bgr, region):
    x0, y0, x1, y1 = region
    roi = img_bgr[y0:y1, x0:x1]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    edges = preprocess(gray)
    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    objects = []
    roi_area = max(1, (x1 - x0) * (y1 - y0))
    for c in cnts:
        x, y, w, hh = cv2.boundingRect(c)
        if not (15 < w < 200 and 15 < hh < 200):
            continue
        if w * hh < roi_area * 0.0015:
            continue
        patch = roi[y:y + hh, x:x + w]
        hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
        mean_s = hsv[:, :, 1].mean()
        mean_v = hsv[:, :, 2].mean()
        if mean_v > 222 and mean_s < 22:
            continue  # 接近纯背景（高亮低饱和）→ 不是物体
        objects.append((x, y, w, hh))

    # 近邻合并（同一物体被边缘断成两块）
    merged, used = [], [False] * len(objects)
    for i in range(len(objects)):
        if used[i]:
            continue
        rx1, ry1, rw, rh = objects[i]
        bx1, by1, bx2, by2 = rx1, ry1, rx1 + rw, ry1 + rh
        for j in range(i + 1, len(objects)):
            if used[j]:
                continue
            ox, oy, ow, oh = objects[j]
            if (abs((rx1 + rw // 2) - (ox + ow // 2)) < 45
                    and abs((ry1 + rh // 2) - (oy + oh // 2)) < 45):
                bx1, by1 = min(bx1, ox), min(by1, oy)
                bx2, by2 = max(bx2, ox + ow), max(bx2, oy + oh)
                used[j] = True
        merged.append((bx1, by1, bx2 - bx1, by2 - by1))
    return roi, merged


def object_mask(roi, box):
    x, y, w, hh = box
    patch = roi[y:y + hh, x:x + w]
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    s, v = hsv[:, :, 1], hsv[:, :, 2]
    mask = ((v < 218) | (s > 28)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return mask


def hu_desc(mask):
    m = cv2.moments(mask, binaryImage=True)
    hu = cv2.HuMoments(m).flatten()[:7]
    return np.sign(hu) * (-1e-1 - np.log10(np.abs(hu) + 1e-30))


def main():
    out = {"ok": False, "reason": ""}
    try:
        src = sys.argv[1]
        img = load_image(src)
        if img is None:
            out["reason"] = "图片解码失败"
            print(out); return
        H, W = img.shape[:2]
        box = locate_captcha_region(img)
        region = ((box[0], box[1], box[0] + box[2], box[1] + box[3])
                  if box else (0, 0, W, H))
        roi, objs = find_objects(img, region)
        if len(objs) < 2:
            out["reason"] = f"objects<2 ({len(objs)})"
            print(out); return

        feats = []
        for b in objs:
            x, y, w, hh = b
            patch = roi[y:y + hh, x:x + w]
            m = cv2.resize(object_mask(roi, b), (64, 64))
            g = cv2.resize(cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY), (64, 64))
            feats.append((hu_desc(m), g))

        best_score, best_pair = -1.0, None
        for i in range(len(feats)):
            for j in range(i + 1, len(feats)):
                d_hu = float(np.linalg.norm(feats[i][0] - feats[j][0]))
                score = 0.65 * (1.0 / (1.0 + d_hu)) + 0.35 * _ssim(feats[i][1], feats[j][1])
                if score > best_score:
                    best_score, best_pair = score, (i, j)

        i, j = best_pair
        ox, oy = region[0], region[1]
        rw = max(1, region[2] - ox)
        rh = max(1, region[3] - oy)
        pts = []
        for k in (i, j):
            x, y, w, hh = objs[k]
            cx, cy = x + w // 2, y + hh // 2
            pts.append({"px": int(cx + ox), "py": int(cy + oy),
                        "rel_x": round(cx / rw, 4), "rel_y": round(cy / rh, 4)})
        out = {"ok": True, "pair": [int(i), int(j)],
               "score": round(best_score, 3), "points": pts}
        print(out)
    except Exception as e:  # noqa: BLE001
        out = {"ok": False, "reason": f"exception: {e}"}
        print(out)


if __name__ == "__main__":
    main()
