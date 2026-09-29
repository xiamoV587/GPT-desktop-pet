# 桌宠分层动画实现记录

## 目标与结论

- 需求：像 Live2D 那样把完整立绘拆为「头（含脸、耳、角）」「后发」「身体」「尾巴」四个主层，各层独立动作并组合表情；尾巴此前拆分不正确，必须从 `assets/sprites` 的完整原图重新拆取，不沿用旧尾巴层。
- 结论：已在现有 Electron 桌宠上完成轻量类 Live2D 分层动画。原图 `assets/sprites/*.png` 未修改。本实现是自研网格变形动画，不是官方 Live2D/Cubism 模型。

## 分层结果（`assets/parts/`）

- 统一 444×420 画布（原图尺寸），叠放优先级 head > body > tail > wings > rearhair。
- `head_*.png`：脸、前发上部、耳朵、角，止于 y204 下颌；下面的长卷发归入后发层。
- `tail.png`：按完整原图重新紧描轮廓，含内侧尖刺；与旧 `assets/rig` 尾巴无关。
- `body.png`（含翅膀子层 `wings.png`）：肩颈、衣裙、手脚；底缘 y>=385 且 101<=x<=341 归身体，mask 膨胀 1px。
- `back_hair.png`：可见像素逐点保留，只补被遮挡区域（cv2 TELEA 近似补全，不是原始画稿）。
- 11 个可组合表情头：idle/blink/happy/angry/shy/smug/hungry/starve/thirsty/weak/dizzy；smug 只替换眼部，避免把原图遮嘴的手裁进脸部。闭眼用 `*_blink` 头。
- `manifest.json`/`parts.js`：支点（头 222,204；尾 306,365）、表情映射、原图 sha256。`pixel-hashes.json` 记录成品像素哈希。
- 静态重组质量：premultiplied RGB MAE 0.00793，差异>12 的像素 35 个。生成器 `art/tools/build_parts.py`，依赖见 `art/tools/requirements-parts.txt`（仅重新生成素材时需要）。

## 动画系统（`src/parts-live.js`）

- WebGL1，40×40 indexed mesh，层序 rearhair → wings → tail → body → head；旧 `src/live.js` 保留但不再由入口加载。
- 头部 look 弹簧小幅转动（上限约 0.035rad）；后发根部随头、末梢延迟回摆（约 ±3.4px）；尾巴以根部为轴按距离平滑加权弯曲（上限 0.10rad），全身脚底轻呼吸。
- 表情切换用双 FBO 整场景 crossfade（约 0.16s），避免层间透明边缘暗线；blink 自动眨眼使用闭眼头。
- 速度/加速度驱动发梢惯性，dt 截断并细分，长帧不会发散。

## 接入（`src/pet.html`、`src/pet.js`）

- 入口改载 `../assets/parts/parts.js` + `parts-live.js`。
- 24 个游戏姿态中 9 个站姿走分层（idle/blink/happy/angry/shy/smug/hungry/weak/dizzy）；吃喝、抱尾、睡、拎起、侧身、生病、死亡等 15 个特殊姿态保留完整原图，避免道具和大幅姿态被拆坏。
- 命中判定先用 DOMMatrix 逆变换取消外层 CSS 旋转/缩放再换算，layered 模式用实际渲染 alpha（`hitTest`）；WebGL 不可用或 `webglcontextlost` 时自动回退原图渲染。
- 养成数值、物品/商店、右键菜单、拖拽弹跳、存档与点击穿透逻辑未改。

## 验证

- `tests/verify_parts.py`（仅标准库）：21 张 PNG 签名/CRC/解码、像素哈希、`manifest` 中原图 sha256 未变、入口引用、11 表情与 9 个分层状态，全部 PASS。
- `tests/parts-smoke.cjs`（Playwright，需开发依赖）：12 项浏览器回归全部 PASS——11 表情成像互异、四层开关独立生效、极端速度/长帧参数有限且在限幅内、crossfade 到干净终帧、4 档缩放命中、24 姿态计数（9 分层+15 回退）、喂食物品扣减与吃姿态、真实指针事件经变换后命中右键菜单、contextlost 回退、无 WebGL 启动、全程无运行时错误。
- `tests/electron-parts-smoke.cjs` + `tests/parts-preload.cjs`：在 Windows 原生 Electron 下以 `file://` 加载入口 PASS（9 分层+15 原姿态、命中测试、无运行时错误），截图 `tests/artifacts/native-layered-pet.png`。使用隐藏窗口与临时 profile，不触碰真实桌面存档。
- `get_diagnostics`（pet/src）：0 error / 0 warning。

## 已知限制

- 被遮挡区域为算法近似补全，极端动作下仍可能出现接缝，需美术补绘才能到手绘质量。
- 说话口型未接入分层；特殊姿态仍是整图，未做子层动画。
- 不声称兼容 Cubism/官方 Live2D。

## 回退与再生成

- 回退：把 `src/pet.html` 中两个 script 引用改回 `live.js`（及旧图层入口），旧资源均保留。
- 再生成：`python art/tools/build_parts.py` 覆盖 `assets/parts/`，然后运行 `python tests/verify_parts.py` 核对。
