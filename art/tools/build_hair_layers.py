"""Build the two-layer hair split for the standing puppet.

Inputs
  assets/sprites/idle.png                       original 444x420 sprite (never modified)
  art/raw/hair_split/gen_body_nohair_v1.png     AI redraw on flat green: character WITHOUT long back hair
  art/raw/hair_split/gen_backhair_v1.png        AI redraw on flat green: complete back hair only, no ahoge
  (both redraws were generated from art/raw/hair_split/ref_green_512.png = idle.png centred on a 512 green square)

Outputs (art/layers/)
  idle_nohair.png / idle_nohair_2x.png          layer A: face, bangs + ahoge, horns, ears, body, wings, tail. No long hair.
  idle_backhair.png / idle_backhair_2x.png      layer B: complete long back hair (no ahoge). Draw BEHIND layer A.
  preview/hair_split_preview_*.png              composite / sway previews

Run from the repo root: python art/tools/build_hair_layers.py
Dependencies: Pillow, numpy, scipy, opencv-python(-headless) (opencv >= 4.4 for SIFT).
"""
from pathlib import Path
import numpy as np
import cv2
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'assets' / 'sprites' / 'idle.png'
RAW = ROOT / 'art' / 'raw' / 'hair_split'
OUT = ROOT / 'art' / 'layers'
PREVIEW = OUT / 'preview'
PREVIEW.mkdir(parents=True, exist_ok=True)

W, H = 444, 420
OX, OY = 34, 46            # offset of the 444x420 canvas inside the 512 square reference
F = 1024                   # working resolution (2x the 512 square)

# Polygons traced on the original 444x420 (same as art/tools/build_parts.py)
HEAD = [(0,0),(443,0),(443,150),(328,150),(336,160),(350,167),(343,174),(328,176),(315,172),(302,169),(292,174),(281,182),
        (272,190),(260,197),(243,202),(222,204),(204,202),(187,197),(175,191),(164,183),(151,175),(139,169),(125,173),(112,177),
        (98,175),(88,169),(106,164),(115,156),(116,148),(0,148)]
BODY = [(205,193),(237,193),(239,205),(253,212),(256,233),(277,239),(286,249),(282,259),(289,272),(305,287),(299,297),(305,302),
        (314,307),(315,311),(309,315),(299,314),(300,319),(293,318),(285,313),(279,308),(274,313),(277,321),(290,343),(307,368),
        (328,389),(343,401),(334,409),(318,413),(277,410),(254,401),(252,419),(188,419),(185,401),(172,407),(145,412),(119,414),
        (104,410),(97,403),(110,393),(128,381),(143,361),(157,338),(172,310),(164,301),(160,309),(154,319),(147,318),(149,311),
        (138,315),(129,313),(129,308),(139,301),(146,297),(143,291),(137,287),(139,280),(155,267),(161,257),(158,250),(163,243),
        (171,236),(185,233),(187,215),(201,207)]
LEFT_WING = [(171,217),(166,221),(164,230),(170,241),(163,248),(156,253),(151,263),(148,265),(144,257),(137,255),(127,260),(120,271),
             (115,266),(108,266),(98,270),(87,278),(80,289),(73,302),(69,300),(75,280),(84,261),(102,245),(123,232),(145,222),(156,215)]
RIGHT_WING = [(444 - x, y) for x, y in LEFT_WING]
TAIL = [(277,328),(283,331),(291,335),(289,338),(300,341),(306,345),(302,348),(311,349),(313,343),(317,337),(322,331),(318,341),
        (317,350),(325,348),(328,349),(330,354),(335,348),(338,342),(341,340),(343,342),(345,334),(345,329),(342,331),(337,330),
        (329,326),(324,322),(320,317),(317,312),(326,316),(322,312),(319,308),(319,304),(326,307),(320,302),(316,296),(313,290),
        (311,285),(317,285),(328,289),(328,287),(337,291),(342,298),(346,304),(348,295),(352,299),(353,305),(353,311),(353,318),
        (355,322),(357,327),(358,333),(360,340),(359,346),(359,350),(357,355),(356,360),(353,365),(350,370),(346,375),(340,380),
        (334,383),(326,386),(316,388),(308,379),(300,367),(292,354),(284,340)]


