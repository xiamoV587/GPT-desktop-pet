// Electron 主进程：透明桌宠窗口、面板窗口、托盘、右键菜单、拖拽/掉落物理、存档
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 用自定义协议 app:// 加载页面：同源，WebGL 才能读取本地贴图
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const appURL = (rel, query) => 'app://pet/' + rel + (query ? '?' + new URLSearchParams(query) : '');
const Game = require('./src/game.js');
const CCSwitch = require('./src/ccswitch.js');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const SPRITE_W = 444, SPRITE_H = 420;
const SCALES = { small: 0.42, medium: 0.55, large: 0.72 };
const TOP_ROOM = 140;   // 窗口上方给气泡/特效留的空间
const SIDE_ROOM = 60;

let petWin = null, panelWin = null, tray = null, engine = null;
let settings = { scale: 'medium', fallToGround: true, alwaysOnTop: true, x: null, y: null, ccApp: 'codex', ccMax: 20 };

const dataDir = () => app.getPath('userData');
const savePath = () => path.join(dataDir(), 'save.json');
const settingsPath = () => path.join(dataDir(), 'settings.json');

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJSON(p, obj) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p + '.tmp', JSON.stringify(obj, null, 1)); fs.renameSync(p + '.tmp', p); }
  catch (e) { console.error('保存失败', e); }
}
const saveSettings = () => writeJSON(settingsPath(), settings);

function petSize() {
  const k = SCALES[settings.scale] || SCALES.medium;
  const sw = Math.round(SPRITE_W * k), sh = Math.round(SPRITE_H * k);
  return { k, sw, sh, w: sw + SIDE_ROOM * 2, h: sh + TOP_ROOM };
}

function workAreaFor(bounds) { return screen.getDisplayMatching(bounds).workArea; }

// 地面：窗口底边贴着任务栏上沿
function groundY(bounds) { const wa = workAreaFor(bounds); return wa.y + wa.height - bounds.height; }

function clampToScreen(x, y, w, h) {
  const wa = workAreaFor({ x, y, width: w, height: h });
  x = Math.max(wa.x - SIDE_ROOM, Math.min(wa.x + wa.width - w + SIDE_ROOM, x));
  y = Math.max(wa.y - TOP_ROOM, Math.min(wa.y + wa.height - h, y));
  // | 0：Math.round 会产生 -0（以及异常时的 NaN），setPosition 只接受 Int32，传 -0 会抛 "conversion failure"
  return [Math.round(x) | 0, Math.round(y) | 0];
}

function send(win, ch, ...a) { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); }
function broadcast(ch, ...a) { send(petWin, ch, ...a); send(panelWin, ch, ...a); }

function createPetWindow() {
  const s = petSize();
  const wa = screen.getPrimaryDisplay().workArea;
  let x = settings.x ?? (wa.x + wa.width - s.w - 80);
  let y = settings.y ?? (wa.y + wa.height - s.h);
  [x, y] = clampToScreen(x, y, s.w, s.h);

  petWin = new BrowserWindow({
    x, y, width: s.w, height: s.h,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: settings.alwaysOnTop, maximizable: false, minimizable: false,
    fullscreenable: false, backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  if (settings.alwaysOnTop) petWin.setAlwaysOnTop(true, 'floating');
  petWin.setIgnoreMouseEvents(true, { forward: true });
  petWin.loadURL(appURL('src/pet.html', { scale: String(s.k) }));
  petWin.on('moved', rememberPos);
  petWin.on('closed', () => { petWin = null; });
}

let posTimer = null;
function rememberPos() {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    if (!petWin) return;
    const b = petWin.getBounds(); settings.x = b.x; settings.y = b.y; saveSettings();
  }, 500);
}

