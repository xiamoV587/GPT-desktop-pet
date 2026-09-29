"""Rebuild the standing puppet ONLY from assets/sprites/*.png.

Run anywhere: python art/tools/build_parts.py
Dependencies: Pillow, numpy, scipy, opencv-python-headless.
The source sprites and the old v5 layers are never overwritten.
Masks are hand-traced in the original 444x420 coordinate system.
Occluded pixels are synthesized, not recovered from a layered original.
"""
from pathlib import Path
import json
import hashlib
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage as ndi
import cv2

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'assets' / 'sprites'
OUT = ROOT / 'assets' / 'parts'
OUT.mkdir(parents=True, exist_ok=True)
W, H = 444, 420

def poly(points):
    im = Image.new('L', (W, H)); ImageDraw.Draw(im).polygon(points, fill=255)
    return np.asarray(im) > 0

# Head includes face, bangs, ears and horns. Lower locks remain on the hair mesh.
HEAD = [(0,0),(443,0),(443,150),(328,150),(336,160),(350,167),
        (343,174),(328,176),(315,172),(302,169),(292,174),(281,182),
        (272,190),(260,197),(243,202),(222,204),(204,202),(187,197),
        (175,191),(164,183),(151,175),(139,169),(125,173),(112,177),
        (98,175),(88,169),(106,164),(115,156),(116,148),(0,148)]
# Clothing, bare shoulders, arms, hands, legs, and front skirt.
BODY = [(205,193),(237,193),(239,205),(253,212),(256,233),(277,239),
        (286,249),(282,259),(289,272),(305,287),(299,297),(305,302),
        (314,307),(315,311),(309,315),(299,314),(300,319),(293,318),
        (285,313),(279,308),(274,313),(277,321),(290,343),(307,368),
        (328,389),(343,401),(334,409),(318,413),(277,410),(254,401),
        (252,419),(188,419),(185,401),(172,407),(145,412),(119,414),
        (104,410),(97,403),(110,393),(128,381),(143,361),(157,338),
        (172,310),(164,301),(160,309),(154,319),(147,318),(149,311),
        (138,315),(129,313),(129,308),(139,301),(146,297),(143,291),
        (137,287),(139,280),(155,267),(161,257),(158,250),(163,243),
        (171,236),(185,233),(187,215),(201,207)]
LEFT_WING = [(171,217),(166,221),(164,230),(170,241),(163,248),
             (156,253),(151,263),(148,265),(144,257),(137,255),
             (127,260),(120,271),(115,266),(108,266),(98,270),
             (87,278),(80,289),(73,302),(69,300),(75,280),(84,261),
             (102,245),(123,232),(145,222),(156,215)]
RIGHT_WING = [(444-x,y) for x,y in LEFT_WING]
# Tight contour, including the inner spines. No rectangular right-hand crop.
TAIL = [(277,328),(283,331),(291,335),(289,338),(300,341),(306,345),
        (302,348),(311,349),(313,343),(317,337),(322,331),(318,341),
        (317,350),(325,348),(328,349),(330,354),(335,348),(338,342),
        (341,340),(343,342),(345,334),(345,329),(342,331),(337,330),
        (329,326),(324,322),(320,317),(317,312),(326,316),(322,312),
        (319,308),(319,304),(326,307),(320,302),(316,296),(313,290),
        (311,285),(317,285),(328,289),(328,287),(337,291),(342,298),
        (346,304),(348,295),(352,299),(353,305),(353,311),(353,318),
        (355,322),(357,327),(358,333),(360,340),(359,346),(359,350),
        (357,355),(356,360),(353,365),(350,370),(346,375),(340,380),
        (334,383),(326,386),(316,388),(308,379),(300,367),(292,354),
        (284,340)]

src = np.asarray(Image.open(SRC/'idle.png').convert('RGBA'))
if src.shape != (H,W,4): raise ValueError('Expected 444x420 RGBA source')
alpha = src[:,:,3]
head = poly(HEAD) & (alpha>0)
yy,xx=np.mgrid[:H,:W]
body_zone = poly(BODY) | ((yy>=385)&(xx>=101)&(xx<=341))
body_zone = ndi.binary_dilation(body_zone, iterations=1)
body = body_zone & ~head & (alpha>0)
tail = poly(TAIL) & ~head & ~body & (alpha>0)
wings = (poly(LEFT_WING)|poly(RIGHT_WING)) & ~head & ~body & ~tail & (alpha>0)
hair = (alpha>0) & ~head & ~body & ~tail & ~wings

# Build a bounded backing under each foreground part. Inpainting is confined
# to hidden areas; all exposed source pixels keep their original RGB/alpha.
def backing(visible, hidden, radius):
    result = src.copy()
    fill = hidden & ndi.binary_dilation(visible, iterations=radius)
    # Keep only extensions supported by nearby material. Do not grow the outer silhouette.
    result[:,:,3] = np.where(visible|fill, alpha, 0)
    unknown = (~visible).astype(np.uint8)*255
    painted = cv2.inpaint(src[:,:,:3].copy(), unknown, 3, cv2.INPAINT_TELEA)
    result[fill,:3] = painted[fill]
    return result

def cut(mask):
    a=src.copy(); a[:,:,3]=np.where(mask, alpha, 0); return a

def save(name,a):
    a=a.copy(); a[a[:,:,3]==0,:3]=0
    Image.fromarray(a,'RGBA').save(OUT/(name+'.png'),optimize=True)
    return a

