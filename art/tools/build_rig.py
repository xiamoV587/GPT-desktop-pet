"""生成仿 Live2D 用的部件权重贴图（assets/rig/*.png）
每个 rig 输出一张 4 格横排 RGB 图（每格 222x210，即立绘的一半分辨率，不使用 alpha）：
  格1 RGB = 头 H / 前发 F / 左长发 L
  格2 RGB = 右长发 R / 左翼 WL / 右翼 WR
  格3 RGB = 尾巴 T / 裙摆 S / 呆毛 A
  格4 RGB = 瞳孔 E / 流苏 TS / 保留
"""
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
W, H = 444, 420
def poly(pts, blur):
    im = Image.new('L', (W, H), 0); ImageDraw.Draw(im).polygon(pts, fill=255)
    a = np.asarray(im, np.float32) / 255
    return ndimage.gaussian_filter(a, blur) if blur else a
def circle(c, r, blur):
    im = Image.new('L', (W, H), 0); ImageDraw.Draw(im).ellipse([c[0]-r, c[1]-r, c[0]+r, c[1]+r], fill=255)
    return ndimage.gaussian_filter(np.asarray(im, np.float32) / 255, blur)
mirror = lambda pts: [(W - x, y) for x, y in pts]
yy = np.arange(H, dtype=np.float32)[:, None] * np.ones((1, W), np.float32)

TAIL_POLY = [(314,284),(346,288),(364,318),(362,350),(347,379),(319,395),(286,402),(288,386),(316,371),(333,352),(337,333),(324,323),(309,318),(303,300)]

def common():
    m = {}
    # 头：左右放宽到把尖耳朵和耳边的碎发完整包住（否则转头时耳朵会被拉长）
    m['H'] = poly([(112,15),(160,-5),(222,-5),(284,-5),(332,15),(338,108),(354,138),(358,178),(332,198),(290,208),(250,216),(222,218),(194,216),(154,208),(112,198),(86,178),(90,138),(106,108)], 7)
    # 前发（含两侧前发）不单独做动态：和脸一起整体移动，否则会把眼睛上下撕开
    m['F'] = np.zeros((H, W), np.float32)
    hairL = [(30,180),(95,150),(150,168),(150,232),(134,250),(130,318),(160,405),(95,412),(30,392),(22,300)]
    m['L'] = poly(hairL, 9); m['R'] = poly(mirror(hairL), 9)
    # 尾巴：沿轮廓描边，只包含尾巴本身（原来的大框把右手和右侧长发也带着一起摆了）
    m['T'] = poly(TAIL_POLY, 3)
    ramp = np.clip((yy - 300) / 95, 0, 1)
    feet = poly([(182,380),(262,380),(262,420),(182,420)], 5)
    m['S'] = poly([(148,296),(296,296),(352,402),(92,402)], 6) * ramp * (1 - feet)
    m['A'] = poly([(186,-5),(258,-5),(262,46),(198,46)], 4)
    m['E'] = circle((188, 163), 12, 2.5) + circle((256, 163), 12, 2.5)
    # 流苏不单独摆动：原来的流苏框把脸右侧那一缕前发也框进去了，会把右边前发拉动
    m['TS'] = np.zeros((H, W), np.float32)
    return m

def std():
    m = common()
    wl = [(126,198),(172,212),(168,242),(122,252),(98,236)]
    m['WL'] = poly(wl, 5); m['WR'] = poly(mirror(wl), 5)
    # 手臂保护区（袖子 + 手）：长发摆动的模糊边缘会带到左手，造成袖口/手撕裂
    arm = [(124,258),(176,258),(180,300),(166,326),(122,326),(118,296)]
    m['ARM'] = np.maximum(poly(arm, 3), poly(mirror(arm), 3))
    return m, {'wingL': (176, 240), 'wingR': (268, 240)}

def lifted():
    m = common()
    wl = [(-5,150),(40,128),(122,112),(132,150),(116,188),(60,206),(10,184)]
    m['WL'] = poly(wl, 5); m['WR'] = poly(mirror(wl), 5)
    # 举起的手臂（手 + 前臂）：原来一半在头部区域、一半在翅膀区域，摇动时被撕开
    arm = [(94,138),(152,138),(160,186),(184,212),(182,244),(150,238),(122,206),(92,198)]
    m['ARM'] = np.maximum(poly(arm, 3), poly(mirror(arm), 3))
    return m, {'wingL': (126, 146), 'wingR': (318, 146)}

def curl():
    # 盘起来睡觉（躺姿，构图与站姿不同）
    m = common()
    z = np.zeros((H, W), np.float32)
    for k in list(m) + ['WL', 'WR']: m[k] = z   # 躺着的睡姿：部件全部不动，只保留整体呼吸
    return m, {'wingL': (0, 0), 'wingR': (0, 0)}

