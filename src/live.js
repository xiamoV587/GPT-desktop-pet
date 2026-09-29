/*
 * 仿 Live2D 渲染器
 * 原理：立绘按部件权重贴图（assets/rig/*.png）划分区域，片元着色器里对每个像素计算位移
 *      （平移 / 绕关节旋转），再用弹簧物理驱动各部件参数，实现：
 *      头部整体跟随鼠标（脸、五官、前发一起动）、瞳孔注视（仅待机表情）、长发/尾巴/裙摆/呆毛惯性摆动、翅膀扇动、呼吸。
 * 尾巴：每张立绘单独一张权重图（assets/rig/tails），从根部到尖端权重 0→1，根部和衣服相连处完全不动。
 */
(function (root) {
  'use strict';
  const SW = 444, SH = 420, PAD = 30;

  const VS = `
attribute vec2 aPos;
varying vec2 vP;
uniform float uPad;
void main() {
  vec2 uv = aPos * 0.5 + 0.5;
  vP = vec2(mix(-uPad, ${SW}.0 + uPad, uv.x), mix(${SH}.0 + uPad, -uPad, uv.y));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const FS = `
precision highp float;
varying vec2 vP;
uniform sampler2D uTexA, uTexB, uRig, uDirtT, uTailW;
uniform float uDirt;
uniform float uMix;
uniform vec2 uHead; uniform float uHeadRot;
uniform vec2 uEye; uniform float uBreath;
uniform float uHairL, uHairR, uWingL, uWingR, uTail, uAhoge, uSkirt;
uniform vec2 uWingLP, uWingRP, uTailP;
const vec2 SZ = vec2(${SW}.0, ${SH}.0);

vec2 rotD(vec2 p, vec2 c, float a) {
  vec2 d = p - c; float s = sin(a), co = cos(a);
  return vec2(co * d.x - s * d.y, s * d.x + co * d.y) - d;
}
vec4 rig(vec2 mu, float tile) {
  mu = clamp(mu, vec2(0.003), vec2(0.997));
  return texture2D(uRig, vec2((mu.x + tile) / 4.0, mu.y));
}
void main() {
  vec2 p = vP;
  vec2 mu = p / SZ;
  vec3 m1 = rig(mu, 0.0).rgb;   // 头 (前发) 左发
  vec3 m2 = rig(mu, 1.0).rgb;   // 右发 左翼 右翼
  vec3 m3 = rig(mu, 2.0).rgb;   // (尾巴) 裙摆 呆毛
  vec3 m4 = rig(mu, 3.0).rgb;   // 瞳孔 (流苏)
  float wT = texture2D(uTailW, clamp(mu, vec2(0.0), vec2(1.0))).r;   // 当前立绘的尾巴权重
  vec2 D = vec2(0.0);
  D.y -= uBreath * clamp((300.0 - p.y) / 85.0, 0.0, 1.0);
  D += m1.r * (uHead + rotD(p, vec2(222.0, 205.0), uHeadRot));   // 头部整体（脸、五官、前发）
  D += m1.b * rotD(p, vec2(145.0, 180.0), uHairL);
  D += m2.r * rotD(p, vec2(299.0, 180.0), uHairR);
  D += m2.g * rotD(p, uWingLP, uWingL);
  D += m2.b * rotD(p, uWingRP, uWingR);
  D += wT * rotD(p, uTailP, uTail);
  D.x += m3.g * uSkirt;
  D += m3.b * rotD(p, vec2(222.0, 46.0), uAhoge);
  D += m4.r * uEye;
  vec2 q = (p - D) / SZ;
  float inside = step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
  vec4 a = texture2D(uTexA, q), b = texture2D(uTexB, q);
  vec4 c = mix(a, b, uMix) * inside;
  // 脏污层：污渍贴图跟随变形后的坐标，只画在角色不透明的地方（预乘 alpha）
  vec4 d = texture2D(uDirtT, q);
  float k = clamp(uDirt, 0.0, 1.0) * 0.85 * (d.a > 0.0 ? 1.0 : 0.0);
  vec3 dc = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  c.rgb = mix(c.rgb, dc * c.a, k * d.a);
  gl_FragColor = c;
}`;

  const PIVOTS = { std: { wingL: [176, 240], wingR: [268, 240] }, lifted: { wingL: [126, 146], wingR: [318, 146] }, curl: { wingL: [0, 0], wingR: [0, 0] } };

  const clampV = (v, m) => Math.max(-m, Math.min(m, v));
  // 阻尼弹簧
  class Spring {
    constructor(k, c) { this.k = k; this.c = c; this.x = 0; this.v = 0; }
    step(target, dt, force = 0) { const a = this.k * (target - this.x) - this.c * this.v + force; this.v += a * dt; this.x += this.v * dt; return this.x; }
  }

  function create(canvas, opts) {
    const base = opts.base;
    const rigOf = opts.rigOf || ((n) => (n === 'lifted' ? 'lifted' : (n === 'sleepcurl' || n === 'dead') ? 'curl' : 'std'));
    let gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false });
    const gl2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true }) || canvas.getContext('experimental-webgl');
    const api = { ok: false, ready: Promise.resolve(false) };
    if (!gl) return api;

    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { console.error('WebGL 着色器失败，回退到普通模式', e); return api; }
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const U = {};
    ['uTexA', 'uTexB', 'uRig', 'uTailW', 'uMix', 'uHead', 'uHeadRot', 'uEye', 'uBreath', 'uHairL', 'uHairR', 'uWingL', 'uWingR', 'uTail', 'uAhoge', 'uSkirt', 'uWingLP', 'uWingRP', 'uTailP', 'uPad', 'uDirtT', 'uDirt']
      .forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    gl.uniform1i(U.uTexA, 0); gl.uniform1i(U.uTexB, 1); gl.uniform1i(U.uRig, 2); gl.uniform1i(U.uDirtT, 3); gl.uniform1i(U.uTailW, 4); gl.uniform1f(U.uPad, PAD);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('加载失败 ' + src)); i.src = src; });
    function makeTex(img, mip) {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (mip && gl2) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
      else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      return t;
    }
    const tex = {}, rigTex = {}, tailTex = {};
    const TAILS = root.PET_TAILS || {};   // 由 art/tools/build_tails.py 生成：{ 立绘名: { base: [x, y] } }
    let dirtTex = null, dirt = 0, zeroTex = null;
    let cur = null, prev = null, fadeT = 1, fadeDur = 0.14;

    api.ready = Promise.all([
      ...opts.sprites.map((n) => loadImg(base + 'sprites/' + n + '.png').then((i) => { tex[n] = makeTex(i, true); })),
      loadImg(base + 'rig/dirt.png').then((i) => { dirtTex = makeTex(i, true); }),
      ...['std', 'lifted', 'curl'].map((n) => loadImg(base + 'rig/' + n + '.png').then((i) => { rigTex[n] = makeTex(i, false); })),
      ...Object.keys(TAILS).map((n) => loadImg(base + 'rig/tails/' + n + '.png').then((i) => { tailTex[n] = makeTex(i, false); }).catch((e) => console.warn(e))),
    ]).then(() => {
      const c = document.createElement('canvas'); c.width = c.height = 1; zeroTex = makeTex(c, false);   // 全 0：尾巴不动
      api.ok = true; return true;
    }).catch((e) => { console.error(e); return false; });

    let scale = 1, dpr = 1;
    api.resize = (k) => {
      scale = k; dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = (SW + PAD * 2) * k, ch = (SH + PAD * 2) * k;
      canvas.style.left = canvas.style.top = (-PAD * k) + 'px';
      canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    };
    api.setDirt = (v) => { dirt = Math.max(0, Math.min(1, v)); };
    api.setSprite = (name, fade) => {
      if (name === cur) return;
      prev = fade ? cur : null; cur = name; fadeT = fade ? 0 : 1;
    };

    // ───── 物理参数 ─────
    const S = {
      headX: new Spring(30, 11), headY: new Spring(30, 11), eyeX: new Spring(120, 22), eyeY: new Spring(120, 22),
      tilt: new Spring(30, 10),
      hairL: new Spring(26, 3.2), hairR: new Spring(24, 3.0), tail: new Spring(16, 4.5), skirt: new Spring(60, 5),
      ahoge: new Spring(90, 4.5), flap: new Spring(160, 18),
    };
    let eyeK = 1, t = 0, lastVx = 0, lastVy = 0, lastHeadX = 0, flapBurst = 0, nextBurst = 3;
    const P = {};   // 当前输出参数

    // input: { look:{x,y}, vx, vy (精灵像素/秒), rot(度), mode, talking, happy }
    api.update = (dt, input) => {
      dt = Math.min(dt, 0.05);
      const mode = input.mode || 'idle';
      const steps = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / steps;
      const ax = (input.vx - lastVx) / dt, ay = (input.vy - lastVy) / dt;
      lastVx = input.vx; lastVy = input.vy;
      const rotRad = (input.rot || 0) * Math.PI / 180;
      for (let i = 0; i < steps; i++) {
        t += h;
        // 视线
        let lx = input.look ? input.look.x : 0, ly = input.look ? input.look.y : 0;
        if (mode === 'sleep') { lx = 0; ly = 0.7; }
        if (mode === 'dead') { lx = 0; ly = 0; }
        if (mode === 'lifted' || mode === 'falling') { lx = 0; ly = -0.15; }
        if (mode === 'sick' || mode === 'weak') { ly = Math.max(ly, 0.35); lx *= 0.5; }
        if (mode === 'hungry' || mode === 'thirsty' || mode === 'sad') ly = Math.max(ly, 0.3);
        if (mode === 'smug' || mode === 'proud') ly = Math.min(ly, -0.25);   // 鄙视/得意：微微仰头俯视你
        if (mode === 'tsun') { lx = lx >= 0 ? -0.3 : 0.3; ly = -0.1; }
        if (mode === 'ouch') ly = Math.max(ly, 0.3);
        if (input.talking) ly += 0.1 * Math.abs(Math.sin(t * 7.5));
        const hx = S.headX.step(lx, h), hy = S.headY.step(ly, h);
        S.eyeX.step(lx, h); S.eyeY.step(ly, h);
        const tiltTarget = mode === 'sleep' ? 0.04 : (mode === 'sick' || mode === 'weak') ? 0.05 * Math.sin(t * 0.9)
          : mode === 'smug' ? 0.03 : mode === 'dizzy' ? 0.05 * Math.sin(t * 3.2) : 0;
        S.tilt.step(tiltTarget, h);
        const headV = (hx - lastHeadX) / h; lastHeadX = hx;

        // 风（缓慢摆动），体积越大的部件越慢
        const wind = 0.03 * Math.sin(t * 1.3) + 0.014 * Math.sin(t * 2.7 + 1);
        const g = 0.00035;
        S.hairL.step(-rotRad * 0.85 + wind - hx * 0.02, h, ax * g - headV * 0.25);
        S.hairR.step(-rotRad * 0.85 + wind * 0.9 - hx * 0.02, h, ax * g - headV * 0.25);
        const wag = mode === 'happy' ? 0.07 * Math.sin(t * 6) : mode === 'dead' ? 0 : 0.035 * Math.sin(t * 1.6);
        S.tail.step(-rotRad * 0.3 + wag, h, -ax * g * 0.8);
        S.skirt.step(0, h, -ax * 0.02 + rotRad * 60);
        S.ahoge.step(0, h, -ax * g * 1.4 + ay * g * 1.0 - headV * 0.5);

        // 翅膀
        let amp = 0, freq = 0;
        if (mode === 'lifted') { amp = 0.09; freq = 3.6; }
        else if (mode === 'falling') { amp = 0.12; freq = 4.5; }
        else if (mode === 'happy') { amp = 0.06; freq = 3.8; }
        else if (mode === 'surprised') { amp = 0.07; freq = 4.5; }
        else if (!['dead', 'sleep', 'sick', 'weak', 'sad', 'thirsty', 'hungry', 'dizzy', 'ouch'].includes(mode)) {
          nextBurst -= h;
          if (nextBurst <= 0) { flapBurst = 0.9; nextBurst = 4 + Math.random() * 6; }
          if (flapBurst > 0) { flapBurst -= h; amp = 0.045; freq = 3.2; }
        }
        S.flap.step(amp * Math.sin(t * freq * Math.PI * 2), h);
      }
      const breathPer = mode === 'sleep' ? 4.2 : 3.0, breathAmp = mode === 'sleep' ? 2.6 : mode === 'dead' ? 0 : 1.5;
      const rig = rigOf(cur);
      const wingK = rig === 'std' ? 0.6 : 1;
      // 头部位移/转角减小：脖子处在头部权重的过渡带，幅度太大时会被明显拉伸变形
      P.head = [clampV(S.headX.x, 1.2) * 3.5, clampV(S.headY.x, 1.2) * 2.2];
      P.headRot = clampV(S.headX.x, 1.2) * 0.025 + S.tilt.x * 0.6;
      // 瞳孔分区是按待机立绘的眼睛画的，其他表情（眯眼/闭眼/被提起等）眼睛位置不同，移动会把眼皮拉变形 → 只在待机图启用
      eyeK += ((cur === 'idle' ? 1 : 0) - eyeK) * Math.min(1, dt * 12);
      P.eye = [clampV(S.eyeX.x, 1) * 1.6 * eyeK, clampV(S.eyeY.x, 1) * 1.1 * eyeK];
      P.breath = breathAmp * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 / breathPer));
      P.hairL = clampV(S.hairL.x, 0.14); P.hairR = clampV(S.hairR.x, 0.14);
      P.tail = clampV(S.tail.x, 0.08);
      P.skirt = clampV(S.skirt.x, 6);
      P.ahoge = clampV(S.ahoge.x, 0.3);
      P.wingL = clampV(S.flap.x, 0.14) * wingK; P.wingR = -clampV(S.flap.x, 0.14) * wingK;
      if (fadeT < 1) fadeT = Math.min(1, fadeT + dt / fadeDur);
    };

    api.render = () => {
      if (!api.ok || !cur || !tex[cur]) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const rig = rigOf(cur), piv = PIVOTS[rig];
      const tw = tailTex[cur], tb = tw ? TAILS[cur].base : [0, 0];
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[prev && fadeT < 1 ? prev : cur]);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, rigTex[rig]);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, dirtTex);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, tw || zeroTex);
      gl.uniform1f(U.uDirt, dirt);
      gl.uniform1f(U.uMix, prev && fadeT < 1 ? fadeT : 1);
      gl.uniform2f(U.uHead, P.head[0], P.head[1]); gl.uniform1f(U.uHeadRot, P.headRot);
      gl.uniform2f(U.uEye, P.eye[0], P.eye[1]); gl.uniform1f(U.uBreath, P.breath);
      gl.uniform1f(U.uHairL, P.hairL); gl.uniform1f(U.uHairR, P.hairR);
      gl.uniform1f(U.uWingL, P.wingL); gl.uniform1f(U.uWingR, P.wingR);
      gl.uniform1f(U.uTail, P.tail); gl.uniform2f(U.uTailP, tb[0], tb[1]);
      gl.uniform1f(U.uAhoge, P.ahoge); gl.uniform1f(U.uSkirt, P.skirt);
      gl.uniform2f(U.uWingLP, piv.wingL[0], piv.wingL[1]); gl.uniform2f(U.uWingRP, piv.wingR[0], piv.wingR[1]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    api.params = P; api._S = S;   // 调试用
    api.gl2 = gl2;
    return api;
  }

  // 默认用本渲染器（整图权重变形）。分部件渲染器 parts-live.js 若已加载，保留为 PetLiveParts；
  // 想切换过去：在控制台执行 localStorage.setItem('petRenderer', 'parts') 后重启，改回用 'live'。
  const parts = root.PetLive && root.PetLive.create !== create ? root.PetLive : null;
  if (parts) root.PetLiveParts = parts;
  let want = 'live';
  try { want = localStorage.getItem('petRenderer') || 'live'; } catch (e) { /* 忽略 */ }
  root.PetLive = want === 'parts' && parts ? parts : { create, PAD };
})(window);
