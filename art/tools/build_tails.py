"""
尾巴摆动权重图（每张立绘单独一张，灰度 = 该像素跟着尾巴转动的比例）
  - 尾巴区域：原立绘 与 art/layers/<名字>_notail_keyed.png（去掉尾巴的补画版，只用来找出尾巴在哪）的差异
  - 从尾巴根部（和裙子相连处）到尖端，权重从 0 渐变到 1 → 根部完全不动，和衣服的交界处不会被拉开
  - 区域向外扩几个像素再柔化，过渡带落在尾巴外侧的背景/头发上，而不是切在尾巴本体上
输出：assets/rig/tails/<名字>.png 以及 assets/rig/tails/tails.js（根部坐标）
运行：在 pet 目录下 python3 art/tools/build_tails.py
"""
import json, os, numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

SP = 'assets/sprites/'; LY = 'art/layers/'; OUT = 'assets/rig/tails/'
os.makedirs(OUT, exist_ok=True)
IDLE_POLY = [(314,284),(346,288),(364,318),(362,350),(347,379),(319,395),(286,402),(288,386),(316,371),(333,352),(337,333),(324,323),(309,318),(303,300)]
# 名字: (去尾补画来源, 尾巴范围, 根部坐标)
CFG = {
  'idle':    ('idle',    {'poly': IDLE_POLY}, (310, 388)),
  'blink':   ('idle',    {'poly': IDLE_POLY}, (310, 388)),
  'smug':    ('smug',    {'xmin': 295},       (312, 393)),
  'shy':     ('shy',     {'xmin': 290, 'ymin': 296}, (321, 391)),
  'happy':   ('happy',   {'xmin': 292},       (318, 393)),
  'starve':  ('starve',  {'xmin': 298},       (323, 390)),
  'thirsty': ('thirsty', {'xmin': 298},       (322, 390)),
  'angry':   ('angry',   {'xmin': 302},       (322, 390)),
  'weak':    ('weak',    {'xmin': 305},       (311, 393)),
}
load = lambda p: np.asarray(Image.open(p).convert('RGBA')).astype(np.float32) / 255
yy, xx = np.mgrid[0:420, 0:444].astype(np.float32)
meta = {}
for name, (src, zone_cfg, base) in CFG.items():
    a = load(SP + name + '.png'); b = load(LY + src + '_notail_keyed.png')
    d = np.abs(a[..., :3] * a[..., 3:] - b[..., :3] * b[..., 3:]).sum(2) + np.abs(a[..., 3] - b[..., 3])
    if 'poly' in zone_cfg:
        pm = Image.new('L', (444, 420), 0); ImageDraw.Draw(pm).polygon(zone_cfg['poly'], fill=255)
        zone = ndimage.binary_dilation(np.asarray(pm) > 0, iterations=10); thr = 0.06
    else:
        zone = np.zeros(d.shape, bool); zone[zone_cfg.get('ymin', 250):398, zone_cfg['xmin']:] = True; thr = 0.12
    m = (d > thr) & zone
    m[370:, 372:] = False   # 右下角的发卷不是尾巴
    m = ndimage.binary_closing(m, iterations=3); m = ndimage.binary_fill_holes(m); m = ndimage.binary_opening(m, iterations=2)
    lab, n = ndimage.label(m); sizes = ndimage.sum(m, lab, range(1, n + 1)); m = lab == (np.argmax(sizes) + 1)
    m = ndimage.gaussian_filter(m.astype(np.float32), 1.2) > 0.5
    # 外扩 4px 后柔化：过渡带在尾巴外侧
    soft = ndimage.gaussian_filter(ndimage.binary_dilation(m, iterations=4).astype(np.float32), 2.5)
    soft = np.clip(soft * 1.25, 0, 1)
    ys, xs = np.nonzero(m)
    L = float(np.sqrt((xs - base[0]) ** 2 + (ys - base[1]) ** 2).max())
    dist = np.sqrt((xx - base[0]) ** 2 + (yy - base[1]) ** 2)
    t = np.clip((dist - 0.28 * L) / (0.72 * L), 0, 1); ramp = t * t * (3 - 2 * t)   # 根部 28% 完全不动
    w = soft * ramp
    Image.fromarray((w * 255).round().astype(np.uint8), 'L').save(OUT + name + '.png')
    meta[name] = {'base': list(base)}
    print(name, 'len', round(L), 'max w', round(float(w.max()), 2))
open(OUT + 'tails.js', 'w').write('window.PET_TAILS = ' + json.dumps(meta) + ';\n')