function openPanel(tab = 'status') {
  if (panelWin && !panelWin.isDestroyed()) {
    send(panelWin, 'panel:tab', tab); panelWin.show(); panelWin.focus(); return;
  }
  const pb = petWin ? petWin.getBounds() : screen.getPrimaryDisplay().workArea;
  const W = 440, H = 600;
  const wa = workAreaFor(pb);
  let x = pb.x - W - 10; if (x < wa.x) x = pb.x + pb.width + 10;
  x = Math.max(wa.x, Math.min(wa.x + wa.width - W, x));
  const y = Math.max(wa.y, Math.min(wa.y + wa.height - H, pb.y + pb.height - H));
  panelWin = new BrowserWindow({
    x, y, width: W, height: H, frame: false, transparent: true, resizable: false, maximizable: false,
    alwaysOnTop: settings.alwaysOnTop, backgroundColor: '#00000000', title: '桌宠面板',
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  panelWin.loadURL(appURL('src/panel.html', { tab }));
  panelWin.on('closed', () => { panelWin = null; });
}

// ───────── 执行游戏操作，并让桌宠播放对应动画 ─────────
// fromPet=true 时由桌宠窗口自己播放返回结果，这里不再转发，避免动画播两遍
function doAction(name, args = [], fromPet = false) {
  const r = engine.do(name, ...args);
  if (!fromPet && r && (r.anim || r.say)) send(petWin, 'pet:play', r);
  refreshTray();
  return r;
}

// ───────── 拖拽：主进程轮询鼠标位置移动窗口，鼠标离开窗口也不会丢 ─────────
let drag = null, fall = null;
function dragStart() {
  if (!petWin) return;
  stopFall();
  const c = screen.getCursorScreenPoint(); const b = petWin.getBounds();
  drag = { ox: c.x - b.x, oy: c.y - b.y, last: c, t: Date.now(), vx: 0, vy: 0 };
  drag.timer = setInterval(() => {
    if (!petWin) return dragEnd();
    const p = screen.getCursorScreenPoint(); const now = Date.now(); const dt = Math.max(1, now - drag.t);
    drag.vx = drag.vx * 0.6 + ((p.x - drag.last.x) / dt * 16) * 0.4;
    drag.vy = drag.vy * 0.6 + ((p.y - drag.last.y) / dt * 16) * 0.4;
    drag.last = p; drag.t = now;
    const bb = petWin.getBounds();
    const [x, y] = clampToScreen(p.x - drag.ox, p.y - drag.oy, bb.width, bb.height);
    petWin.setPosition(x, y);
    send(petWin, 'win:drag', { vx: drag.vx, vy: drag.vy });
    send(petWin, 'win:vel', { vx: drag.vx, vy: drag.vy });
  }, 16);
}
function dragEnd() {
  if (!drag) return;
  clearInterval(drag.timer);
  const v = { vx: drag.vx, vy: drag.vy }; drag = null;
  if (!petWin) return;
  if (settings.fallToGround) startFall(v.vx, Math.min(v.vy, 20));
  else { send(petWin, 'win:landed', { impact: 0, air: false }); rememberPos(); }
}
function startFall(vx, vy) {
  stopFall();
  const b = petWin.getBounds();
  fall = { x: b.x, y: b.y, vx: Math.max(-40, Math.min(40, vx)), vy, bounced: false, bumped: false };
  const air = groundY(b) - b.y > 4;
  if (!air) { send(petWin, 'win:landed', { impact: 0, air: false }); rememberPos(); fall = null; return; }
  send(petWin, 'win:falling');
  fall.timer = setInterval(() => {
    if (!petWin) return stopFall();
    const bb = petWin.getBounds();
    fall.vy += 1.6; fall.vx *= 0.97;
    fall.x += fall.vx; fall.y += fall.vy;
    const wa = workAreaFor(bb);
    if (fall.x < wa.x - SIDE_ROOM || fall.x > wa.x + wa.width - bb.width + SIDE_ROOM) { fall.vx = -fall.vx * 0.5; }
    // 扔太高：头撞到屏幕顶，立刻反弹往下掉（原来 fall.y 会一直在屏幕外，看起来卡在顶上下不来）
    const top = wa.y - TOP_ROOM;
    if (fall.y <= top && fall.vy < 0) {
      if (!fall.bumped) { fall.bumped = true; send(petWin, 'win:ceiling', { impact: -fall.vy }); }
      fall.y = top; fall.vy = Math.min(4, -fall.vy * 0.15);
    }
    const gy = groundY(bb);
    let landed = false, impact = 0;
    if (fall.y >= gy) {
      fall.y = gy; impact = fall.vy;
      if (!fall.bounced && fall.vy > 14) { fall.vy = -fall.vy * 0.25; fall.bounced = true; send(petWin, 'win:bounce', { impact }); }
      else landed = true;
    }
    const [x, y] = clampToScreen(fall.x, fall.y, bb.width, bb.height);
    send(petWin, 'win:vel', { vx: x - bb.x, vy: y - bb.y });
    petWin.setPosition(x, y);
    if (landed) { stopFall(); send(petWin, 'win:landed', { impact, air: true }); rememberPos(); }
  }, 16);
}
function stopFall() { if (fall) { clearInterval(fall.timer); fall = null; } }

// ───────── 右键菜单 / 托盘 ─────────
function itemsMenu(types, emptyLabel) {
  const inv = engine.state.inventory;
  const list = Object.keys(inv).filter((id) => types.includes(Game.ITEMS[id].type));
  if (!list.length) return [{ label: emptyLabel, enabled: false }, { type: 'separator' }, { label: '去商店买…', click: () => openPanel('shop') }];
  return list.map((id) => {
    const it = Game.ITEMS[id];
    return { label: `${it.emoji} ${it.name} ×${inv[id]}`, click: () => doAction('use', [id]) };
  });
}

function buildMenu() {
  const s = engine.state;
  return Menu.buildFromTemplate([
    // 没装 CC Switch 的电脑：余额和刷新两行都不显示
    ...(cc.missing ? [] : [
      { label: ccLabel(), click: openCcSite },
      { label: '🔄 刷新Token余额', click: () => refreshCc() },
      { type: 'separator' },
    ]),
    { label: `${s.name}  ·  💰${s.coins}`, enabled: false },
    { label: `状态：${Game.statusText(s)}`, enabled: false },
    { type: 'separator' },
    { label: '🍙 喂食', submenu: itemsMenu(['food'], '背包里没有食物') },
    { label: '🥤 喂水', submenu: itemsMenu(['drink'], '背包里没有饮品') },
    { label: '💊 吃药', submenu: itemsMenu(['medicine'], '背包里没有药') },
    { label: '🛁 洗澡 / 玩耍', submenu: itemsMenu(['clean', 'toy'], '背包里没有道具') },
    { label: s.sleeping ? '☀️ 叫醒她' : '🌙 让她睡觉', click: () => doAction('toggleSleep') },
    { type: 'separator' },
    { label: '📊 状态', click: () => openPanel('status') },
    { label: '🛒 商店', click: () => openPanel('shop') },
    { label: '🎒 背包', click: () => openPanel('bag') },
    { type: 'separator' },
    { label: '设置', submenu: [
      { label: '大小', submenu: [['small', '小'], ['medium', '中'], ['large', '大']].map(([k, n]) => ({
        label: n, type: 'radio', checked: settings.scale === k, click: () => setScale(k) })) },
      { label: '松手后落到任务栏', type: 'checkbox', checked: settings.fallToGround, click: (m) => { settings.fallToGround = m.checked; saveSettings(); } },
      { label: '总在最前', type: 'checkbox', checked: settings.alwaysOnTop, click: (m) => setOnTop(m.checked) },
      { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked }) },
      { label: '回到屏幕右下角', click: resetPosition },
    ] },
    { label: petWin && petWin.isVisible() ? '隐藏桌宠' : '显示桌宠', click: togglePet },
    { label: '退出', click: () => app.quit() },
  ]);
}