# Back hair continues underneath the head/shoulders/wings and fully behind the
# tail. Tail movement must never reveal the old tail's silhouette or a hole.
# Preserve every exposed source pixel. Only synthesize the occluded backing.
# A continuous backing prevents transparent seams during bounded movement.
foreground=head|body|tail|wings
known_hair=hair
paint=cv2.inpaint(src[:,:,:3].copy(),(~known_hair).astype(np.uint8)*255,5,cv2.INPAINT_TELEA)
hair_shape=((yy>=165)&(yy<=385)&(alpha>0))|hair
hair_a=src.copy()
hair_a[:,:,:3]=paint
hair_a[known_hair,:3]=src[known_hair,:3]
hair_a[:,:,3]=np.where(hair_shape,alpha,0)
hair_a=save('back_hair',hair_a)
# At the neck the body extends upward under the head, but does not duplicate eyes/hair.
body_a=backing(body,head,7)
body_a=save('body',body_a)
wings_a=save('wings',backing(wings,head|body,5))
tail_a=save('tail',cut(tail))
head_a=save('head_idle',cut(head))

# Expression replacements use facial interiors only. This deliberately excludes
# the hands at the cheeks in happy/shy/smug source poses. Hair, ears and horns
# remain pixel-identical to idle, so expressions do not make the silhouette jump.
EYE_L=[(162,139),(171,125),(185,118),(194,122),(201,135),(210,145),(215,149),(215,166),(207,175),(185,177),(170,170)]
EYE_R=[(228,143),(236,133),(241,119),(254,122),(271,134),(280,148),(274,171),(258,178),(238,175),(226,165)]
MOUTH=[(192,170),(244,170),(248,180),(240,194),(229,199),(212,198),(198,190),(190,179)]
# Keep a feather INSIDE these masks, without bringing in neighbouring fingers.
expr_mask=poly(EYE_L)|poly(EYE_R)|poly(MOUTH)
dist=ndi.distance_transform_edt(expr_mask)
blend=np.clip(dist/3.0,0,1).astype(np.float32)
closed_meta={}
expressions=['idle','blink','happy','angry','shy','smug','hungry','starve','thirsty','weak','dizzy']
for name in expressions:
    if name=='idle': continue
    source=np.asarray(Image.open(SRC/(name+'.png')).convert('RGBA'))
    a=head_a.copy()
    if name=='blink':
        # This source is registered to idle; the complete head preserves closed eyelids.
        a[:,:,:3]=source[:,:,:3]
    else:
        b=blend.copy()
        if name=='smug': b[170:,:]=0
        mix=b[:,:,None]
        a[:,:,:3]=np.rint(head_a[:,:,:3]*(1-mix)+source[:,:,:3]*mix).astype(np.uint8)
    save('head_'+name,a)
    if name not in ['blink','happy','weak','dizzy']:
        closed_source=np.asarray(Image.open(SRC/'blink.png').convert('RGBA'))
        eye_mask=poly(EYE_L)|poly(EYE_R)
        eye_blend=np.clip(ndi.distance_transform_edt(eye_mask)/3,0,1)[:,:,None]
        c=a.copy();c[:,:,:3]=np.rint(a[:,:,:3]*(1-eye_blend)+closed_source[:,:,:3]*eye_blend).astype(np.uint8)
        save('head_'+name+'_blink',c);closed_meta[name]='head_'+name+'_blink.png'
closed_meta['idle']='head_blink.png'

# Rest-pose reconstruction is a regression check, not a visual-only claim.
composite=Image.new('RGBA',(W,H))
for a in [hair_a,wings_a,tail_a,body_a,head_a]:composite.alpha_composite(Image.fromarray(a,'RGBA'))
recon=np.asarray(composite).astype(float);original=src.astype(float)
pa=recon[:,:,:3]*recon[:,:,3:]/255;pb=original[:,:,:3]*original[:,:,3:]/255
mae=float(np.abs(pa-pb).mean());bad=int((np.max(np.abs(pa-pb),axis=2)>12).sum())
# Transparent contour pixels are never manufactured outside the source alpha.
assert np.all((recon[:,:,3]>0) <= (alpha>0))
assert mae<2.0, f'Reconstruction mismatch {mae:.3f}'
meta={
 'version':1,'source':'sprites/idle.png','size':[W,H],'pad':30,
 'headPivot':[222,204],'tailPivot':[306,365],
 'parts':{'backHair':'back_hair.png','wings':'wings.png','tail':'tail.png','body':'body.png'},
 'expressions':{n:'head_'+n+'.png' for n in expressions},
 'closedExpressions':closed_meta,
 # Prop-heavy and radically different poses deliberately retain their original sprites.
 'spriteMap':{n:n for n in ['idle','blink','happy','angry','shy','smug','hungry','weak','dizzy']},
 'sourceSha256':{n:hashlib.sha256((SRC/(n+'.png')).read_bytes()).hexdigest() for n in expressions},
 'reconstruction':{'premultipliedRgbMAE':round(mae,5),'pixelsOver12':bad},
 'notes':'Hand-traced visible parts; occluded backing inpainted from original pixels. Not a Cubism model.'
}
(OUT/'parts.js').write_text('window.PET_PARTS = '+json.dumps(meta,ensure_ascii=False,indent=2)+';\n',encoding='utf-8',newline='\n')
(OUT/'manifest.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
references=set(meta['parts'].values())|set(meta['expressions'].values())|set(meta['closedExpressions'].values())
pixel_hashes={n:hashlib.sha256(Image.open(OUT/n).convert('RGBA').tobytes()).hexdigest() for n in sorted(references)}
(OUT/'pixel-hashes.json').write_text(json.dumps(pixel_hashes,indent=2)+'\n',encoding='utf-8',newline='\n')
print(json.dumps({'output':str(OUT),'expressions':len(expressions),'mappedSprites':len(meta['spriteMap']),'reconstruction':meta['reconstruction']},ensure_ascii=False))
