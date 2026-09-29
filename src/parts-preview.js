(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const names={idle:'待机',blink:'眨眼',happy:'开心',angry:'生气',shy:'害羞',smug:'得意',hungry:'委屈',starve:'饥饿',thirsty:'口渴',weak:'虚弱',dizzy:'转晕'};
  const poses={lifted:'拎起',eat:'吃饭',drink:'喝水',sleepcurl:'睡觉',sad:'抱尾巴',tease:'鲸鱼玩偶'};
  const live=window.PetLive.create($('puppet'),{base:'assets/',sprites:Object.keys(poses)});
  window.layerPreview=live;
  live.resize(1);
  let paused=false,rest=false,original=false,mode='idle',last=0,look={x:0,y:0};
  function active(button){document.querySelectorAll('#expressions button,#poses button').forEach(b=>b.classList.toggle('active',b===button));}
  for(const [key,label] of Object.entries(names)){
    const b=document.createElement('button');b.className='btn'+(key==='idle'?' active':'');b.textContent=label;b.dataset.expression=key;
    b.onclick=()=>{live.setExpression(key);mode=key;active(b);$('sceneName').textContent=label+' / '+key;$('original').src='assets/sprites/'+key+'.png';};
    $('expressions').append(b);
  }
  for(const [key,label] of Object.entries(poses)){
    const b=document.createElement('button');b.className='btn';b.textContent=label;b.dataset.pose=key;
    b.onclick=()=>{live.setSprite(key);mode=key==='sleepcurl'?'sleep':key;active(b);$('sceneName').textContent=label+' / 原姿态';$('original').src='assets/sprites/'+key+'.png';};
    $('poses').append(b);
  }
  $('pause').onclick=()=>{paused=!paused;live.setDebug({paused});$('pause').textContent=paused?'继续动画':'暂停动画';};
  $('rest').onclick=()=>{rest=!rest;live.setDebug({rest,paused:false});paused=false;$('pause').textContent='暂停动画';$('rest').classList.toggle('active',rest);};
  $('originalBtn').onclick=()=>{original=!original;$('original').style.display=original?'block':'none';$('puppet').style.visibility=original?'hidden':'visible';$('originalBtn').classList.toggle('active',original);};
  $('bg').onclick=()=>{$('scene').classList.toggle('dark');$('bg').textContent=$('scene').classList.contains('dark')?'浅色背景':'深色背景';};
  document.querySelectorAll('[data-layer]').forEach(box=>box.onchange=()=>live.setDebug({[box.dataset.layer]:box.checked}));
  $('amplitude').oninput=e=>live.setDebug({amplitude:Number(e.target.value)/100});
  $('reset').onclick=()=>{
    rest=paused=original=false;mode='idle';look={x:0,y:0};
    live.setDebug({rest:false,paused:false,amplitude:1,head:true,body:true,backHair:true,tail:true});
    document.querySelectorAll('[data-layer]').forEach(b=>b.checked=true);$('amplitude').value=100;
    $('pause').textContent='暂停动画';$('rest').classList.remove('active');$('originalBtn').classList.remove('active');
    $('original').style.display='none';$('puppet').style.visibility='visible';
    document.querySelector('[data-expression="idle"]').click();
  };
  $('scene').addEventListener('pointermove',e=>{const r=$('puppet').getBoundingClientRect();look={x:Math.max(-1,Math.min(1,(e.clientX-r.left-r.width/2)/180)),y:Math.max(-1,Math.min(1,(e.clientY-r.top-r.height*.35)/160))};});
  $('scene').addEventListener('pointerleave',()=>{look={x:0,y:0};});
  live.ready.then(ok=>{
    if(!ok){$('error').style.display='block';$('error').textContent='分层预览未能启动。请使用启用 WebGL 的浏览器。\n'+live.errors.join('\n');$('status').textContent='加载失败';return;}
    $('status').textContent='11 表情 / 4 主层';live.setExpression('idle',false);
    function tick(t){const dt=last?(t-last)/1000:1/60;last=t;live.update(dt,{look,mode,vx:0});live.render();requestAnimationFrame(tick);}
    requestAnimationFrame(tick);
  });
})();