def poly_f(points):
    im = Image.new('L', (F, F))
    ImageDraw.Draw(im).polygon([((x + OX) * 2, (y + OY) * 2) for x, y in points], fill=255)
    return np.asarray(im) > 0


def ellipse_f(cx, cy, rx, ry):
    yy, xx = np.mgrid[:F, :F]
    return (((xx - (cx + OX) * 2) / (rx * 2)) ** 2 + ((yy - (cy + OY) * 2) / (ry * 2)) ** 2) <= 1.0


def key_green(path, g_bg=200.0, g_lo=25.0):
    """Chroma-key a flat green render -> float RGBA (0..255), un-mixed and de-spilled."""
    rgb = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    if rgb.shape[:2] != (F, F):
        rgb = cv2.resize(rgb, (F, F), interpolation=cv2.INTER_AREA)
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    greenness = G - np.maximum(R, B)
    a = np.clip(1.0 - (greenness - g_lo) / (g_bg - g_lo), 0.0, 1.0)
    bg = np.array([5.0, 248.0, 4.0], np.float32)
    out = rgb.copy()
    m = (a > 0.02) & (a < 0.999)
    am = a[m][:, None]
    out[m] = np.clip((rgb[m] - (1 - am) * bg) / am, 0, 255)
    out[a <= 0.02] = 0
    out[..., 1] = np.minimum(out[..., 1], np.maximum(out[..., 0], out[..., 2]) + 2)   # nothing in the art is green
    a = np.where(a < 8 / 255.0, 0, a)
    return np.dstack([out, a * 255.0])


def reference():
    im = Image.open(SRC).convert('RGBA')
    if im.size != (W, H):
        raise ValueError('Expected 444x420 source')
    c = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
    c.alpha_composite(im, (OX, OY))
    return np.asarray(c.resize((F, F), Image.LANCZOS)).astype(np.float32)


def on_white(rgba):
    a = rgba[..., 3:4] / 255.0
    return (rgba[..., :3] * a + 255 * (1 - a)).astype(np.uint8)


def align(src, dst, label):
    """Similarity transform src->dst from SIFT matches (the redraws are already ~pixel aligned)."""
    g1 = cv2.cvtColor(on_white(src), cv2.COLOR_RGB2GRAY)
    g2 = cv2.cvtColor(on_white(dst), cv2.COLOR_RGB2GRAY)
    sift = cv2.SIFT_create(nfeatures=8000)
    k1, d1 = sift.detectAndCompute(g1, None)
    k2, d2 = sift.detectAndCompute(g2, None)
    matches = cv2.BFMatcher(cv2.NORM_L2).knnMatch(d1, d2, k=2)
    good = [m for m, n in matches if m.distance < 0.75 * n.distance]
    p1 = np.float32([k1[m.queryIdx].pt for m in good])
    p2 = np.float32([k2[m.trainIdx].pt for m in good])
    M, inl = cv2.estimateAffinePartial2D(p1, p2, method=cv2.RANSAC, ransacReprojThreshold=3.0, maxIters=5000, confidence=0.999)
    sc = float(np.hypot(M[0, 0], M[0, 1]))
    print(f'[{label}] inliers={int(inl.sum())} scale={sc:.4f} t=({M[0, 2]:.2f},{M[1, 2]:.2f})')
    if abs(sc - 1) > 0.03 or abs(M[0, 2]) > 12 or abs(M[1, 2]) > 12:
        raise SystemExit(f'{label}: alignment looks wrong, refusing to continue')
    return cv2.warpAffine(src, M, (F, F), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))


