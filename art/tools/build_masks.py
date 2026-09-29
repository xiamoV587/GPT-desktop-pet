"""重新生成点击判定遮罩 src/masks.js 和图标（替换立绘后运行：python art/tools/build_masks.py）"""
import numpy as np, glob, os, base64, json
from PIL import Image
masks = {}
for f in sorted(glob.glob('assets/sprites/*.png')):
    im = Image.open(f); W, H = im.size
    a = np.asarray(im.convert('RGBA'))[..., 3]
    s = 4; w, h = W // s, H // s
    small = np.asarray(Image.fromarray(a).resize((w, h), Image.BOX)) > 40
    ys, xs = np.nonzero(a > 40)
    masks[os.path.basename(f)[:-4]] = {'w': w, 'h': h, 'scale': s, 'data': base64.b64encode(np.packbits(small.flatten()).tobytes()).decode(),
        'bbox': [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]}
open('src/masks.js', 'w').write('// 自动生成：精灵图的点击判定遮罩（1/4 分辨率）\n'
    '(function(g){g.PET_MASKS=' + json.dumps(masks) + ';})(typeof window!=="undefined"?window:globalThis);\n')
face = Image.open('assets/sprites/idle.png').crop((110, 0, 334, 224)).resize((256, 256), Image.LANCZOS)
face.save('assets/icon.png'); face.resize((32, 32), Image.LANCZOS).save('assets/tray.png')
face.save('assets/icon.ico', sizes=[(256, 256), (64, 64), (48, 48), (32, 32), (16, 16)])
print('ok')
