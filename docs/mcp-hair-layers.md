# 桌宠头发分层重绘记录（无长发身体 + 独立长发）

## 目标与结论

- 需求：按 `assets/sprites/idle.png` 重绘桌宠，拆成「无长发版本」和「她的长发」两张图，二者叠合还原原图，用来做头发飘动；不要给无长发版本补短发；前发长度不变、脸不变、呆毛在前发上、后发没有呆毛。
- 起因：`assets/parts/back_hair.png` 由 cv2 TELEA 补全，头层多边形又从两侧鬓发中间切开，后发一摆动就在脸侧和 y165 顶边撕裂。
- 结论：已产出对齐到原图坐标系（444×420，与 `manifest.json` 一致）的两层，静态叠合与原图 MAE 2.66/255（白底），在 ±6px 摆动、头部 ±0.035rad + (1.6,1.3)px 位移的模拟下无缝、无洞、无白边。原图 `assets/sprites/*.png` 与 `assets/parts/` 均未修改。

## 产物（`art/layers/`）

- `idle_nohair.png`（444×420）：层 A，脸、前发（长度与原图相同）、呆毛、角、耳、发饰、身体、袖、手脚、完整翅膀、尾巴；不含任何长发，也没有补短发，后脑与耳后透明，由层 B 透出。
- `idle_backhair.png`（444×420）：层 B，完整后发，含被脸、肩、袖、翅膀、尾巴遮住的部分（后脑是完整的发盖），无呆毛。必须画在 A 下面。
- `idle_nohair_2x.png` / `idle_backhair_2x.png`（888×840）：同样的两层，2 倍分辨率备用。
- `preview/hair_split_preview_sheet.jpg`：原图 / A / B / A over B / 摆动 ±6px 对照。
- `preview/hair_split_preview_motion.jpg`、`preview/hair_split_preview_motion_zoom.jpg`：按 `src/parts-live.js` 顶点着色器参数（后发 y<175 跟头、215–395 横摆，头部旋转 + 位移）做的极限姿态模拟。

## 制作方式（`art/tools/build_hair_layers.py`）

- 参考稿：`art/raw/hair_split/ref_green_512.png` = 原图居中放在 512×512 纯绿底（偏移 34,46）。
- AI 重绘两张 1024×1024 绿幕稿：`gen_body_nohair_v1.png`（去掉全部长发、补全被遮住的肩、袖、翅膀）与 `gen_backhair_v1.png`（只留后发、补全被遮部分、不画呆毛）。SIFT + RANSAC 校验后两稿与原图的相似变换均为 scale 1.000、位移 <0.3px，因此可直接按像素叠合。
- 层 A：绿幕抠像 + 去绿；剥掉朝向头发那一侧的白色贴纸描边（只保留原图外轮廓上的描边，避免叠合后出现白色光晕）；在 `build_parts.py` 的 HEAD/BODY/TAIL/WING 多边形内，凡重绘与原图一致的像素直接回填原图像素，BODY/TAIL/WING 多边形内强制使用原图 RGBA，因此脸、前发、衣服与原图逐像素相同。
- 层 B：原图中可见的后发像素逐点保留（含原图外轮廓描边）；被 A 遮住的区域使用重绘发稿（先按可见后发的均值/方差做逐通道配色），贴近遮挡边缘的 ~4px 用 TELEA 延续原图发丝以便小幅摆动时无缝；顶部限制在头骨椭圆内，不带角和呆毛的形状；整体裁剪到原图轮廓 +1px。
- 再生成：`python art/tools/build_hair_layers.py`（依赖 Pillow、numpy、scipy、opencv>=4.4），输出与本次提交逐字节一致。

## 接入建议（未改动运行代码）

- 用 `art/layers/idle_nohair.png` 代替 `assets/sprites/idle.png` 作为 `build_parts.py` 的切分源生成 head/body/wings/tail（多边形坐标不变，因为 A 与原图同坐标系），用 `art/layers/idle_backhair.png` 直接作为 `back_hair.png`，即可去掉 TELEA 补全和鬓发切口；表情头的眼口混合逻辑不受影响，因为 A 的脸与原图相同。
- 若希望翅膀像原图一样被头发压在后面，可把 `parts-live.js` 的层序从 rearhair → wings → tail → body → head 改为 wings → rearhair → tail → body → head；A 中翅膀已经是完整的。
- 层 B 在遮挡区内的发丝为重绘近似，当前 ±3.4px 摆动与 ±0.035rad 转头范围内不会露出接缝；若日后大幅加大摆幅，优先增大 `build_hair_layers.py` 中 TELEA 延续带宽度。

## 验证

- 三个成品 PNG 与 2 倍图经 sha256 校验与沙箱构建结果一致；`read_image` 确认尺寸 444×420。
- 静态：A over B 对原图 MAE 2.664（白底），差异 >40 的像素 7369 个，全部位于原图中头发压在身体、翅膀上的区域（现改为身体在前）。
- 动态：见 `preview/hair_split_preview_motion*.jpg`，2 倍夸张摆幅（±6.8px）下耳侧、肩、袖、翅膀边缘均无撕裂。
