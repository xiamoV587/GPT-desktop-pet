"""
分层：把立绘拆成「身体层」+「尾巴层」
  layers/<名字>_notail_keyed.png：AI 补画的去尾巴版本（已抠图，与原图对齐）
  身体层 = 原画（尾巴位置换成补画内容），尾巴层 = 原画里抠出来的尾巴
  运行：在 pet/art 下 python3 tools/build_layers.py
"""
import json, numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

SP = '../assets/sprites/'; OUT = '../assets/layers/'
# 每张立绘：尾巴大致轮廓（用来限定范围）、尾巴根部（弯曲支点）、共用的补画
# 尾巴范围：idle 用手描轮廓；其他站姿用「裙子右边缘以外」的区域自动提取（x ≥ xmin, y ≥ 250）
# base：尾巴根部（从裙摆后面伸出来的地方），None = 自动取尾巴最下端靠左的点
IDLE_POLY = [(314,284),(346,288),(364,318),(362,350),(347,379),(319,395),(286,402),(288,386),(316,371),(333,352),(337,333),(324,323),(309,318),(303,300)]
CFG = {
  'idle':    {'poly': IDLE_POLY, 'base': (310, 388), 'notail': 'idle'},
  'blink':   {'poly': IDLE_POLY, 'base': (310, 388), 'notail': 'idle'},   # 眨眼图只有眼睛不同，共用待机图的补画
  'smug':    {'xmin': 295, 'notail': 'smug'},
  'shy':     {'xmin': 290, 'ymin': 296, 'notail': 'shy'},
  'happy':   {'xmin': 292, 'notail': 'happy'},
  'starve':  {'xmin': 298, 'notail': 'starve'},
  'thirsty': {'xmin': 298, 'notail': 'thirsty'},
  'angry':   {'xmin': 302, 'notail': 'angry'},
  'weak':    {'xmin': 305, 'notail': 'weak'},
  # sad：双手抱着尾巴，不做尾巴动画；sick：补画改动了头发，不用
}

def load(p): return np.asarray(Image.open(p).convert('RGBA')).astype(np.float32) / 255

meta = {}
for name, c in CFG.items():
    a = load(SP + name + '.png'); b = load('layers/' + c['notail'] + '_notail_keyed.png')
    pa = a[..., :3] * a[..., 3:]; pb = b[..., :3] * b[..., 3:]
    d = np.abs(pa - pb).sum(2) + np.abs(a[..., 3] - b[..., 3])
    if 'poly' in c:
        pm = Image.new('L', (444, 420), 0); ImageDraw.Draw(pm).polygon(c['poly'], fill=255)
        zone = ndimage.binary_dilation(np.asarray(pm) > 0, iterations=10); thr = 0.06
    else:
        zone = np.zeros(d.shape, bool); zone[c.get('ymin', 250):398, c['xmin']:] = True; thr = 0.12   # y<398：不含裙摆下方的描边
    m = (d > thr) & zone
    m = ndimage.binary_closing(m, iterations=3); m = ndimage.binary_fill_holes(m); m = ndimage.binary_opening(m, iterations=2)
    lab, n = ndimage.label(m); sizes = ndimage.sum(m, lab, range(1, n + 1)); m = lab == (np.argmax(sizes) + 1)
    # 边缘平滑
    mf = ndimage.gaussian_filter(m.astype(np.float32), 1.2); m = mf > 0.5
    m = ndimage.binary_dilation(m, iterations=2)   # 把尾巴外圈的白色描边也包进来
    soft = np.clip(ndimage.gaussian_filter(m.astype(np.float32), 0.7) * 1.3, 0, 1)
    # 尾巴层：原画 × 遮罩；身体层：遮罩内换成补画（遮罩略微外扩，保证尾巴挪开后露出的是补画）
    tail = a.copy(); tail[..., 3] *= soft
    grow = np.clip(ndimage.gaussian_filter(ndimage.binary_dilation(m, iterations=3).astype(np.float32), 1.0) * 1.4, 0, 1)[..., None]
    body = a * (1 - grow) + b * grow
    Image.fromarray((np.clip(body, 0, 1) * 255).round().astype(np.uint8), 'RGBA').save(OUT + name + '_body.png')
    Image.fromarray((np.clip(tail, 0, 1) * 255).round().astype(np.uint8), 'RGBA').save(OUT + name + '_tail.png')
    ys, xs = np.nonzero(m)
    if not c.get('base'):
        ymax = ys.max(); sel = ys >= ymax - 10
        c['base'] = (int(xs[sel].min()) + 8, int(ymax) - 6)
    far = float(np.sqrt((xs - c['base'][0]) ** 2 + (ys - c['base'][1]) ** 2).max())
    meta[name] = {'base': [int(v) for v in c['base']], 'len': round(far, 1)}
    print(name, 'tail px', int(m.sum()), 'base', c['base'], 'len', round(far, 1))
    np.save('/home/user/.cache/m_' + name + '.npy', m)
open(OUT + 'layers.js', 'w').write('window.PET_LAYERS = ' + json.dumps(meta) + ';\n')   # 用 JS 而不是 JSON：Electron 的 file:// 下不能 fetch