function setScale(k) {
  settings.scale = k; saveSettings();
  if (!petWin) return;
  const old = petWin.getBounds(); const s = petSize();
  const [x, y] = clampToScreen(old.x + (old.width - s.w) / 2, old.y + old.height - s.h, s.w, s.h);
  petWin.setBounds({ x, y, width: s.w, height: s.h });
  send(petWin, 'win:scale', s.k);
}
function setOnTop(v) {
  settings.alwaysOnTop = v; saveSettings();
  if (petWin) petWin.setAlwaysOnTop(v, 'floating');
  if (panelWin) panelWin.setAlwaysOnTop(v);
}
function resetPosition() {
  if (!petWin) return;
  const s = petSize(); const wa = screen.getPrimaryDisplay().workArea;
  petWin.setBounds({ x: wa.x + wa.width - s.w - 80, y: wa.y + wa.height - s.h, width: s.w, height: s.h });
  rememberPos();
}
function togglePet() {
  if (!petWin) return;
  if (petWin.isVisible()) petWin.hide(); else { petWin.showInactive(); }
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const s = engine.state;
  tray.setToolTip(`${s.name}｜${Game.statusText(s)}｜💰${s.coins}`);
  tray.setContextMenu(buildMenu());
}

// ───────── CC Switch 中转站余额 ─────────
let cc = { at: 0 }, ccBusy = null;
const ccPayload = () => {
  const max = Number(settings.ccMax) > 0 ? Number(settings.ccMax) : 20;
  const pct = cc.remaining != null ? Math.max(0, Math.min(100, cc.remaining / max * 100)) : null;
  return { ...cc, max, pct, app: settings.ccApp };
};
function ccLabel() {
  const p = ccPayload();
  if (p.error) return `💳 词元：${p.error}`;
  if (p.remaining == null) return '💳 词元余额：查询中…';
  const sym = /usd/i.test(p.unit) ? '$' : '';
  return `💳 ${p.name}  剩余 ${sym}${p.remaining.toFixed(2)}${sym ? '' : ' ' + p.unit}（${Math.round(p.pct)}%）`;
}
function refreshCc() {
  if (ccBusy) return ccBusy;
  ccBusy = CCSwitch.query(settings.ccApp === 'claude' ? 'claude' : 'codex')
    .then((r) => { cc = { ...r, at: Date.now() }; })
    .catch((e) => {
      if (e && e.code === 'NO_CCSWITCH') cc = { missing: true, at: Date.now() };
      else cc = { ...cc, missing: false, error: String(e.message || e).slice(0, 40), at: Date.now() };
    })
    .finally(() => { ccBusy = null; broadcast('cc:info', ccPayload()); refreshTray(); });
  return ccBusy;
}
// 和 CC Switch 一样：点击余额打开中转站网址
function openCcSite() {
  if (cc.website && /^https?:\/\//i.test(cc.website)) shell.openExternal(cc.website);
}

// ───────── IPC ─────────
ipcMain.handle('game:get', () => ({ state: engine.state, items: Game.ITEMS, typeNames: Game.TYPE_NAMES, statNames: Game.STAT_NAMES }));
ipcMain.handle('game:do', (e, name, ...args) => doAction(name, args, !!petWin && e.sender === petWin.webContents));
ipcMain.handle('game:idleLine', () => engine.idleLine());
ipcMain.on('win:ignore', (e, v) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setIgnoreMouseEvents(v, { forward: true }); });
ipcMain.on('win:dragStart', dragStart);
ipcMain.on('win:dragEnd', dragEnd);
// 右键时余额超过 1 分钟没更新就先刷新一下（最多等 2 秒），保证菜单里是当前数字
ipcMain.on('win:menu', async () => {
  if (!petWin) return;
  if (Date.now() - cc.at > 60e3) await Promise.race([refreshCc(), new Promise((r) => setTimeout(r, 2000))]);
  buildMenu().popup({ window: petWin });
});
ipcMain.on('panel:open', (e, tab) => openPanel(tab));
ipcMain.on('panel:close', () => { if (panelWin) panelWin.close(); });
ipcMain.on('panel:minimize', () => { if (panelWin) panelWin.minimize(); });
ipcMain.on('debug:cmd', (e, cmd) => send(petWin, 'debug:cmd', cmd));
ipcMain.handle('cc:get', () => ccPayload());
ipcMain.on('cc:refresh', () => refreshCc());
ipcMain.handle('cc:refreshWait', () => refreshCc().then(ccPayload));
ipcMain.on('cc:open', openCcSite);
ipcMain.on('cc:config', (e, c) => {
  if (c && Number(c.max) > 0) settings.ccMax = Number(c.max);
  const appChanged = c && (c.app === 'codex' || c.app === 'claude') && c.app !== settings.ccApp;
  if (appChanged) { settings.ccApp = c.app; cc = { at: 0 }; }
  saveSettings();
  if (appChanged) refreshCc(); else { broadcast('cc:info', ccPayload()); refreshTray(); }
});

