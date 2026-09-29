// 面板窗口：状态 / 商店 / 背包
(() => {
  'use strict';
  const api = window.petAPI ||
    (window.parent !== window && window.parent.createPreviewAPI ? window.parent.createPreviewAPI('panel', window) : null);
  const Game = window.PetGame;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let state = null, ITEMS = Game.ITEMS, TYPES = Game.TYPE_NAMES, NAMES = Game.STAT_NAMES;
  let shopFilter = 'all', bagFilter = 'all';

  const STAT_ROWS = [
    ['hunger', '🍙', '#f6a04d'], ['thirst', '💧', '#4db3f6'], ['mood', '💗', '#f06fa8'],
    ['clean', '🛁', '#5fd0b8'], ['health', '❤️', '#e5566b'],
  ];
  const SPRITE_OF = Game.SPRITE_OF;

  // ───────── 通用 ─────────
  let toastTimer = 0;
  function toast(msg) {
    if (!msg) return;
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
  }
  function tags(it) {
    const out = [];
    for (const k in it.effects) { const v = it.effects[k]; out.push(`<span class="tag ${v < 0 ? 'neg' : ''}">${NAMES[k]} ${v > 0 ? '+' : ''}${v}</span>`); }
    if (it.cure) out.unshift('<span class="tag cure">治病</span>');
    return `<div class="tags">${out.join('')}</div>`;
  }
  function filters(el, current, onPick, counts) {
    const keys = ['all', ...Object.keys(TYPES)];
    el.innerHTML = keys.map((k) => {
      const n = counts ? counts[k] || 0 : null;
      return `<button data-k="${k}" class="${k === current ? 'on' : ''}">${k === 'all' ? '全部' : TYPES[k]}${n != null ? ` ${n}` : ''}</button>`;
    }).join('');
    el.onclick = (e) => { const b = e.target.closest('button'); if (b) onPick(b.dataset.k); };
  }
  async function run(name, ...args) {
    const r = await api.do(name, ...args);
    if (r) toast(r.msg || (r.ok === false ? r.say : ''));
    return r;
  }

  // ───────── 标签页 ─────────
  function setTab(tab) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('on', s.id === 'tab-' + tab));
  }
  $('tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); };

  // ───────── 渲染 ─────────
  function render() {
    if (!state) return;
    const s = state, st = s.stats;
    $('headName').textContent = s.name;
    $('headStatus').textContent = Game.statusText(s);
    $('headCoins').textContent = s.coins;

    // 状态
    $('petName').textContent = s.name;
    const mood = Game.mood(s);
    $('portrait').src = `../assets/sprites/${SPRITE_OF[mood]}.png`;
    const chip = $('statusChip');
    chip.textContent = Game.statusText(s);
    chip.className = 'chip' + (s.sick || st.health < 30 ? ' bad' : mood !== 'idle' ? ' warn' : '');
    $('days').textContent = Math.floor((Date.now() - s.born) / 86400000) + 1;
    const signed = s.signinDate === new Date().toLocaleDateString('sv-SE');
    $('btnSignin').disabled = signed;
    $('btnSignin').textContent = signed ? '✅ 已签到' : '📅 每日签到';
    $('btnSleep').textContent = s.sleeping ? '☀️ 叫醒' : '🌙 睡觉';
    $('stats').innerHTML = STAT_ROWS.map(([k, e, c]) => {
      const v = Math.round(st[k]);
      return `<div class="stat ${v < 25 ? 'low' : ''}"><span class="e">${e}</span><span class="n">${NAMES[k]}</span>
        <div class="track"><i style="width:${v}%;background-color:${c}"></i></div><span class="v">${v}</span></div>`;
    }).join('');
    $('stats').innerHTML += ccRow();
    $('tip').innerHTML = tipText(s);
    if ($('dbgDiff') && document.activeElement !== $('dbgDiff')) $('dbgDiff').value = s.difficulty || 'normal';

    // 商店
    filters($('shopFilters'), shopFilter, (k) => { shopFilter = k; render(); });
    $('shopGrid').innerHTML = Object.entries(ITEMS).filter(([, it]) => shopFilter === 'all' || it.type === shopFilter).map(([id, it]) => `
      <div class="item">
        <div class="top"><div class="emo">${it.emoji}</div>
          <div><div class="nm">${esc(it.name)}</div><div class="pr">💰 ${it.price}</div></div>
          ${s.inventory[id] ? `<span class="owned">已有 ${s.inventory[id]}</span>` : ''}</div>
        <div class="ds">${esc(it.desc)}</div>
        ${tags(it)}
        <div class="acts">
          <button class="btn primary" data-buy="${id}" data-q="1" ${s.coins < it.price ? 'disabled' : ''}>购买</button>
          <button class="btn" data-buy="${id}" data-q="5" ${s.coins < it.price * 5 ? 'disabled' : ''}>×5</button>
        </div>
      </div>`).join('');

    // 背包
    const inv = s.inventory;
    const counts = { all: 0 };
    for (const id in inv) { counts.all += inv[id]; const t = ITEMS[id].type; counts[t] = (counts[t] || 0) + inv[id]; }
    filters($('bagFilters'), bagFilter, (k) => { bagFilter = k; render(); }, counts);
    const list = Object.keys(inv).filter((id) => bagFilter === 'all' || ITEMS[id].type === bagFilter);
    $('bagList').innerHTML = list.length ? list.map((id) => {
      const it = ITEMS[id];
      const verb = { food: '喂食', drink: '喂水', medicine: '吃药', clean: '洗澡', toy: '玩耍' }[it.type];
      return `<div class="row"><div class="emo">${it.emoji}<span class="cnt">${inv[id]}</span></div>
        <div class="mid"><div class="nm">${esc(it.name)}</div>${tags(it)}</div>
        <button class="btn primary" data-use="${id}">${verb}</button></div>`;
    }).join('') : `<div class="empty">背包空空的…<br><button class="btn primary" data-goshop>去商店逛逛</button></div>`;
  }

  // CC Switch 中转站余额槽（和属性槽同样式；100% 对应的金额在调试模式里设置）
  let cc = null, ccSpin = false;
  function ccRow() {
    if (!cc || cc.missing) return '';   // 没装 CC Switch 就不显示这一行
    const low = cc.pct != null && cc.pct < 25;
    const tip = cc.error ? cc.error : cc.remaining != null ? `${cc.name}：剩余 ${cc.remaining.toFixed(2)} ${cc.unit}（100% = ${cc.max}）` : '查询中…';
    // 点图标/「词元」= 刷新（图标转圈），点槽 = 打开中转站网址
    return `<div class="stat cc ${low ? 'low' : ''}" title="${esc(tip)}"><span class="e ccRefresh${ccSpin ? ' spin' : ''}" title="刷新">${ccSpin ? '🔄' : '💳'}</span><span class="n ccRefresh" title="刷新">词元</span>
      <div class="track ccOpen" title="${esc(tip)}（点击打开网站）"><i style="width:${cc.pct != null ? Math.round(cc.pct) : 0}%;background-color:#9b7bf0"></i></div><span class="v">${cc.pct != null ? Math.round(cc.pct) + '%' : '--'}</span></div>`;
  }
  $('stats').addEventListener('click', async (e) => {
    if (e.target.closest('.ccOpen')) { if (api.openCcSite) api.openCcSite(); return; }
    if (!e.target.closest('.ccRefresh') || ccSpin || !api.refreshCcWait) return;
    ccSpin = true; render();
    const t0 = Date.now();
    try { cc = await api.refreshCcWait(); } catch (_) { /* 失败信息由主进程写进 cc.error */ }
    setTimeout(() => { ccSpin = false; render(); if (cc && cc.error) toast(cc.error); }, Math.max(0, 600 - (Date.now() - t0)));   // 至少转半圈多，看得出刷新过
  });
  api.getCc && api.getCc().then((c) => { cc = c; fillCc(); render(); });
  api.onCc && api.onCc((c) => { cc = c; fillCc(); render(); });
  function fillCc() {
    if (!cc || document.activeElement === $('dbgCcMax')) return;
    $('dbgCcMax').value = cc.max; $('dbgCcApp').value = cc.app || 'codex';
  }

  function tipText(s) {
    const st = s.stats, t = [];
    if (s.dead) return '💀 她倒下了……去 <b>商店</b> 买一瓶 <b>💖复活药</b>（50 金币）在背包里使用。<br>倒下期间属性不会变化，金币仍会继续增加（3 倍速），不会死档。复活后各项都很低，记得马上喂饭喂水！';
    if (s.sleeping) t.push('😴 她正在睡觉，睡觉时心情和健康恢复更快，饥饿也下降得更慢。');
    if (s.sick) t.push('🤒 她生病了！去背包给她吃 <b>感冒药</b> 或 <b>万能药水</b>。');
    if (st.hunger < 30) t.push('🍙 肚子饿了，喂点吃的吧。');
    if (st.thirst < 30) t.push('💧 口渴了，给她喝点东西。');
    if (st.clean < 30) t.push('🛁 身上脏了，太脏容易生病，用 <b>泡泡浴</b> 洗洗吧。');
    if (st.mood < 30) t.push('💗 心情不好，摸摸头、陪她玩或者吃点甜的。');
    if (st.health < 40 && !s.sick) t.push('❤️ 健康值偏低，很容易生病，注意吃饱喝足。');
    if (!t.length) t.push('✨ 她现在很好！摸头（单击头部或在头上来回移动鼠标）会让她开心，还能得到金币。');
    const now = Date.now(), bf = Object.entries(s.buffs || {}).filter(([id, exp]) => exp > now && Game.BUFFS[id]);
    if (bf.length) t.push(bf.map(([id, exp]) => `${Game.BUFFS[id].emoji}${Game.BUFFS[id].name} 剩余 ${Math.ceil((exp - now) / 60000)} 分钟`).join('　'));
    if (s.difficulty && s.difficulty !== 'normal' && Game.DIFFICULTY[s.difficulty]) t.push(`难度：${Game.DIFFICULTY[s.difficulty].name}`);
    return t.join('<br>');
  }

  // ───────── 事件 ─────────
  document.body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.buy) await run('buy', b.dataset.buy, Number(b.dataset.q));
    else if (b.dataset.use) {
      const r = await api.do('use', b.dataset.use);
      if (r && r.ok === false) toast(r.say || r.msg);
      else if (r) toast(`${ITEMS[b.dataset.use].emoji} ${r.say || '使用成功'}`);
    } else if (b.hasAttribute('data-goshop')) setTab('shop');
  });
  $('btnSignin').onclick = () => run('signin');
  $('btnSleep').onclick = () => run('toggleSleep');
  $('btnClose').onclick = () => api.closePanel();
  $('btnMin').onclick = () => api.minimizePanel();

  $('btnRename').onclick = () => {
    document.querySelector('.renamerow').classList.remove('hidden');
    $('nameInput').value = state.name; $('nameInput').focus(); $('nameInput').select();
  };
  const doRename = async () => {
    const r = await run('rename', $('nameInput').value);
    if (r && r.ok) document.querySelector('.renamerow').classList.add('hidden');
  };
  $('btnNameOk').onclick = doRename;
  $('nameInput').onkeydown = (e) => {
    if (e.key === 'Enter') doRename();
    if (e.key === 'Escape') document.querySelector('.renamerow').classList.add('hidden');
  };

  let resetArmed = 0;
  $('btnReset').onclick = () => {
    const b = $('btnReset');
    if (!b.classList.contains('armed')) {
      b.classList.add('armed'); b.textContent = '再点一次确认遗弃（她会离开，所有进度清空）';
      clearTimeout(resetArmed);
      resetArmed = setTimeout(() => { b.classList.remove('armed'); b.textContent = '遗弃宠物'; }, 3000);
    } else { clearTimeout(resetArmed); b.classList.remove('armed'); b.textContent = '遗弃宠物'; run('reset'); }
  };

  // ───────── 调试模式：自由切换姿势 / 说任意台词 ─────────
  const POSES = ['idle', 'blink', 'happy', 'lifted', 'eat', 'drink', 'sick', 'hungry', 'angry', 'shy',
    'smug', 'tease', 'sleepcurl', 'starve', 'thirsty', 'sad', 'weak',
    'dizzy', 'surprised', 'yawn', 'tsun', 'proud', 'ouch', 'dead'];
  const dbgLines = {};   // 分类 → 台词数组（把 LINES 里的字符串/对象/二维数组都摊平成字符串）
  const flat = (v) => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(flat) : v && typeof v === 'object' ? Object.values(v).flatMap(flat) : [];
  for (const [k, v] of Object.entries(Game.LINES)) { const a = flat(v); if (a.length) dbgLines[k] = a; }
  const opt = (v, t) => `<option value="${esc(v)}">${esc(t)}</option>`;
  $('dbgPose').innerHTML = POSES.map((p) => opt(p, p)).join('');
  $('dbgCat').innerHTML = Object.keys(dbgLines).map((k) => opt(k, `${k} (${dbgLines[k].length})`)).join('');
  const fillLines = () => { $('dbgLine').innerHTML = (dbgLines[$('dbgCat').value] || []).map((l, i) => opt(i, l)).join(''); };
  $('dbgCat').onchange = fillLines; fillLines();
  const debug = (cmd) => { if (api.debug) api.debug(cmd); else toast('当前环境不支持调试'); };
  const setDbg = (on) => {
    $('dbgOn').checked = on; $('dbg').classList.toggle('hidden', !on);
    try { localStorage.setItem('petDebug', on ? '1' : ''); } catch (_) {}
    if (!on) debug({ pose: null });
  };
  $('dbgOn').onchange = () => setDbg($('dbgOn').checked);
  try { setDbg(localStorage.getItem('petDebug') === '1'); } catch (_) {}
  $('dbgPoseGo').onclick = () => debug({ pose: $('dbgPose').value, lock: $('dbgLock').checked });
  $('dbgPose').onchange = () => { if ($('dbgLock').checked) $('dbgPoseGo').onclick(); };
  $('dbgPoseOff').onclick = () => { $('dbgLock').checked = false; debug({ pose: null }); };
  $('dbgSayGo').onclick = () => { const l = (dbgLines[$('dbgCat').value] || [])[$('dbgLine').value]; if (l) debug({ say: l }); };
  $('dbgTextGo').onclick = () => { const t = $('dbgText').value.trim(); if (t) debug({ say: t }); };
  $('dbgText').onkeydown = (e) => { if (e.key === 'Enter') $('dbgTextGo').onclick(); };
  const saveCc = () => { const v = Number($('dbgCcMax').value); if (api.setCcConfig && v > 0) api.setCcConfig({ max: v, app: $('dbgCcApp').value }); };
  $('dbgCcMax').onchange = saveCc; $('dbgCcApp').onchange = saveCc;
  $('dbgCcRefresh').onclick = () => { if (api.refreshCc) { api.refreshCc(); toast('正在刷新中转站余额…'); } };
  $('dbgDiff').innerHTML = Object.entries(Game.DIFFICULTY).map(([k, d]) => opt(k, d.name)).join('');
  $('dbgDiff').onchange = () => run('setDifficulty', $('dbgDiff').value);

  // ───────── 启动 ─────────
  api.onState((s) => { state = s; render(); });
  api.onPanelTab && api.onPanelTab(setTab);
  api.get().then((d) => {
    state = d.state; ITEMS = d.items || ITEMS; TYPES = d.typeNames || TYPES; NAMES = d.statNames || NAMES;
    setTab(new URLSearchParams(location.search).get('tab') || 'status');
    render();
  });
  setInterval(render, 60e3);
})();
