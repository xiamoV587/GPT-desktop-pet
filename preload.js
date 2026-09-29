// 预加载脚本：把主进程能力安全地暴露给页面（window.petAPI）
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const f = (e, ...a) => cb(...a);
  ipcRenderer.on(ch, f);
  return () => ipcRenderer.removeListener(ch, f);
};

contextBridge.exposeInMainWorld('petAPI', {
  isDesktop: true,
  get: () => ipcRenderer.invoke('game:get'),
  do: (name, ...args) => ipcRenderer.invoke('game:do', name, ...args),
  idleLine: () => ipcRenderer.invoke('game:idleLine'),
  onState: on('game:state'),
  onPlay: on('pet:play'),
  onPanelTab: on('panel:tab'),

  setIgnoreMouse: (v) => ipcRenderer.send('win:ignore', v),
  dragStart: () => ipcRenderer.send('win:dragStart'),
  dragEnd: () => ipcRenderer.send('win:dragEnd'),
  onDrag: on('win:drag'),
  onVel: on('win:vel'),
  onCursor: on('win:cursor'),
  onFalling: on('win:falling'),
  onCeiling: on('win:ceiling'),
  onBounce: on('win:bounce'),
  onLanded: on('win:landed'),
  onScale: on('win:scale'),
  onDebug: on('debug:cmd'),
  onCc: on('cc:info'),
  getCc: () => ipcRenderer.invoke('cc:get'),
  refreshCc: () => ipcRenderer.send('cc:refresh'),
  refreshCcWait: () => ipcRenderer.invoke('cc:refreshWait'),
  openCcSite: () => ipcRenderer.send('cc:open'),
  setCcConfig: (c) => ipcRenderer.send('cc:config', c),
  debug: (cmd) => ipcRenderer.send('debug:cmd', cmd),
  showMenu: () => ipcRenderer.send('win:menu'),

  openPanel: (tab) => ipcRenderer.send('panel:open', tab),
  closePanel: () => ipcRenderer.send('panel:close'),
  minimizePanel: () => ipcRenderer.send('panel:minimize'),
});