def down2(rgba):
    a = rgba[..., 3:4] / 255.0
    pm = np.dstack([rgba[..., :3] * a, a])
    small = cv2.resize(pm, (F // 2, F // 2), interpolation=cv2.INTER_AREA)
    sa = small[..., 3:4]
    rgb = np.where(sa > 1e-4, small[..., :3] / np.maximum(sa, 1e-4), 0)
    return np.dstack([np.clip(rgb, 0, 255), np.clip(sa * 255, 0, 255)]).astype(np.uint8)


def crop_canvas(arr, s):
    return arr[OY * s:(OY + H) * s, OX * s:(OX + W) * s]


def save(arr, path):
    arr = arr.copy()
    arr[arr[..., 3] == 0, :3] = 0
    Image.fromarray(arr, 'RGBA').save(path, optimize=True)


def main():
    ref = reference()
    ref_a = ref[..., 3] / 255.0
    ref_opaque = ref_a > 0.5
    sil = ndi.binary_dilation(ref_a > 0.02, iterations=2)           # original silhouette +1px
    yy = np.mgrid[:F, :F][0]

    A = align(key_green(RAW / 'gen_body_nohair_v1.png'), ref, 'A no-hair -> original')
    B = align(key_green(RAW / 'gen_backhair_v1.png'), ref, 'B back-hair -> original')

    # ---- layer A -------------------------------------------------------------------------------
    aA = A[..., 3] / 255.0
    rgbA = A[..., :3]
    # 1) strip the white sticker border on inner edges (edges that face the hair), keep it on the outer silhouette
    bright = (rgbA.min(axis=2) > 205) & ((rgbA.max(axis=2) - rgbA.min(axis=2)) < 28)
    bg = aA < 0.5
    grow = bg.copy()
    allowed = bright | bg
    for _ in range(9):
        grow = ndi.binary_dilation(grow, iterations=1) & allowed
    border = grow & ~bg
    outer_zone = ndi.binary_dilation(ref_a < 0.02, iterations=7) & (ref_a >= 0.02)
    strip = ndi.gaussian_filter((border & ~outer_zone).astype(np.float32), 0.6)
    aA2 = np.where(sil, aA * (1.0 - np.clip(strip * 1.4, 0, 1)), 0.0)
    # 2) where the redraw is unchanged (face, bangs, dress...) use the original pixels -> the face stays identical
    keep = ndi.binary_erosion(poly_f(HEAD) | poly_f(BODY) | poly_f(TAIL) | poly_f(LEFT_WING) | poly_f(RIGHT_WING), iterations=6)
    pdiff = np.abs(on_white(A).astype(np.float32) - on_white(ref).astype(np.float32)).sum(2)
    w = np.clip((48.0 - pdiff) / 30.0, 0, 1)
    w = ndi.gaussian_filter(np.where(keep & (aA2 > 0.5) & ref_opaque, w, 0.0), 0.7)
    rgbA2 = rgbA * (1 - w[..., None]) + ref[..., :3] * w[..., None]
    # 3) inside the traced body / tail / wing parts the original is the truth (RGB and alpha)
    force = poly_f(BODY) | poly_f(TAIL) | poly_f(LEFT_WING) | poly_f(RIGHT_WING)
    ff = ndi.gaussian_filter((force & ref_opaque).astype(np.float32), 0.7)
    rgbA2 = rgbA2 * (1 - ff[..., None]) + ref[..., :3] * ff[..., None]
    aA2 = np.maximum(aA2, np.where(force, ref_a, 0.0))
    A2 = np.dstack([rgbA2, aA2 * 255.0])

    # ---- layer B -------------------------------------------------------------------------------
    aB = B[..., 3] / 255.0
    A_op = aA2 > 0.5
    V = ndi.binary_erosion((~A_op) & ref_opaque, iterations=3)       # back hair visible in the original
    Vs = V & (aB > 0.98)
    Bm = B[..., :3].copy()
    for c in range(3):                                               # match generated hair colours to the original
        mr, sr = ref[..., c][Vs].mean(), ref[..., c][Vs].std()
        mb, sb = B[..., c][Vs].mean(), B[..., c][Vs].std()
        Bm[..., c] = np.clip((B[..., c] - mb) / max(sb, 1e-3) * sr + mr, 0, 255)
    white = B[..., :3].min(axis=2) > 235
    Bm[white] = B[..., :3][white]
    dome = ellipse_f(222, 135, 112, 92)                              # skull behind the face; excludes horns + ahoge
    allowed_B = sil & (V | dome | (yy >= (150 + OY) * 2))
    aBc = np.where(allowed_B, aB, 0.0)
    hidden = allowed_B & ~V
    inpaint = cv2.inpaint(np.clip(ref[..., :3], 0, 255).astype(np.uint8), (~V).astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA).astype(np.float32)
    dist = ndi.distance_transform_edt(~V)
    w_inp = np.where(hidden, 0.6 * np.clip(1.0 - (dist - 1.0) / 7.0, 0, 1), 0.0)   # thin continuation band under the body edge
    w_vis = ndi.gaussian_filter(V.astype(np.float32), 0.6)
    rgb_hidden = inpaint * w_inp[..., None] + Bm * (1 - w_inp[..., None])
    rgbB2 = ref[..., :3] * w_vis[..., None] + rgb_hidden * (1 - w_vis[..., None])
    aB2 = ref_a * w_vis + np.maximum(aBc, np.where(hidden, ref_a * (w_inp > 0), 0)) * (1 - w_vis)
    aB2 = np.where(allowed_B | V, aB2, 0.0)
    B2 = np.dstack([np.clip(rgbB2, 0, 255), aB2 * 255.0])

    # ---- write ---------------------------------------------------------------------------------
    A1, B1 = crop_canvas(down2(A2), 1), crop_canvas(down2(B2), 1)
    save(A1, OUT / 'idle_nohair.png'); save(B1, OUT / 'idle_backhair.png')
    save(crop_canvas(np.clip(A2, 0, 255).astype(np.uint8), 2), OUT / 'idle_nohair_2x.png')
    save(crop_canvas(np.clip(B2, 0, 255).astype(np.uint8), 2), OUT / 'idle_backhair_2x.png')

    # ---- preview + metric ----------------------------------------------------------------------
    def over(top, bottom):
        ta = top[..., 3:4] / 255.0; ba = bottom[..., 3:4] / 255.0
        oa = ta + ba * (1 - ta)
        rgb = (top[..., :3] * ta + bottom[..., :3] * ba * (1 - ta)) / np.maximum(oa, 1e-6)
        return np.dstack([rgb, oa * 255]).astype(np.uint8)

    def sway(img, dx):
        ramp = np.clip((np.arange(H) - 215) / (395 - 215), 0, 1)
        out = np.zeros_like(img)
        for y in range(H):
            s = int(round(dx * ramp[y]))
            if s >= 0: out[y, s:] = img[y, :W - s]
            else: out[y, :W + s] = img[y, -s:]
        return out

    orig = np.asarray(Image.open(SRC).convert('RGBA')).astype(np.float32)
    comp = over(A1.astype(np.float32), B1.astype(np.float32))
    d = np.abs(on_white(comp.astype(np.float32)).astype(int) - on_white(orig).astype(int))
    print('A over B vs original: MAE %.3f (on white), pixels with diff>40: %d' % (d.mean(), int((d.sum(2) > 40).sum())))
    yy2, xx2 = np.mgrid[:H, :W]
    chk = np.dstack([(((yy2 // 12) + (xx2 // 12)) % 2) * 40 + 200] * 3).astype(np.uint8)
    def onc(x):
        a = x[..., 3:4] / 255.0
        return (x[..., :3] * a + chk * (1 - a)).astype(np.uint8)
    tiles = [onc(orig), onc(A1), onc(B1), onc(comp), onc(over(A1.astype(np.float32), sway(B1, -6).astype(np.float32))),
             onc(over(A1.astype(np.float32), sway(B1, 6).astype(np.float32)))]
    labels = ['original', 'A idle_nohair', 'B idle_backhair', 'A over B', 'sway -6px', 'sway +6px']
    sheet = np.full((H + 24, (W + 8) * len(tiles), 3), 255, np.uint8)
    for i, t in enumerate(tiles):
        sheet[24:, i * (W + 8):i * (W + 8) + W] = t
        cv2.putText(sheet, labels[i], (i * (W + 8) + 4, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)
    Image.fromarray(sheet).save(PREVIEW / 'hair_split_preview_sheet.png')
    print('done ->', OUT)


if __name__ == '__main__':
    main()
