// 桌宠窗口：立绘切换、程序动画（呼吸/弹跳/挤压/摇摆）、点击判定、拖拽、气泡、特效
(() => {
  'use strict';
  const api = window.petAPI ||
    (window.parent !== window && window.parent.createPreviewAPI ? window.parent.createPreviewAPI('pet', window) : null);
  const Game = window.PetGame;
  const $ = (id) => document.getElementById(id);
  const rig = $('rig'), overlay = $('overlay'), fx = $('fx'), bubble = $('bubble'), bubbleText = $('bubbleText');
  const hud = $('hud'), petEl = $('pet'), shadow = $('shadow');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ───────── 缩放 ─────────
  let K = parseFloat(new URLSearchParams(location.search).get('scale')) || 0.55;
  let live = null, useLive = false;
  const setK = (k) => { K = k; document.documentElement.style.setProperty('--k', k); if (live && live.resize) live.resize(k); };
  setK(K);
  const U = () => K / 0.55; // 动画幅度随大小缩放

  // ───────── 点击遮罩 ─────────
  const masks = {};
  for (const [n, m] of Object.entries(window.PET_MASKS)) {
    const bin = atob(m.data); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    masks[n] = Object.assign({}, m, { bytes });
  }
  function maskHit(name, sx, sy) {
    const m = masks[name] || masks.idle;
    const x = Math.floor(sx / m.scale), y = Math.floor(sy / m.scale);
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) return false;
    const i = y * m.w + x;
    return ((m.bytes[i >> 3] >> (7 - (i & 7))) & 1) === 1;
  }
  const IB = masks.idle.bbox;
  const HEAD_LINE = IB[1] + (IB[3] - IB[1]) * 0.42;   // 这条线以上算“头”

  // ───────── 立绘 ─────────
  const SPRITES = ['idle', 'blink', 'happy', 'lifted', 'eat', 'drink', 'sick', 'hungry', 'angry', 'shy',
    'smug', 'tease', 'sleepcurl', 'starve', 'thirsty', 'sad', 'weak',
    'dizzy', 'surprised', 'yawn', 'tsun', 'proud', 'ouch', 'dead'];
  const src = (n) => `../assets/sprites/${n}.png`;
  SPRITES.forEach((n) => { const i = new Image(); i.src = src(n); });

  // 原图独立部件渲染器（WebGL），不可用时回退到原始完整图片
  live = window.PetLive.create($('live'), { base: '../assets/', sprites: SPRITES });
  live.resize && live.resize(K);
  window.__petLive = live;   // 调试用

  let front = $('imgA'), back = $('imgB'), shown = null;
  function showSprite(name, fade) {
    if (name === shown) return;
    shown = name;
    if (useLive) { live.setSprite(name, fade); return; }
    if (!fade) {
      rig.classList.remove('fading');
      front.src = src(name); front.style.opacity = 1; back.style.opacity = 0;
      return;
    }
    rig.classList.add('fading');
    back.src = src(name); back.style.opacity = 1; front.style.opacity = 0;
    [front, back] = [back, front];
  }

  $('live').addEventListener('pet-renderer-lost', () => {
    useLive = false;
    rig.classList.remove('gl');
    shown = null;
    showSprite(currentSprite(Date.now()), false);
  });

  // ───────── 状态 ─────────
  let state = null;
  let temp = null;                 // 临时表情 { sprite, until }
  let debugPose = null;            // 调试模式锁定的姿势
  let dragging = false, falling = false, press = null;
  let blinkUntil = 0, nextBlink = Date.now() + 2000, doubleBlink = false;
  let lastInteract = Date.now();
  let dragVx = 0;

  const BASE = Game.SPRITE_OF;
  const L = Game.LINES, pick = Game.pick;
  const baseMood = () => (state ? Game.mood(state) : 'idle');
  const setTemp = (sprite, ms) => { temp = { sprite, until: Date.now() + ms }; };

  function currentSprite(now) {
    if (debugPose) return debugPose;   // 调试模式锁定的姿势优先
    if (state && state.dead) { temp = null; return 'dead'; }   // 倒下了：提起来也是这张
    if (dragging || falling) return 'lifted';
    if (state && state.sleeping && temp && temp.sprite !== 'blink') temp = null;   // 睡着了就打断临时表情
    if (temp && now < temp.until) return temp.sprite;
    temp = null;
    const b = BASE[baseMood()];
    if (b === 'idle' && now < blinkUntil) return 'blink';
    return b;
  }

  // ───────── 动画效果（叠加到 rig 的 transform 上）─────────
  const effects = [];
  const addFx = (dur, fn) => effects.push({ t0: performance.now(), dur, fn });
  const E = {
    squash: (amt = 0.12) => addFx(650, (p) => { const d = amt * Math.exp(-5 * p) * Math.cos(p * 20); return { sx: 1 + d, sy: 1 - d }; }),
    hop: (n = 2, h = 14) => addFx(380 * n, (p) => {
      const q = (p * n) % 1, y = Math.sin(Math.PI * q), ground = q < 0.1 || q > 0.9;
      return { ty: -h * U() * y, sx: ground ? 1.05 : 1 - 0.02 * y, sy: ground ? 0.94 : 1 + 0.04 * y };
    }),
    shake: (amp = 6, dur = 500) => addFx(dur, (p) => ({ tx: amp * U() * Math.sin(p * dur / 1000 * 2 * Math.PI * 12) * (1 - p) })),
    chew: (dur, hz = 4, amt = 0.02) => addFx(dur, (p, t) => ({ sy: 1 + amt * Math.sin(t * 2 * Math.PI * hz) * Math.sin(Math.PI * p) })),
    tilt: (deg, dur = 1200) => addFx(dur, (p) => ({ rot: deg * Math.sin(Math.PI * p) })),
    shiver: (dur = 700) => addFx(dur, (p, t) => ({ tx: 1.6 * U() * Math.sin(t * 90) * (1 - p) })),
    sway: (dur = 2400) => addFx(dur, (p) => ({ rot: 3 * Math.sin(p * Math.PI * 2) * Math.sin(Math.PI * p) })),
  };

  // ───────── 粒子特效 ─────────
  const petRect = () => petEl.getBoundingClientRect();
  const at = (sx, sy) => { const r = petRect(); return [r.left + sx * K, r.top + sy * K]; };
  function particle(cls, html, x, y, o = {}) {
    const el = document.createElement('div');
    el.className = 'p ' + cls; el.innerHTML = html;
    el.style.left = x + 'px'; el.style.top = y + 'px';
    if (o.size) el.style.fontSize = o.size + 'px';
    if (o.w) { el.style.width = o.w + 'px'; el.style.height = o.w + 'px'; }
    if (o.d) el.style.setProperty('--d', o.d + 's');
    if (o.dx != null) el.style.setProperty('--dx', o.dx + 'px');
    if (o.dy != null) el.style.setProperty('--dy', o.dy + 'px');
    const add = () => { fx.appendChild(el); setTimeout(() => el.remove(), (o.life || 2600)); };
    o.delay ? setTimeout(add, o.delay) : add();
  }
  const P = {
    hearts(n = 5) {
      for (let i = 0; i < n; i++) {
        const [x, y] = at(222 + rand(-110, 110), rand(40, 130));
        particle('float', Math.random() < 0.5 ? '💗' : '💕', x, y, { size: rand(14, 22) * U(), dx: rand(-20, 20), dy: rand(50, 90), d: rand(1.2, 1.8), delay: i * 110 });
      }
    },
    tears() {
      for (let i = 0; i < 4; i++) { const [x, y] = at(222 + (i % 2 ? 40 : -40), 175); particle('float drop', '💧', x, y, { size: 12 * U(), dx: (i % 2 ? 30 : -30), dy: -30, d: 0.8, delay: i * 250, life: 1200 }); }
    },
    dizzy() {
      for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; const [x, y] = at(222 + Math.cos(a) * 70, 40 + Math.sin(a) * 18); particle('pop', i % 2 ? '💫' : '⭐', x, y, { size: 14 * U(), d: 1.1, delay: i * 120 }); }
    },
    stink() {   // 脏了之后冒出的"臭味"
      const [x, y] = at(222 + rand(-120, 120), rand(170, 330));
      particle('float stink', '〰', x, y, { size: rand(16, 24) * U(), dx: rand(-15, 15), dy: rand(40, 70), d: rand(1.6, 2.4), life: 2600 });
    },
    rain() { const [x, y] = at(222 + rand(-22, 22), 40); particle('float drop', '💧', x, y, { size: 10 * U(), dx: 0, dy: -40, d: 0.9, life: 1000 }); },
    anger() { const [x, y] = at(318, 55); particle('pop', '💢', x, y, { size: 26 * U(), d: 1.1 }); },
    ghost() { const [x, y] = at(222 + rand(-60, 60), 150); particle('float', '👻', x, y, { size: rand(14, 20) * U(), dx: rand(-15, 15), dy: rand(50, 80), d: 2, life: 2100 }); },
    sweat() { const [x, y] = at(305, 95); particle('pop', '💦', x, y, { size: 20 * U(), d: 1.2 }); },
    zzz() { const [x, y] = state && state.sleeping ? at(215 + rand(-10, 10), 160) : at(300 + rand(-10, 10), 90); particle('zzz', 'Z', x, y, { size: rand(13, 20) * U() }); },
    sparkle(n = 4) {
      for (let i = 0; i < n; i++) { const [x, y] = at(222 + rand(-120, 120), rand(60, 300)); particle('pop', '✨', x, y, { size: rand(12, 18) * U(), d: 1, delay: i * 120 }); }
    },
    bubbles(n = 10) {
      for (let i = 0; i < n; i++) {
        const [x, y] = at(222 + rand(-130, 130), rand(150, 380));
        particle('bubblefx', '', x, y, { w: rand(8, 20) * U(), dx: rand(-25, 25), dy: rand(50, 110), d: rand(1.2, 2.2), delay: i * 90 });
      }
    },
    nums(gained, delay = 0) {
      const names = Game.STAT_NAMES;
      let i = 0;
      for (const k in gained) {
        const v = gained[k]; if (!v) continue;
        const [x, y] = at(i % 2 ? 60 : 384, 250 - Math.floor(i / 2) * 36);
        particle('num' + (v < 0 ? ' neg' : ''), `${names[k]} ${v > 0 ? '+' : ''}${v}`, x, y, { delay: delay + i * 160, life: 2200 });
        i++;
      }
    },
    coin(n) { const [x, y] = at(384, 300); particle('num', `💰 +${n}`, x, y, { delay: 250, life: 2200 }); },
    // 撞到屏幕顶：头上转圈的星星
    bump() {
      for (let i = 0; i < 3; i++) { const [sx, sy] = at(262 + (i - 1) * 46, 20 - (i === 1 ? 14 : 0)); particle('pop', '⭐', sx, sy, { size: 14 * U(), d: 1.4, delay: 120 + i * 160, life: 1800 }); }
    },
  };

  // 使用的物品在头顶冒一下（不再硬塞进手里）
  function itemPop(emoji) {
    if (!emoji) return;
    const [x, y] = at(222, 18);
    particle('float', emoji, x, y, { size: 30 * U(), dx: 0, dy: 36, d: 1.6, life: 1700 });
  }

  // ───────── 气泡 ─────────
  let bubbleTimer = 0;
  const bubbleVisible = () => !bubble.classList.contains('hidden');
  function say(text, ms) {
    if (!text) return;
    bubbleText.textContent = text;
    bubble.classList.remove('hidden'); hud.classList.add('hidden');
    talkUntil = Date.now() + Math.min(2500, text.length * 110);
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), ms || clamp(text.length * 230, 2400, 6000));
  }

  // ───────── 播放操作结果 ─────────
  function play(r) {
    if (!r) return;
    // 喂食/用道具成功：先亮出状态条（浅色段 = 这次加的量）3 秒，再说话
    if (r.ok && r.gained && Object.keys(r.gained).length) {
      showGain(r.gained);
      if (r.say) setTimeout(() => say(r.say), GAIN_MS);
    } else if (r.say) say(r.say); else if (r.ok === false && r.msg) say(r.msg);
    switch (r.anim) {
      case 'happy': setTemp('happy', 1900); E.hop(2, 14); P.hearts(5); break;
      case 'sickPet': E.squash(0.05); P.hearts(2); break;
      case 'poke': setTemp('shy', 1800); E.squash(0.08); break;
      case 'angry': setTemp('angry', 2400); E.shake(7, 650); P.anger(); break;
      case 'shake': setTemp('shy', 1200); E.shake(5, 500); break;
      case 'land': E.squash(0.2); P.sweat(); break;
      case 'eat':
        setTemp('eat', 2900); E.chew(2900, 4, 0.022);
        itemPop(r.emoji);
        setTimeout(() => { E.hop(1, 8); P.hearts(2); }, 2950);
        break;
      case 'drink':
        setTemp('drink', 2700); E.chew(2700, 1.6, 0.012);
        itemPop(r.emoji);
        setTimeout(() => E.hop(1, 8), 2750);
        break;
      case 'medicine':
        setTemp('sick', 1400); E.shiver(900); itemPop(r.emoji);
        setTimeout(() => { setTemp('happy', 1600); E.hop(1, 10); P.sparkle(4); }, 1400);
        break;
      case 'bath': setTemp('happy', 2400); P.bubbles(12); E.sway(2400); setTimeout(() => P.sparkle(5), 1500); break;
      case 'tsun': setTemp('shy', 2400); E.tilt(-1.5, 1200); P.hearts(1); break;   // 傲娇台词 + 害羞脸
      case 'proud': setTemp('proud', 2400); E.hop(1, 12); P.sparkle(5); break;
      case 'ouch': setTemp('ouch', 2800); E.squash(0.25); P.tears(); break;
      case 'dizzy': setTemp('dizzy', 3200); E.sway(3200); P.dizzy(); break;
      case 'sleep': E.squash(0.05); P.zzz(); break;
      case 'abandon':   // 遗弃：先哭着告别，再换成新的宠物打招呼
        setTemp('sad', 2800); P.tears(); E.tilt(-3, 1800);
        setTimeout(() => { setTemp('surprised', 1600); E.hop(1, 12); P.sparkle(4); say(r.greet); }, 3000);
        break;
      case 'wake': setTemp('blink', 500); setTimeout(() => E.hop(1, 6), 500); break;
      case 'sleepPoke': E.shake(3, 350); P.zzz(); break;
      case 'deadPoke': E.squash(0.06); P.ghost(); break;
      case 'revive':
        itemPop(r.emoji); P.sparkle(10); P.hearts(3);
        setTimeout(() => { setTemp('surprised', 1600); E.hop(1, 16); }, 60);
        setTimeout(() => { setTemp('weak', 2000); E.sway(2000); }, 1700);
        break;
    }
    if (r.gained) P.nums(r.gained, r.anim === 'eat' || r.anim === 'drink' ? 700 : 150);
    if (r.coins) P.coin(r.coins);
  }
  // 每次互动之后：重新计时，互动结束一段时间后才会自己说话/做小动作
  function afterInteract() {
    const now = Date.now();
    lastInteract = now;
    clearTimeout(duoTimer);
    nextTalk = Math.max(nextTalk, now + rand(40e3, 80e3));
    nextAct = now + rand(8e3, 15e3);
  }
  const act = (name, ...a) => api.do(name, ...a).then((r) => { afterInteract(); play(r); return r; });

  // ───────── 主循环 ─────────
  const swing = { a: 0, v: 0 };
  let lastTs = 0, lastBody = [0, 0], talkUntil = 0, lean = 0;
  const winVel = { vx: 0, vy: 0 };


  // ───────── 视线：看向鼠标，鼠标不动时随机张望 ─────────
  const cursor = { x: 0, y: 0, t: 0 };
  let glance = { x: 0, y: 0, until: 0 };
  function lookTarget(now) {
    if (now - cursor.t < 5000) {
      const r = petRect(), hx = r.left + 222 * K, hy = r.top + 150 * K;
      // 距离越近越灵敏；离得远时也会明显转向鼠标那一侧
      const dx = cursor.x - hx, dy = cursor.y - hy;
      const f = (v) => Math.sign(v) * Math.min(1, Math.pow(Math.abs(v) / 200, 0.7));
      return { x: f(dx), y: f(dy) * 0.9 };
    }
    if (now > glance.until) {
      glance = Math.random() < 0.45 ? { x: 0, y: 0 } : { x: rand(-0.8, 0.8), y: rand(-0.4, 0.5) };
      glance.until = now + rand(1500, 4500);
    }
    return glance;
  }
  const circle = { a: null, sum: 0, t0: 0, cool: 0 };
  let backCool = 0;
  const setCursor = (x, y) => {
    if (x === cursor.x && y === cursor.y) return;
    const now = Date.now(), gap = now - cursor.t;
    cursor.x = x; cursor.y = y; cursor.t = now;
    if (!state || state.sleeping || state.dead || dragging || falling) return;
    const r = petRect(), hx = r.left + 222 * K, hy = r.top + 160 * K;
    const dist = Math.hypot(x - hx, y - hy);
    // 离开很久后鼠标又出现在附近 → 惊讶
    if (gap > 90e3 && dist < 500 && now > backCool) {
      backCool = now + 60e3; lastInteract = now;
      setTemp('surprised', 1800); E.hop(1, 10); say(pick(L.back));
    }
    // 鼠标绕着脸转圈 → 转晕
    if (dist < 280 * U() + 60) {
      const a = Math.atan2(y - hy, x - hx);
      if (circle.a !== null && now - circle.t0 < 3000) {
        let d = a - circle.a; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
        circle.sum += d;
      } else { circle.sum = 0; circle.t0 = now; }
      circle.a = a;
      if (Math.abs(circle.sum) > Math.PI * 5 && now > circle.cool) { circle.cool = now + 20e3; circle.sum = 0; circle.a = null; act('interact', 'dizzyCircle'); }
      if (now - circle.t0 > 3000) { circle.t0 = now; circle.sum = 0; }
    } else circle.a = null;
  };
  // 主进程每 33ms 轮询一次全局鼠标位置。用它来判断鼠标在不在她身上、要不要让鼠标穿透窗口，
  // 不再只依赖「穿透时转发的 mousemove」——Windows 上这个转发偶尔会失效（切窗口/锁屏/弹菜单后），
  // 失效后窗口一直处于穿透状态，鼠标按下去点不到她，也就拖不动了。
  api.onCursor && api.onCursor((p) => {
    setCursor(p.x, p.y);
    if (dragging || press) return;
    const hit = hitPet({ clientX: p.x, clientY: p.y });
    setIgnore(!hit); setHover(hit);
  });
  api.onVel && api.onVel((v) => { winVel.vx = v.vx; winVel.vy = v.vy; });

  function frame(ts) {
    const now = Date.now(), t = ts / 1000;
    let tx = 0, ty = 0, sx = 1, sy = 1, rot = 0;
    const air = dragging || falling;
    const sleeping = state && state.sleeping && !air;
    const mood = baseMood();

    if (!air && !useLive) { // 呼吸（仿 Live2D 模式下由着色器负责）
      const per = sleeping ? 4.2 : 3.0, amp = sleeping ? 0.022 : 0.012, b = Math.sin(t * 2 * Math.PI / per);
      sy *= 1 + amp * b; sx *= 1 - amp * 0.5 * b;
    }
    if ((mood === 'sick' || mood === 'weak') && !air && !sleeping) rot += 1.6 * Math.sin(t * 2 * Math.PI * 0.35);
    if ((mood === 'hungry' || mood === 'thirsty' || mood === 'sad') && !air) ty += 1.5 * U();
    // 脏污层
    const dirt = state ? Game.dirtLevel(state) : 0;
    if (useLive) live.setDirt(dirt);
    else rig.style.filter = dirt > 0 ? `sepia(${(dirt * 0.45).toFixed(2)}) brightness(${(1 - dirt * 0.1).toFixed(2)})` : '';

    // 身体随视线轻微倾斜
    if (!air && !sleeping) { const lk = lookTarget(now); lean += (lk.x * 1.2 - lean) * 0.05; rot += lean; }

    // 被拎起时像钟摆一样摇晃
    const target = dragging ? clamp(dragVx * 0.9, -24, 24) : 0;
    swing.v += (target - swing.a) * 0.05; swing.v *= 0.86; swing.a += swing.v;
    rot += swing.a;
    if (dragging) { sy *= 1.015 + 0.005 * Math.sin(t * 5); sx *= 0.993; }

    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i], p = (ts - e.t0) / e.dur;
      if (p >= 1) { effects.splice(i, 1); continue; }
      const r = e.fn(Math.max(0, p), t) || {};
      tx += r.tx || 0; ty += r.ty || 0; sx *= r.sx || 1; sy *= r.sy || 1; rot += r.rot || 0;
    }
    rig.style.transformOrigin = air ? '50% 6%' : '50% 100%';
    rig.style.transform = `translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px) rotate(${rot.toFixed(2)}deg) scale(${sx.toFixed(4)},${sy.toFixed(4)})`;

    if (useLive) {
      const dt = lastTs ? (ts - lastTs) / 1000 : 0.016;
      // 身体速度（精灵像素/秒）= 窗口移动 + 自身动画位移
      const bx = tx / K, by = ty / K;
      const vx = winVel.vx * 60 / K + (bx - lastBody[0]) / Math.max(dt, 0.001);
      const vy = winVel.vy * 60 / K + (by - lastBody[1]) / Math.max(dt, 0.001);
      lastBody = [bx, by];
      winVel.vx *= 0.8; winVel.vy *= 0.8;
      const tempSprite = temp && now < temp.until ? temp.sprite : null;
      const mode = state && state.dead ? 'dead' : dragging ? 'lifted' : falling ? 'falling' : sleeping ? 'sleep' :
        tempSprite === 'happy' ? 'happy' : (tempSprite === 'smug' || tempSprite === 'tease') ? 'smug' : (tempSprite || mood);
      // 看鼠标时身体也会稍微往那边倾一点（仿 Live2D 的身体角度参数）
      live.update(dt, { look: lookTarget(now), vx, vy, rot, mode, talking: now < talkUntil });
      live.render();
    }
    lastTs = ts;

    // 眨眼
    if (now > nextBlink) {
      blinkUntil = now + 120;
      if (!doubleBlink && Math.random() < 0.25) { doubleBlink = true; nextBlink = now + 260; }
      else { doubleBlink = false; nextBlink = now + rand(2500, 6000); }
    }
    const s = currentSprite(now);
    if (s !== shown) showSprite(s, !(s === 'blink' || shown === 'blink' || shown === null));
    requestAnimationFrame(frame);
  }

  // ───────── 鼠标 ─────────
  let ignoring = true;
  const setIgnore = (v) => { if (v !== ignoring) { ignoring = v; api.setIgnoreMouse && api.setIgnoreMouse(v); } };
  // Undo the outer CSS animation before sampling the actually rendered layers.
  const local = (e) => {
    const r = petRect(), style = getComputedStyle(rig);
    const origin = style.transformOrigin.split(' ').map(parseFloat);
    const ox = origin[0] || 0, oy = origin[1] || 0;
    const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform);
    const p = matrix.inverse().transformPoint({ x: e.clientX - r.left - ox, y: e.clientY - r.top - oy });
    return { x: (p.x + ox) / K, y: (p.y + oy) / K };
  };
  const hitPet = (e) => {
    const p = local(e);
    if (useLive && live.hitTest) return live.hitTest(p.x, p.y);
    return maskHit(shown || 'idle', p.x, p.y) || maskHit(BASE[baseMood()], p.x, p.y);
  };
  const isHead = (p) => p.y < HEAD_LINE;

  let hoverTimer = 0, hovering = false;
  function setHover(v) {
    if (v === hovering) return;
    hovering = v; clearTimeout(hoverTimer);
    if (v) hoverTimer = setTimeout(() => { if (hovering && !dragging && !bubbleVisible()) { renderHud(); hud.classList.remove('hidden'); } }, 700);
    else hud.classList.add('hidden');
  }

  // 在头上来回移动鼠标 = 抚摸
  const rub = { lastX: null, dir: 0, flips: [], travel: 0, last: 0 };
  function rubDetect(e, hit) {
    if (!hit || !isHead(local(e))) { rub.lastX = null; return; }
    const now = Date.now();
    if (rub.lastX != null) {
      const dx = e.clientX - rub.lastX;
      if (Math.abs(dx) >= 2) { const d = Math.sign(dx); if (d !== rub.dir) { rub.dir = d; rub.flips.push(now); } rub.travel += Math.abs(dx); }
    }
    rub.lastX = e.clientX;
    rub.flips = rub.flips.filter((t) => now - t < 1500);
    if (!rub.flips.length) rub.travel = 0;
    if (rub.flips.length >= 5 && rub.travel > 60 && now - rub.last > 2500) {
      rub.last = now; rub.flips = []; rub.travel = 0; act('interact', 'pet');
    }
  }

  document.addEventListener('mousemove', (e) => {
    setCursor(e.clientX, e.clientY);
    if (dragging || press) return;
    const hit = hitPet(e);
    setIgnore(!hit); setHover(hit); rubDetect(e, hit);
  });
  document.addEventListener('mouseleave', () => { if (!dragging && !press) { setIgnore(true); setHover(false); } });

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !hitPet(e)) return;
    press = { x: e.screenX, y: e.screenY, head: isHead(local(e)) };
    try { document.body.setPointerCapture(e.pointerId); } catch (_) {}
  });
  window.addEventListener('pointermove', (e) => {
    if (!press) return;
    // 按下后没收到松开事件（比如被别的窗口抢走）时，按键早已松开，清掉残留的按下状态
    if (!dragging && e.buttons === 0) { press = null; return; }
    if (!dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 5) beginDrag();
    if (dragging && api.dragMove) api.dragMove(e.screenX, e.screenY);
  });
  const release = (e) => {
    if (e && e.button !== undefined && e.button !== 0 && e.type === 'pointerup') return;
    if (dragging) endDrag(); else if (press && e && e.type === 'pointerup') onClick(press);
    press = null;
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('lostpointercapture', () => { if (dragging) release(); });
  window.addEventListener('blur', () => { if (dragging) release(); });
  window.addEventListener('contextmenu', (e) => { e.preventDefault(); if (hitPet(e)) { setHover(false); api.showMenu(e.clientX, e.clientY); } });
  window.addEventListener('dblclick', (e) => { if (hitPet(e)) api.openPanel('status'); });

  const clicks = [];
  function onClick(pr) {
    const now = Date.now();
    clicks.push(now);
    while (clicks.length && now - clicks[0] > 2500) clicks.shift();
    if (clicks.length >= 6) { clicks.length = 0; act('interact', 'angry'); return; }
    act('interact', pr.head ? 'pet' : 'poke');
  }

  let fallGuard = 0;
  function beginDrag() {
    dragging = true; dragVx = 0; setHover(false); shaken = false; shake.flips = [];
    shadow.style.opacity = 0;
    api.dragStart();
    act('interact', 'lift');
  }
  function endDrag() {
    dragging = false; falling = true;
    api.dragEnd();
    clearTimeout(fallGuard);
    fallGuard = setTimeout(() => { falling = false; }, 4000);
  }
  // 拎着来回甩 → 落地后转晕
  const shake = { dir: 0, flips: [] };
  let shaken = false, bounceImpact = 0;
  api.onDrag && api.onDrag((v) => {
    dragVx = v.vx;
    if (Math.abs(v.vx) > 8) {
      const d = Math.sign(v.vx), now = Date.now();
      if (d !== shake.dir) { shake.dir = d; shake.flips.push(now); }
      shake.flips = shake.flips.filter((t) => now - t < 1600);
      if (shake.flips.length >= 6) shaken = true;
    }
  });
  api.onFalling && api.onFalling(() => { falling = true; });
  api.onCeiling && api.onCeiling(() => { E.squash(0.2); E.shake(4, 400); P.bump(); setTemp('ouch', 3000); });
  api.onBounce && api.onBounce((b) => { bounceImpact = (b && b.impact) || 0; E.squash(0.15); });
  api.onLanded && api.onLanded(({ impact, air }) => {
    clearTimeout(fallGuard);
    falling = false; setIgnore(false);
    swing.a *= 0.3; swing.v *= 0.3;
    const hit = Math.max(impact || 0, bounceImpact); bounceImpact = 0;
    const wasShaken = shaken; shaken = false; shake.flips = [];
    if (wasShaken) { E.squash(0.12); act('interact', 'dizzy'); }
    else if (air && hit > 32) act('interact', 'landHard');      // 从高处摔下来（约 300 像素以上）
    else if (air && hit > 8) { E.squash(clamp(hit / 90, 0.08, 0.25)); act('interact', 'land'); }
    else E.squash(0.07);
  });
  api.onScale && api.onScale(setK);
  // 调试模式（面板勾选）：{ pose: 名字|null, lock } / { say: 台词 }
  api.onDebug && api.onDebug((cmd) => {
    if (!cmd) return;
    if ('pose' in cmd) {
      if (!cmd.pose) debugPose = null;
      else if (cmd.lock) debugPose = cmd.pose;
      else { debugPose = null; setTemp(cmd.pose, 3000); }
    }
    if (cmd.say) say(cmd.say);
  });

  // ───────── 悬停状态条 ─────────
  const HUD_ROWS = [['🍙', 'hunger', '#f6a04d'], ['💧', 'thirst', '#4db3f6'], ['💗', 'mood', '#f06fa8'], ['🛁', 'clean', '#5fd0b8'], ['❤️', 'health', '#e5566b']];
  let ccInfo = null;   // CC Switch 中转站余额（主进程推送）
  api.getCc && api.getCc().then((c) => { ccInfo = c; });
  api.onCc && api.onCc((c) => { ccInfo = c; if (!hud.classList.contains('hidden')) renderHud(); });
  function renderHud() {
    if (!state) return;
    const st = state.stats;
    const g = Date.now() < gainUntil ? gain : null;
    hud.style.gridTemplateColumns = g ? 'auto 64px auto' : '';
    const cell = (k) => (!g ? '' : g[k] ? `<b style="color:${g[k] > 0 ? '#3a9a5b' : '#d0485f'}">${g[k] > 0 ? '+' : ''}${g[k]}</b>` : '<b></b>');
    const fill = (k, c) => {
      const v = st[k], add = g && g[k] > 0 ? Math.min(g[k], v) : 0;
      if (!add) return c;
      const p = Math.round((v - add) / v * 100);
      return `linear-gradient(90deg, ${c} ${p}%, ${c}77 ${p}%)`;
    };
    hud.innerHTML = `<div class="title">${esc(state.name)} · ${esc(Game.statusText(state))}</div>` +
      HUD_ROWS.map(([e, k, c]) => `<span>${e}</span><div class="bar"><i style="width:${Math.round(st[k])}%;background:${fill(k, c)}"></i></div>${cell(k)}`).join('') +
      (ccInfo && ccInfo.pct != null ? `<span>💳</span><div class="bar"><i style="width:${Math.round(ccInfo.pct)}%;background:#9b7bf0"></i></div>${g ? '<b></b>' : ''}` : '');
  }
  const GAIN_MS = 3000;
  let gain = null, gainUntil = 0, gainTimer = 0;
  function showGain(g) {
    gain = g; gainUntil = Date.now() + GAIN_MS;
    clearTimeout(bubbleTimer); bubble.classList.add('hidden');
    renderHud(); hud.classList.remove('hidden');
    clearTimeout(gainTimer);
    gainTimer = setTimeout(() => { if (!hovering) hud.classList.add('hidden'); else renderHud(); }, GAIN_MS);
  }

  // ───────── 闲置行为 ─────────
  const AUTO_SLEEP_MS = 8 * 60e3;   // 8 分钟没人理就蜷起来睡觉
  let nextTalk = Date.now() + 25e3, nextAct = Date.now() + 8e3, nextZ = 0, nextSleepTalk = Date.now() + 30e3, nextStink = 0;
  let duoTimer = 0, yawned = false;
  const isNight = () => { const h = new Date().getHours(); return h >= 23 || h < 5; };

  // 屑 · 鄙视小剧场
  function smugShow() {
    const r = Math.random();
    clearTimeout(duoTimer);
    if (r < 0.45) { setTemp('smug', 3800); E.tilt(-3, 1400); say(pick(L.smug)); }
    else if (r < 0.8) { setTemp('tease', 3800); E.hop(1, 6); say(pick(L.fish)); }
    else {
      const [l1, l2] = pick(L.fishDuo);
      setTemp('tease', 3200); say(l1, 3100);
      duoTimer = setTimeout(() => { if (dragging || !state || state.sleeping) return; setTemp('smug', 3600); E.squash(0.05); say(l2); }, 3200);
    }
  }
  window.__petSmug = smugShow;   // 调试用
  window.__petAct = (...a) => act(...a);
  window.__petDbg = () => ({ hovering, temp, idleMs: Date.now() - lastInteract, yawned });

  setInterval(() => {
    // 每秒把穿透状态重新同步给主进程一次，防止两边记录的状态不一致
    if (api.setIgnoreMouse && !dragging && !press) api.setIgnoreMouse(ignoring);
    if (!state) return;
    const now = Date.now();
    const mood = baseMood();
    if (hovering && !dragging && !press && hud.classList.contains('hidden') && !bubbleVisible()) { renderHud(); hud.classList.remove('hidden'); }
    if (hovering) lastInteract = now;
    const quiet = now - lastInteract;   // 距离上次互动多久了
    if (state.dead) {   // 倒下了：只偶尔飘个小幽灵 / 提示去买复活药
      if (Math.random() < 0.25) P.ghost();
      if (now > nextTalk && quiet > 20e3 && !bubbleVisible() && !dragging) { say(pick(L.deadPoke)); nextTalk = now + rand(60e3, 120e3); }
      return;
    }
    if (state.sleeping) {
      if (now > nextZ && !dragging) { P.zzz(); nextZ = now + rand(1400, 2200); }
      if (now > nextSleepTalk && !bubbleVisible() && !dragging) { say(pick(L.sleepTalk), 2600); nextSleepTalk = now + rand(40e3, 90e3); }
      return;
    }
    if (dragging || falling) return;
    if (state.stats.clean < 25 && now > nextStink) { P.stink(); nextStink = now + rand(1800, 3200); }
    if (mood === 'sad' && Math.random() < 0.5) P.rain();
    const busy = hovering || press || quiet < 20e3;   // 正在互动 / 刚互动完：不自己插话
    if (busy && now > nextTalk) nextTalk = now + rand(8e3, 20e3);
    if (now > nextTalk && !bubbleVisible()) {
      if (mood === 'idle' && state.stats.clean >= 30 && Math.random() < 0.45) smugShow();
      else api.idleLine().then(say);
      nextTalk = now + (mood === 'idle' ? rand(70e3, 150e3) : rand(35e3, 70e3));
    }
    if (now > nextAct && !temp && !hovering && !press && quiet > 6e3) {
      if (mood === 'sick') { E.shiver(800); if (Math.random() < 0.5) P.sweat(); }
      else if (mood === 'weak') { E.sway(2600); if (Math.random() < 0.4) E.shiver(600); }
      else if (mood === 'hungry') { if (Math.random() < 0.5) setTemp('hungry', 2600); E.tilt(rand(-4, 4), 1600); }
      else if (mood === 'thirsty') { P.sweat(); E.tilt(rand(-3, 3), 1400); }
      else if (mood === 'sad') { E.tilt(rand(-2, 2), 2000); }
      else {
        const r = Math.random();
        if (isNight() && r < 0.15) { setTemp('yawn', 2800); if (!bubbleVisible()) say(pick(L.nightYawn)); }
        else if (r < 0.25 && !bubbleVisible()) smugShow();                // 随机鄙视
        else if (r < 0.36) { setTemp('smug', 3200); E.tilt(-2, 1200); if (!bubbleVisible() && Math.random() < 0.5) say(pick(L.smug)); } // 待机时屑一下（和肥鱼无关）
        else if (r < 0.5) E.hop(1, 8); else if (r < 0.75) E.tilt(rand(-5, 5), 1400); else E.sway();
      }
      nextAct = now + rand(7e3, 16e3);
    }
    if (!yawned && now - lastInteract > AUTO_SLEEP_MS - 60e3 && !temp) { yawned = true; setTemp('yawn', 2800); E.sway(2800); say(pick(L.yawn)); }
    if (now - lastInteract < 5000) yawned = false;
    if (now - lastInteract > AUTO_SLEEP_MS) { lastInteract = now; yawned = false; act('toggleSleep', true); }
  }, 1000);

  // ───────── 状态变化时的台词 ─────────
  let prevCond = null, prevDirty = null, reactTimer = 0;
  const condOf = (s) => Game.mood(Object.assign({}, s, { sleeping: false }));
  function onStateChange(s) {
    const cond = condOf(s), dirty = s.stats.clean < 25;
    if (prevCond === null || s.sleeping) { prevCond = cond; prevDirty = dirty; return; }
    let line = null, anim = null;
    if (cond !== prevCond) {
      if (prevCond === 'dead') { /* 复活时 play('revive') 已经说过话了 */ }
      else if (L.enter[cond]) { line = L.enter[cond]; anim = cond; }
      else if (L.leave[prevCond]) { line = L.leave[prevCond]; anim = 'recover'; }
    } else if (dirty && !prevDirty) { line = L.enter.dirty; anim = 'dirty'; }
    prevCond = cond; prevDirty = dirty;
    if (!line) return;
    clearTimeout(reactTimer);
    // 刚吃完东西等情况，先让当前的气泡说完
    reactTimer = setTimeout(() => {
      if ((dragging && anim !== 'dead') || state.sleeping) return;
      say(line, anim === 'dead' ? 6000 : undefined);
      if (anim === 'dead') { E.squash(0.18); P.ghost(); P.ghost(); return; }
      if (anim === 'recover') { setTemp('happy', 1800); E.hop(1, 10); P.sparkle(3); }
      else if (anim === 'dirty') { E.shiver(600); P.stink(); P.stink(); }
      else if (anim === 'sick' || anim === 'weak') E.shiver(800);
      else E.squash(0.06);
    }, bubbleVisible() && anim !== 'dead' ? 3400 : 300);
  }

  // ───────── 启动 ─────────
  api.onState((s) => { state = s; onStateChange(s); if (!hud.classList.contains('hidden')) renderHud(); });
  api.onPlay((r) => { afterInteract(); play(r); });
  Promise.all([api.get(), live.ready]).then(([d, ok]) => {
    state = d.state;
    onStateChange(state);
    useLive = !!ok;
    if (useLive) rig.classList.add('gl');
    showSprite(currentSprite(Date.now()), false);
    requestAnimationFrame(frame);
    setTimeout(() => { E.hop(1, 10); say(state.dead ? pick(L.deadPoke) : state.sleeping ? pick(L.sleepTalk) : `${Game.greeting()}`); }, 400);
  });
})();
