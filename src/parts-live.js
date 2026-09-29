/* Original-sprite puppet renderer. Four logical layers; wings are a body sublayer.
 * WebGL 1 indexed meshes, premultiplied alpha, whole-scene crossfades.
 * Existing PetLive API is retained. No Cubism dependency or claim of a Cubism model.
 */
(function (root) {
  'use strict';
  const W = 444, H = 420, PAD = 30;
  const CW = W + 2 * PAD, CH = H + 2 * PAD;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
  class Spring {
    constructor(k, c) { this.k = k; this.c = c; this.x = 0; this.v = 0; }
    step(target, dt, force = 0) {
      this.v += (this.k * (target - this.x) - this.c * this.v + force) * dt;
      this.x += this.v * dt;
      return this.x;
    }
    reset() { this.x = this.v = 0; }
  }
  const VS = `
    attribute vec2 aXY;
    varying vec2 vUV;
    uniform float uKind, uBreath, uHeadAngle, uHairL, uHairR, uTailAngle;
    uniform vec2 uHeadShift, uHeadPivot, uTailPivot;
    vec2 rotateAt(vec2 p, vec2 pivot, float a) {
      vec2 d = p-pivot; float c=cos(a), s=sin(a);
      return pivot+vec2(c*d.x-s*d.y,s*d.x+c*d.y);
    }
    void main() {
      vUV=aXY/vec2(444.,420.);
      vec2 p=aXY;
      if (uKind>2.5) p=rotateAt(p,uHeadPivot,uHeadAngle)+uHeadShift;
      else if (uKind>1.5) {
        float weight=smoothstep(12.,110.,length(p-uTailPivot));
        p=rotateAt(p,uTailPivot,uTailAngle*weight);
      } else if (uKind>0.5) {
        float follow=1.-smoothstep(175.,270.,p.y);
        p+=(rotateAt(aXY,uHeadPivot,uHeadAngle)+uHeadShift-aXY)*follow;
        float side=smoothstep(184.,260.,aXY.x);
        p.x+=mix(uHairL,uHairR,side)*smoothstep(215.,395.,aXY.y);
      }
      p.y=415.+(p.y-415.)*(1.+uBreath);
      gl_Position=vec4((p.x+30.)/504.*2.-1.,1.-(p.y+30.)/480.*2.,0.,1.);
    }`;
  const FS = `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uImage, uDirt;
    uniform float uDirtAmount;
    void main() {
      vec4 col=texture2D(uImage,vUV);
      vec4 dirt=texture2D(uDirt,vUV);
      float k=clamp(uDirtAmount,0.,1.)*dirt.a*.75;
      col.rgb=mix(col.rgb,vec3(.35,.30,.42)*col.a,k);
      gl_FragColor=col;
    }`;
  const CVS = `attribute vec2 aPos; varying vec2 vUV;
    void main(){vUV=aPos*.5+.5;gl_Position=vec4(aPos,0.,1.);}`;
  const CFS = `precision mediump float; varying vec2 vUV;
    uniform sampler2D uA,uB; uniform float uMix;
    void main(){gl_FragColor=mix(texture2D(uA,vUV),texture2D(uB,vUV),uMix);}`;

  function create(canvas, opts) {
    opts = opts || {};
    const base = opts.base || '../assets/';
    const meta = root.PET_PARTS;
    const api = { ok: false, ready: Promise.resolve(false), params: {}, errors: [] };
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true,
      antialias: true, preserveDrawingBuffer: true });
    if (!gl || !meta) return api;
    let disposed = false, lost = false;
    const resources = { textures: [], shaders: [], programs: [], buffers: [], framebuffers: [] };
    function shader(type, source) {
      const s = gl.createShader(type); resources.shaders.push(s);
      gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
      return s;
    }
    function program(vs, fs) {
      const p = gl.createProgram(); resources.programs.push(p);
      gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
      return p;
    }
    let meshProgram, mixProgram;
    try { meshProgram = program(VS, FS); mixProgram = program(CVS, CFS); }
    catch (e) { console.error('分层渲染器初始化失败', e); api.errors.push(String(e)); return api; }
    const U = {}, C = {};
    ['uKind','uBreath','uHeadAngle','uHairL','uHairR','uTailAngle','uHeadShift',
      'uHeadPivot','uTailPivot','uImage','uDirt','uDirtAmount'].forEach(n => U[n] = gl.getUniformLocation(meshProgram,n));
    ['uA','uB','uMix'].forEach(n => C[n] = gl.getUniformLocation(mixProgram,n));
    const meshAttr = gl.getAttribLocation(meshProgram,'aXY'), quadAttr = gl.getAttribLocation(mixProgram,'aPos');
    function buffer(target, data) {
      const b=gl.createBuffer(); resources.buffers.push(b); gl.bindBuffer(target,b); gl.bufferData(target,data,gl.STATIC_DRAW); return b;
    }
    const vertices=[], indices=[], cols=40, rows=40;
    for (let y=0;y<=rows;y++) for (let x=0;x<=cols;x++) vertices.push(x/cols*W,y/rows*H);
    for (let y=0;y<rows;y++) for (let x=0;x<cols;x++) {
      const a=y*(cols+1)+x,b=a+1,c=a+cols+1,d=c+1;
      indices.push(a,b,c,b,d,c);
    }
    const meshBuffer=buffer(gl.ARRAY_BUFFER,new Float32Array(vertices));
    const indexBuffer=buffer(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices));
    const quadBuffer=buffer(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]));
    const imageCache=new Map(), assets={}, heads={}, closed={}, sprites={};
    let dirtTexture=null, emptyTexture=null;
    function texture(image) {
      const t=gl.createTexture(); resources.textures.push(t); gl.bindTexture(gl.TEXTURE_2D,t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      return t;
    }
    function load(path) {
      if (!imageCache.has(path)) imageCache.set(path,new Promise((resolve,reject)=>{
        const i=new Image(); i.onload=()=> disposed ? reject(Error('disposed')) : resolve(texture(i));
        i.onerror=()=>reject(Error('加载失败: '+path)); i.src=base+path;
      }));
      return imageCache.get(path);
    }
    const frames=[];
    function makeFrame() {
      const f=gl.createFramebuffer(),t=gl.createTexture();
      resources.framebuffers.push(f); resources.textures.push(t);
      gl.bindTexture(gl.TEXTURE_2D,t);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      return {f,t};
    }
    frames.push(makeFrame(),makeFrame());
    let scale=1,dpr=1;
    api.resize=(k)=>{
      if (disposed) return;
      scale=clamp(finite(Number(k),.55),.1,3); dpr=Math.min(2,root.devicePixelRatio||1);
      canvas.style.left=canvas.style.top=(-PAD*scale)+'px';
      canvas.style.width=CW*scale+'px'; canvas.style.height=CH*scale+'px';
      canvas.width=Math.round(CW*scale*dpr); canvas.height=Math.round(CH*scale*dpr);
      for (const f of frames) {
        gl.bindTexture(gl.TEXTURE_2D,f.t);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,canvas.width,canvas.height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
        gl.bindFramebuffer(gl.FRAMEBUFFER,f.f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,f.t,0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) {
          api.errors.push('Framebuffer incomplete'); api.ok=false;
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    };
    api.resize(.55);
    api.ready=Promise.all([
      ...Object.entries(meta.parts).map(([key,file])=>load('parts/'+file).then(t=>assets[key]=t)),
      ...Object.entries(meta.expressions).map(([key,file])=>load('parts/'+file).then(t=>heads[key]=t)),
      ...Object.entries(meta.closedExpressions||{}).map(([key,file])=>load('parts/'+file).then(t=>closed[key]=t)),
    ].concat(
      [...new Set(['idle',...(opts.sprites||[])])].map(n=>load('sprites/'+n+'.png').then(t=>sprites[n]=t)),
      load('rig/dirt.png').then(t=>dirtTexture=t).catch(()=>{})
    )).then(()=>{
      if (disposed) return false;
      const blank=document.createElement('canvas');blank.width=blank.height=1;emptyTexture=texture(blank);
      api.ok=!api.errors.length; return api.ok;
    }).catch(e=>{api.errors.push(String(e));console.error(e);return false;});

    const S={head:new Spring(65,15),lookY:new Spring(60,14),hairL:new Spring(19,7),hairR:new Spring(17,6.8),tail:new Spring(22,7.5)};
    const P=api.params;
    let time=0, lastVx=0, dirt=0, current={sprite:'idle',expression:null}, previous=null, fade=1;
    let blinkTime=0, nextBlink=3.4, lastMode='idle';
    const debug={rest:false,paused:false,head:true,backHair:true,body:true,tail:true,amplitude:1};
    api.setDebug=(values)=>Object.assign(debug,values||{});
    api.setDirt=(v)=>{dirt=clamp(finite(v),0,1);};
    function transition(next,smooth) {
      if (next.sprite===current.sprite && next.expression===current.expression) return;
      previous=smooth?{...current}:null; current=next; fade=smooth?0:1;
    }
    api.setSprite=(name,smooth=true)=>{
      if (!sprites[name] && api.ok) name='idle';
      transition({sprite:name,expression:null},smooth);
    };
    api.setExpression=(name,smooth=true)=>{
      if (!(name in meta.expressions)) return false;
      transition({sprite:'idle',expression:name},smooth);return true;
    };
    api.update=(dt,input={})=>{
      if (disposed||lost||debug.paused) return;
      dt=clamp(finite(dt,1/60),0,.05);
      const vx=finite(input.vx),ax=clamp((vx-lastVx)/Math.max(dt,.001),-2200,2200);lastVx=vx;
      lastMode=input.mode||'idle';
      const rest=debug.rest, look=input.look||{};
      const asleep=['sleep','dead','lifted','falling'].includes(lastMode);
      const lx=rest||asleep?0:clamp(finite(look.x),-1,1),ly=rest||asleep?0:clamp(finite(look.y),-1,1);
      const count=Math.max(1,Math.ceil(dt*120)),h=dt/count;
      for(let i=0;i<count;i++) {
        time+=h;
        S.head.step(lx,h);S.lookY.step(ly,h);
        const wind=Math.sin(time*1.25)*1.6+Math.sin(time*2.15+.7)*.45;
        S.hairL.step(wind-S.head.v*.22,h,-ax*.012);
        S.hairR.step(wind*.75+Math.sin(time*1.6)*.45-S.head.v*.22,h,-ax*.011);
        const happy=lastMode==='happy'||current.expression==='happy';
        const angry=lastMode==='angry'||current.expression==='angry';
        const wag=(happy?.085:angry?.055:.052)*Math.sin(time*(happy?4.3:angry?3.1:1.65));
        S.tail.step(wag,h,-ax*.00013);
      }
      const amp=rest?0:clamp(finite(Number(debug.amplitude),1),0,1);
      P.headAngle=clamp(S.head.x*.035,-.035,.035)*amp;
      P.headX=clamp(S.head.x*1.6,-1.6,1.6)*amp;
      P.headY=clamp(S.lookY.x*1.3,-1.3,1.3)*amp;
      P.hairL=clamp(S.hairL.x,-3.4,3.4)*amp; P.hairR=clamp(S.hairR.x,-3.4,3.4)*amp;
      P.tail=clamp(S.tail.x,-.10,.10)*amp;
      P.breath=lastMode==='dead'?0:.006*Math.sin(time*2*Math.PI/(lastMode==='sleep'?4.2:3.2))*amp;
      blinkTime=Math.max(0,blinkTime-dt);
      if(time>nextBlink){blinkTime=.12;nextBlink=time+3.1+Math.random()*2.3;}
      P.blink=!rest&&blinkTime>0; P.time=time;
      fade=Math.min(1,fade+dt/.16); if(fade===1) previous=null;
    };
    function bind(unit,t){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t||emptyTexture);}
    function draw(t,kind){
      bind(0,t);gl.uniform1f(U.uKind,kind);gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);
    }
    function scene(model,frame){
      gl.bindFramebuffer(gl.FRAMEBUFFER,frame.f);gl.viewport(0,0,canvas.width,canvas.height);
      gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(meshProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER,meshBuffer);gl.enableVertexAttribArray(meshAttr);gl.vertexAttribPointer(meshAttr,2,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);
      gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(U.uImage,0);gl.uniform1i(U.uDirt,1);bind(1,dirtTexture);
      gl.uniform1f(U.uDirtAmount,dirt);
      const expression=model.expression||meta.spriteMap[model.sprite];
      const layered=!!heads[expression];
      gl.uniform1f(U.uBreath,P.breath||0);
      gl.uniform1f(U.uHeadAngle,layered?(P.headAngle||0):0);
      gl.uniform2f(U.uHeadShift,layered?(P.headX||0):0,layered?(P.headY||0):0);
      gl.uniform2fv(U.uHeadPivot,meta.headPivot);gl.uniform2fv(U.uTailPivot,meta.tailPivot);
      gl.uniform1f(U.uHairL,P.hairL||0);gl.uniform1f(U.uHairR,P.hairR||0);gl.uniform1f(U.uTailAngle,P.tail||0);
      if(layered){
        if(debug.backHair)draw(assets.backHair,1);
        if(debug.body)draw(assets.wings,0);
        if(debug.tail)draw(assets.tail,2);
        if(debug.body)draw(assets.body,0);
        if(debug.head)draw(P.blink&&closed[expression]?closed[expression]:heads[expression],3);
      }else draw(sprites[model.sprite]||sprites.idle,0);
    }
    api.render=()=>{
      if(!api.ok||disposed||lost)return;
      if(previous)scene(previous,frames[0]);
      scene(current,frames[1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,canvas.width,canvas.height);gl.disable(gl.BLEND);
      gl.useProgram(mixProgram);gl.bindBuffer(gl.ARRAY_BUFFER,quadBuffer);
      gl.enableVertexAttribArray(quadAttr);gl.vertexAttribPointer(quadAttr,2,gl.FLOAT,false,0,0);
      bind(0,previous?frames[0].t:frames[1].t);bind(1,frames[1].t);
      gl.uniform1i(C.uA,0);gl.uniform1i(C.uB,1);gl.uniform1f(C.uMix,previous?fade:1);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    };
    const pixel=new Uint8Array(4);
    api.hitTest=(x,y)=>{
      if(!api.ok||disposed||lost||!Number.isFinite(x)||!Number.isFinite(y))return false;
      const px=Math.floor((x+PAD)/CW*canvas.width),py=canvas.height-1-Math.floor((y+PAD)/CH*canvas.height);
      if(px<0||py<0||px>=canvas.width||py>=canvas.height)return false;
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(px,py,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      return pixel[3]>24;
    };
    api.getState=()=>({renderer:'layered-webgl1',sprite:current.sprite,expression:current.expression||meta.spriteMap[current.sprite]||null,
      layered:!!(current.expression||meta.spriteMap[current.sprite]),fade,mode:lastMode,debug:{...debug},params:{...P},errors:[...api.errors]});
    const onLost=e=>{e.preventDefault();lost=true;api.ok=false;api.errors.push('WebGL context lost');canvas.dispatchEvent(new CustomEvent('pet-renderer-lost'));};
    canvas.addEventListener('webglcontextlost',onLost);
    api.destroy=()=>{
      if(disposed)return;disposed=true;api.ok=false;canvas.removeEventListener('webglcontextlost',onLost);
      resources.textures.forEach(t=>gl.deleteTexture(t));resources.buffers.forEach(b=>gl.deleteBuffer(b));
      resources.framebuffers.forEach(f=>gl.deleteFramebuffer(f));resources.programs.forEach(p=>gl.deleteProgram(p));resources.shaders.forEach(s=>gl.deleteShader(s));
    };
    api._S=S;api.gl2=false;
    return api;
  }
  root.PetLive={create,PAD};
})(window);