def dirt_texture(seed=7):
    """污渍贴图：泥点 + 灰斑 + 细小灰尘，越靠下越脏；alpha = 污渍浓度"""
    rng = np.random.default_rng(seed)
    a = np.zeros((H, W), np.float32)
    def blob(cx, cy, r, v):
        yy_, xx_ = np.mgrid[0:H, 0:W]
        a[:] = np.maximum(a, v * np.exp(-(((xx_ - cx) / r) ** 2 + ((yy_ - cy) / (r * rng.uniform(.6, 1.2))) ** 2)))
    for _ in range(38):   # 大块灰斑，集中在裙摆、腿、手臂
        cy = rng.uniform(150, 415) if rng.random() < .8 else rng.uniform(60, 200)
        blob(rng.uniform(70, 374), cy, rng.uniform(7, 20), rng.uniform(.35, .8))
    for c in [(196, 182), (250, 186)]:   # 脸颊两小块
        blob(c[0] + rng.uniform(-6, 6), c[1], 6, .45)
    noise = ndimage.gaussian_filter(rng.random((H, W)).astype(np.float32), 2.2)
    noise = (noise - noise.min()) / (noise.max() - noise.min())
    a *= 0.55 + 0.9 * noise
    speck = (rng.random((H, W)) > 0.998).astype(np.float32)          # 灰尘点
    speck = ndimage.gaussian_filter(ndimage.binary_dilation(speck, iterations=1).astype(np.float32), .7) * 1.6
    a = np.clip(a + speck * (0.4 + 0.6 * (yy / H)), 0, 1)
    col = np.dstack([np.full((H, W), 112), np.full((H, W), 88), np.full((H, W), 70)]).astype(np.uint8)
    return Image.fromarray(np.dstack([col, (a * 255).astype(np.uint8)]), 'RGBA')

def pack(m):
    # 互斥处理：尾巴、翅膀区域不跟长发一起转
    m['R'] = m['R'] * (1 - m['T']) * (1 - m['WR'] * 0.7)
    m['L'] = m['L'] * (1 - m['WL'] * 0.7)
    m['H'] = np.minimum(m['H'], 1)
    # 头部区域内长发让位，保证头整体刚性移动
    m['L'] = m['L'] * (1 - m['H']); m['R'] = m['R'] * (1 - m['H'])
    # 长发的模糊边缘盖到了裙子、右下饰品圈和尾巴上：头发一摆就把它们拉歪/撕开 → 裙子和尾巴范围内长发权重清零
    front = (poly([(148,296),(296,296),(352,402),(92,402)], 0) > 0.5) | (poly(TAIL_POLY, 0) > 0.5)
    front = np.clip(ndimage.gaussian_filter(ndimage.binary_dilation(front, iterations=4).astype(np.float32), 3) * 1.3, 0, 1)
    m['L'] = m['L'] * (1 - front); m['R'] = m['R'] * (1 - front)
    # 裙摆和尾巴的接缝：尾巴根部压在裙摆右缘上，裙摆平移会把接缝拉开 → 尾巴附近裙摆逐渐不动
    tail_band = ndimage.gaussian_filter(ndimage.binary_dilation(poly(TAIL_POLY, 0) > 0.5, iterations=8).astype(np.float32), 6)
    m['S'] = m['S'] * (1 - np.clip(tail_band * 1.3, 0, 1))
    # 右下的饰品圈圈 + 上面的链子/流苏：整体刚性平移（取圈圈中心的裙摆权重），不被纵向渐变拉歪
    orn = np.clip(circle((280, 375), 15, 2) + poly([(256,294),(274,294),(293,362),(272,368)], 2), 0, 1)
    m['S'] = m['S'] * (1 - orn) + orn * m['S'][375, 280]
    # 手臂保护区内所有部件权重清零：手臂跟身体一起刚性不动
    if 'ARM' in m:
        keep = 1 - np.clip(m['ARM'], 0, 1)
        for k in ('H', 'L', 'R', 'WL', 'WR', 'S', 'T'): m[k] = m[k] * keep
    # 只用 RGB 三个通道（alpha 恒为 255）。之前用 RGBA 四通道时，缩放和 WebGL 上传都会做
    # "预乘 alpha"，导致 alpha 为 0 的地方其余三个通道的权重被清零（左发不动、呆毛/瞳孔失效）
    order = [['H','F','L'], ['R','WL','WR'], ['T','S','A'], ['E','TS', None]]
    tiles = []
    for grp in order:
        ch = [Image.fromarray((np.clip(m[k], 0, 1) * 255).round().astype(np.uint8), 'L').resize((W // 2, H // 2), Image.BILINEAR)
              if k else Image.new('L', (W // 2, H // 2), 0) for k in grp]
        tiles.append(Image.merge('RGB', ch))
    out = Image.new('RGB', (W // 2 * len(order), H // 2))
    for i, t in enumerate(tiles): out.paste(t, (i * W // 2, 0))
    return out

import json
meta = {}
for name, fn in [('std', std), ('lifted', lifted), ('curl', curl)]:
    m, piv = fn()
    pack(m).save(f'assets/rig/{name}.png')
    meta[name] = piv
    # 可视化
    base = Image.open('assets/sprites/' + {'std': 'idle', 'lifted': 'lifted', 'curl': 'sleepcurl'}[name] + '.png').convert('RGBA')
    vis = Image.new('RGBA', base.size, (30, 30, 40, 255)); vis.alpha_composite(base)
    cols = {'H':(255,80,80),'F':(255,200,0),'L':(0,160,255),'R':(0,220,160),'WL':(200,0,255),'WR':(255,0,200),'T':(255,120,0),'S':(120,255,0),'A':(255,255,255),'E':(0,255,255),'TS':(255,0,0)}
    v = np.asarray(vis, np.float32)[..., :3]
    for k, c in cols.items():
        a = np.clip(m[k], 0, 1)[..., None] * 0.45
        v = v * (1 - a) + np.array(c, np.float32) * a
    Image.fromarray(v.astype(np.uint8)).save(f'art/tools/rigvis_{name}.png')  # 部件划分可视化，方便检查
dirt_texture().save('assets/rig/dirt.png')
print(json.dumps(meta))