// 全局鼠标位置（让她的视线跟着鼠标，即使鼠标不在窗口上）
let lastCursor = null;
function pollCursor() {
  if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
  const p = screen.getCursorScreenPoint(), b = petWin.getBounds();
  const rel = { x: p.x - b.x, y: p.y - b.y };
  if (lastCursor && lastCursor.x === rel.x && lastCursor.y === rel.y) return;
  lastCursor = rel; send(petWin, 'win:cursor', rel);
}

app.whenReady().then(() => {
  const root = path.resolve(__dirname);
  protocol.handle('app', (req) => {
    const file = path.resolve(root, decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, ''));
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  setInterval(pollCursor, 33);
  settings = Object.assign(settings, readJSON(settingsPath()) || {});
  engine = Game.createEngine({ load: () => readJSON(savePath()), save: (s) => writeJSON(savePath(), s) });
  engine.subscribe((s) => broadcast('game:state', s));
  setInterval(() => engine.tick(), 30e3);

  createPetWindow();
  refreshCc();
  setInterval(refreshCc, 5 * 60e3);
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets/tray.png')));
    tray.on('click', togglePet);
    refreshTray();
    setInterval(refreshTray, 60e3);
  } catch (e) { console.error('托盘创建失败', e); }
});

app.on('second-instance', () => { if (petWin) { petWin.showInactive(); } });
app.on('window-all-closed', () => {});
app.on('before-quit', () => { if (engine) engine.tick(); });
