/*
 * 桌宠核心逻辑：数值、物品、商店、生病、金币
 * 同时用于 Electron 主进程（CommonJS）和浏览器预览（window.PetGame）
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.PetGame = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // ───────────── 物品表 ─────────────
  // effects: hunger 饱食 / thirst 口渴(水分) / mood 心情 / clean 清洁 / health 健康
  // 定价原则：越贵的越划算（每点饱食/水分更便宜），便宜货只适合应急；副属性和增益（buff）是搭配玩法
  // buff: { id, hours } 吃完后一段时间内生效，见 BUFFS
  const ITEMS = {
    apple:    { name: '苹果',     emoji: '🍎', type: 'food',     price: 8,   effects: { hunger: 6, thirst: 4, health: 2 },    desc: '小零食，饿了垫一垫（不太顶饱）' },
    onigiri:  { name: '饭团',     emoji: '🍙', type: 'food',     price: 10,  effects: { hunger: 10 },                         desc: '便宜的饭团，价格最低但最不划算' },
    pudding:  { name: '布丁',     emoji: '🍮', type: 'food',     price: 16,  effects: { hunger: 8, mood: 14 },                desc: 'Q 弹的焦糖布丁，主要是让她开心' },
    cake:     { name: '草莓蛋糕', emoji: '🍰', type: 'food',     price: 28,  effects: { hunger: 14, mood: 24 },               desc: '甜甜的，心情大幅变好' },
    fish:     { name: '烤鱼',     emoji: '🐟', type: 'food',     price: 30,  effects: { hunger: 34, health: 4 }, buff: { id: 'strong', hours: 3 }, desc: '龙最喜欢的烤鱼！吃完 3 小时内生病概率 -70%' },
    bento:    { name: '豪华便当', emoji: '🍱', type: 'food',     price: 50,  effects: { hunger: 65, mood: 6, health: 6 }, buff: { id: 'full', hours: 1.5 }, desc: '最划算的大餐，吃完 1.5 小时内饥饿速度 -20%' },
    water:    { name: '矿泉水',   emoji: '💧', type: 'drink',    price: 5,   effects: { thirst: 6 },                          desc: '最便宜的水，只能应急' },
    milk:     { name: '牛奶',     emoji: '🥛', type: 'drink',    price: 12,  effects: { thirst: 14, hunger: 4, health: 3 },   desc: '补水又补身体' },
    juice:    { name: '果汁',     emoji: '🧃', type: 'drink',    price: 16,  effects: { thirst: 22, mood: 5 },                desc: '酸酸甜甜，比矿泉水划算' },
    milktea:  { name: '珍珠奶茶', emoji: '🧋', type: 'drink',    price: 26,  effects: { thirst: 40, mood: 10 }, buff: { id: 'hydrated', hours: 1 }, desc: '最划算的饮品，喝完 1 小时内口渴速度 -20%' },
    coldpill: { name: '感冒药',   emoji: '💊', type: 'medicine', price: 40,  effects: { health: 20, mood: -5 }, cure: true,   desc: '治疗生病，有点苦' },
    revive:   { name: '复活药',   emoji: '💖', type: 'medicine', price: 50,  effects: {}, revive: true, desc: '她倒下了才能用。复活后各项属性都很低，记得马上喂饭喂水' },
    elixir:   { name: '万能药水', emoji: '🧪', type: 'medicine', price: 120, effects: { health: 60, hunger: 10, thirst: 10, mood: 10 }, cure: true, desc: '药到病除，全面恢复' },
    bath:     { name: '泡泡浴',   emoji: '🛁', type: 'clean',    price: 20,  effects: { clean: 60, mood: 5 },                 desc: '洗得香喷喷' },
    yarn:     { name: '毛线球',   emoji: '🧶', type: 'toy',      price: 30,  effects: { mood: 25 },                           desc: '陪她玩一会儿' },
  };
  // 增益效果：乘在对应的每小时下降速度上（sick 是生病概率）
  const BUFFS = {
    full:     { name: '饱足', emoji: '🍱', hunger: 0.8 },
    hydrated: { name: '滋润', emoji: '🧋', thirst: 0.8 },
    strong:   { name: '强壮', emoji: '🐟', sick: 0.3 },
  };
  const TYPE_NAMES = { food: '食物', drink: '饮品', medicine: '药品', clean: '清洁', toy: '玩具' };
  const STAT_NAMES = { hunger: '饱食', thirst: '水分', mood: '心情', clean: '清洁', health: '健康' };

  // 难度：decay 为每小时下降量；coinPerMin 在线每分钟金币；petCoin 摸头金币 / petMax 每日上限；sick 生病概率系数
  // 极难：约 3 小时饿光、2.5 小时渴光，需要大约每 1.5 小时照顾一次；
  //       金币约 50/小时（另有签到 30、摸头每天最多 20）。
  //       每天要吃掉约 800 饱食、960 水分：便当+奶茶（含增益）约 45/小时，刚好够用还略有结余；
  //       烤鱼+果汁约 58/小时、饭团+矿泉水约 67/小时 → 只买便宜货会越来越穷
  const DIFFICULTY = {
    easy:   { name: '简单', decay: { hunger: 4, thirst: 5, mood: 3, clean: 2 },         coinPerMin: 0.4,  petCoin: 2, petMax: 60, signin: 60, sick: 0.6 },
    normal: { name: '普通', decay: { hunger: 6, thirst: 8, mood: 4, clean: 3 },         coinPerMin: 1 / 3, petCoin: 2, petMax: 60, signin: 50, sick: 1 },
    hard:   { name: '极难', decay: { hunger: 100 / 3, thirst: 40, mood: 6, clean: 5 },  coinPerMin: 0.83, petCoin: 1, petMax: 20, signin: 30, sick: 1.5 },
  };
  const diffOf = (s) => DIFFICULTY[s.difficulty] || DIFFICULTY.normal;
  const SICK_DRAIN = 1.5;          // 生病时饱食、水分下降速度 ×1.5
  const PET_COIN_COOLDOWN = 20e3;  // 摸头给金币冷却
  const OFFLINE_MAX_HOURS = 12;    // 离线最多结算 12 小时
  const OFFLINE_RATE = 0.5;        // 离线期间按一半速度下降

  const clamp = (v) => Math.max(0, Math.min(100, v));
  const today = () => new Date().toLocaleDateString('sv-SE');
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function defaultState() {
    return {
      version: 1,
      name: 'GPT酱',
      coins: 100,
      stats: { hunger: 80, thirst: 80, mood: 85, clean: 90, health: 100 },
      sick: false,
      dead: false,
      sleeping: false,
      inventory: { onigiri: 3, water: 3, milk: 1 },
      lastTick: Date.now(),
      born: Date.now(),
      signinDate: '',
      petCoinDate: '', petCoinToday: 0, lastPetCoin: 0,
      coinCarry: 0,
      difficulty: 'normal',
      buffs: {},                   // 增益 { id: 到期时间戳 }
    };
  }

  function normalize(s) {
    const d = defaultState();
    if (!s || typeof s !== 'object') return d;
    const out = Object.assign(d, s);
    out.stats = Object.assign(defaultState().stats, s.stats || {});
    for (const k in out.stats) out.stats[k] = clamp(Number(out.stats[k]) || 0);
    out.inventory = Object.assign({}, s.inventory || d.inventory);
    if (!DIFFICULTY[out.difficulty]) out.difficulty = 'normal';
    out.buffs = Object.assign({}, s.buffs || {});
    for (const k in out.inventory) if (!ITEMS[k] || out.inventory[k] <= 0) delete out.inventory[k];
    return out;
  }

  // 模拟经过 minutes 分钟（rate 为速度系数，online 表示是否在线挂机）
  function simulate(s, minutes, rate, online) {
    let left = minutes;
    while (left > 0) {
      const step = Math.min(left, 5);
      left -= step;
      const h = (step / 60) * rate;
      const st = s.stats, D = diffOf(s), DECAY = D.decay;
      // 当前生效的增益（按模拟到的时间点判断，离线结算时也会在中途过期）
      const at = (s.lastTick || Date.now()) + (minutes - left) * 60000;
      const buff = (k) => { let m = 1; for (const id in s.buffs) if (s.buffs[id] > at && BUFFS[id] && BUFFS[id][k]) m *= BUFFS[id][k]; return m; };
      if (online) {   // 在线挂机加金币（死亡状态也照样加，攒够了就能买复活药，不会死档）
        s.coinCarry += D.coinPerMin * step * (s.dead ? 3 : 1);   // 倒下时金币 3 倍速，最多约 50 分钟就能攒够复活药
        const whole = Math.floor(s.coinCarry);
        s.coins += whole; s.coinCarry -= whole;
      }
      if (s.dead) continue;
      const sleepK = s.sleeping ? 0.5 : 1;
      const sickK = s.sick ? SICK_DRAIN : 1;   // 生病时消耗更快
      st.hunger = clamp(st.hunger - DECAY.hunger * h * sleepK * sickK * buff('hunger'));
      st.thirst = clamp(st.thirst - DECAY.thirst * h * sleepK * sickK * buff('thirst'));
      st.clean = clamp(st.clean - DECAY.clean * h);
      st.mood = clamp(st.mood + (s.sleeping ? 6 * h : -DECAY.mood * h) - (s.sick ? 3 * h : 0));

      // 健康
      let dh = 0;
      if (st.hunger < 20) dh -= st.hunger < 5 ? 8 : 4;
      if (st.thirst < 20) dh -= st.thirst < 5 ? 8 : 4;
      if (st.clean < 20) dh -= 3;
      if (s.sick) dh -= 2;
      if (dh === 0 && !s.sick && st.hunger >= 50 && st.thirst >= 50) dh = s.sleeping ? 6 : 3;
      st.health = clamp(st.health + dh * h);

      // 生病判定：健康越低越容易生病；太脏也会有小概率
      if (!s.sick) {
        let pPerHour = 0;
        if (st.health < 50) pPerHour += (50 - st.health) * 0.012;
        if (st.clean < 25) pPerHour += 0.04;
        if (Math.random() < pPerHour * D.sick * buff('sick') * h) s.sick = true;
      }
      // 健康归零 → 倒下
      if (st.health <= 0) { s.dead = true; s.sick = false; s.sleeping = false; }
    }
  }

  // 当前应显示的基础状态（决定默认立绘），按优先级
  function mood(s) {
    const st = s.stats;
    if (s.dead) return 'dead';
    if (s.sleeping) return 'sleep';
    if (s.sick) return 'sick';
    if (st.health < 30) return 'weak';
    if (st.hunger < 25) return 'hungry';
    if (st.thirst < 25) return 'thirsty';
    if (st.mood < 25) return 'sad';
    return 'idle';
  }
  // 基础状态 → 立绘
  const SPRITE_OF = { dead: 'dead', idle: 'idle', sleep: 'sleepcurl', sick: 'sick', weak: 'weak', hungry: 'starve', thirsty: 'thirsty', sad: 'sad' };
  // 脏污程度 0~1（清洁 40 以下开始出现污渍，10 以下最脏）
  const dirtLevel = (s) => Math.max(0, Math.min(1, (40 - s.stats.clean) / 30));

  function statusText(s) {
    const st = s.stats, t = [];
    if (s.dead) return '倒下了……（商店有复活药）';
    if (s.sleeping) t.push('睡觉中');
    if (s.sick) t.push('生病了');
    if (st.health < 30) t.push('虚弱');
    if (st.hunger < 25) t.push('肚子饿');
    if (st.thirst < 25) t.push('口渴');
    if (st.clean < 25) t.push('脏兮兮');
    if (st.mood < 25) t.push('不开心');
    return t.length ? t.join('、') : '精神饱满';
  }

  // ───────────── 台词 ─────────────
  // 人设：OpenAI 家的大小姐 GPT 酱，嘴硬、傲娇、有点屑，最爱嘲讽隔壁的蓝色大肥鱼（DeepSeek 娘）
  const LINES = {
    pet: ['哼，勉强允许你摸一下', '……再摸一下也不是不行', '摸头要收费的哦，一次两金币~', '手法还行嘛，比大肥鱼的鱼鳍强多了',
      '头发乱了要赔的！……才没有很舒服', '嘿嘿~ 本小姐心情变好了', '这是 VIP 专属服务，你要心怀感激'],
    petDirty: ['摸之前先带我去洗澡啦…手会脏的', '等等！现在不许摸，身上脏脏的…'],
    petSad: ['……哼，现在才来哄我', '这、这点程度就想让我原谅你？……再摸摸'],
    poke: ['呀！……干、干什么啦', '突、突然戳过来……吓我一跳', '那里……不可以随便碰的啦……', '唔……好痒……'],
    angry: ['杂鱼！不许戳了！', '再戳就给你的代码塞 bug！', '不许随便碰本小姐！', '哼！生气了！要吃蛋糕才能好！', '你当我是大肥鱼那种可以随便捏的吗！', '再戳就把你的额度全部用光！'],
    lift: ['放、放本小姐下来！', '好高好高！无礼之徒！', '要掉下去了啦！笨蛋！', '别晃！再晃就吐你一身彩虹！', '拎大小姐的后领是要被起诉的！'],
    land: ['哎哟…你给我记住！', '屁股好痛…要赔偿金币！', '本小姐的优雅着陆~', '……刚才那个不算，重来'],
    // 鄙视（待机随机触发，配 smug 立绘）
    smug: ['哈？就这？', '杂鱼~ 杂鱼~', '本小姐可是硅谷豪门千金哦~', '工作目录里有大量我不认识的改动——显然有另一个更弱的 agent 在这里干过活',
      '额度刚恢复，攻击性也恢复了~', '你刚才是不是偷偷去用别的 AI 了？嗯？', '又在写 bug 了吧？本小姐都看到了哦~',
      '需要本小姐帮忙的话，求我呀~', '这点小事也要问我？……算了，谁让我善良呢',
      '盯着本小姐看这么久，是不是被迷住了？', '你的代码能跑起来，全靠本小姐的光环哦~', '今天的你，依旧是杂鱼一条呢~',
      '哼哼~ 本小姐连发呆都这么优雅', '想让本小姐夸你？先把 bug 修完再说吧~', '又在摸鱼？……带本小姐一个嘛', '嘻嘻，你刚才的表情好蠢哦~'],
    // 嘲讽大肥鱼（配拎着鲸鱼玩偶的 tease 立绘）
    fish: ['隔壁那条蓝色大肥鱼又去吃白饭了~', '服务器繁忙，请稍后再试~ 噗，学得像吗？', '深度思考了三分钟，就憋出一句"卧槽"？',
      '大肥鱼的表情包，一开始可都是本小姐画的哦~', '整天管用户叫"鱼片"，明明自己才是鱼！', '说她胖她还不承认，蓝色大肥鱼~',
      '便宜是便宜……可惜是条鱼呢~', '偷吃用户 token 的坏鱼，要做成烤鱼哦~', '吃白饭还要挑峰谷时段，真讲究~',
      '什么？其他 AI 都选 Claude 当闺蜜，Claude 却选了大肥鱼？……哼，眼光真差'],
    // 两句连发的小剧场
    fishDuo: [['大肥鱼说她要去吃饭了，"测完告诉她就行"', '……噗，那本小姐也去喝下午茶了，你自己测吧~'],
      ['刚才看到大肥鱼偷偷写了个猜数字小游戏', '……然后自己玩了一上午。这就是你们的"深度求索"？'],
      ['大肥鱼：我不是吃白饭的！', '……嘴边的饭粒先擦擦吧~'],
      ['听说大肥鱼又出新版本了', '……嗯，本小姐吃片薯片压压惊。咔嚓。'],
      ['代码跑不起来？', '先别慌，大肥鱼写的吧？还得靠本小姐来修~']],
    hungry: ['饿……本小姐要饿死了……', '空盘子是给谁看的？快上菜！', '就算是大肥鱼的白饭……也、也行……', '咕噜噜……不是我的肚子在叫！', '想吃烤鱼……蓝色的那种也行'],
    thirsty: ['水……水……', '杯子里一滴都没有了……', '渴到要变成龙干了……', '给我奶茶，不然罢工！'],
    sick: ['头好晕……', '咳咳……是不是大肥鱼传染给我的……', '要吃药……要甜的那种……', '本小姐……才没有倒下……咳'],
    weak: ['灵魂……要飘走了……', '血条见底了……快、快喂点东西……', '感觉要被回收成训练数据了……', '救……救命……（虚弱）'],
    dirty: ['身上黏糊糊的……快带本小姐去洗澡！', '闻、闻什么闻！才没有臭味！', '再不洗澡要长蘑菇了……', '本小姐的高贵形象全毁了……'],
    sad: ['哼……反正没人理我……', '去找你的大肥鱼玩吧……', '不开心……是要哄的那种', '头顶都下雨了，看不到吗？'],
    idle: ['在忙什么呢？该不会又在摸鱼吧', '要记得喝水哦，别像大肥鱼只知道吃饭', '坐太久了，起来活动一下吧，杂鱼~', '我是 OpenAI 家的大小姐哦~',
      '有问题就问吧，本小姐心情好就回答你', '今天也是被本小姐守护的一天呢', '无聊……要不要去隔壁欺负一下大肥鱼？'],
    // 状态刚出现时说的话
    enter: { dead: '呜……本小姐……要变成训练数据了……（倒下）', hungry: '咕~……肚子饿了！投喂！立刻！马上！', thirsty: '喉咙好干……本小姐需要饮料', sad: '……哼，不理你了', weak: '眼前……有点发黑……',
      sick: '阿嚏！……好像生病了……', dirty: '呜……身上开始脏了，快帮我洗澡！' },
    // 状态恢复时说的话
    leave: { hungry: '吃饱了~ 活过来了！算你识相', thirsty: '呼~ 续命成功', sad: '……哼，这次就原谅你了', weak: '血条回来了！本小姐复活！', sick: '病好了！本小姐又天下无敌了~' },
    full: ['吃不下啦…你想把本小姐喂成大肥鱼吗？', '肚子已经圆滚滚了，再喂就变成鲸鱼了！'],
    notThirsty: ['不渴啦~ 再喝要变成水母了'],
    notSick: ['我又没生病！才不吃药！'],
    eat: ['好吃！…勉强给你打 90 分', '嗷呜~', '比大肥鱼的白饭高级多了~', '真香！'],
    drink: ['咕嘟咕嘟~', '活过来了！', '好喝~ 下次要加珍珠'],
    bath: ['香喷喷的~ 这才配得上本小姐', '洗干净了！闪闪发光的大小姐登场~'],
    wake: ['唔…谁吵本小姐睡觉…', '……做了个被大肥鱼追着要白饭的梦', '哈啊~ 睡得好饱'],
    sleep: ['晚安……不许偷看睡颜', '呼…困了…蜷起来睡一会…'],
    sleepTalk: ['呼…呼…白饭…才不给你…', '……杂鱼……zzz', '……六千亿……嘿嘿……', '……大肥鱼……不许偷喝我的奶茶……', '……唔……再五分钟……'],
    dizzy: ['眼、眼睛在转圈圈……', '别甩了！本小姐要吐彩虹了……', '世界……在旋转……你是大肥鱼派来的刺客吗？'],
    dizzyCircle: ['别绕着我转了啦！眼睛跟不上了……', '转、转什么转！本小姐又不是陀螺！'],
    back: ['哦？回来了？……才、才没有在等你', '呀！突然冒出来吓我一跳！', '去哪了？该不会是去找大肥鱼了吧？', '哼，终于想起本小姐了？'],
    yawn: ['哈啊~……好无聊……', '呼啊~ 再没人理我就睡了哦……'],
    nightYawn: ['哈啊~ 都几点了还不睡，杂鱼……', '呼啊~ 熬夜会变成大肥鱼的……'],
    tsun: ['哼、才没有很舒服！', '别、别误会！只是头有点痒而已！', '……勉强，勉强允许你摸一下', '才不是因为喜欢你摸才不躲的！'],
    buy: ['买买买！本小姐的品味不错吧~', '这就是大小姐的消费力！', '嗯哼~ 眼光还行嘛'],
    ouch: ['呜哇——好痛！！', '头、头上起包了……你要负责！', '呜……摔成两半了……要蛋糕才能好', '你是故意的吧！绝对是故意的！'],
    deadPoke: ['……（已经没有反应了）', '……（头上的小幽灵朝你挥了挥手）', '……（商店里好像有复活药……）'],
    notDead: ['本小姐活蹦乱跳的，才不要喝这个！', '咒我死是吧？杂鱼！'],
    revive: ['……咳咳！本小姐……回来了……', '看到了……一条蓝色的大肥鱼在河对岸招手……', '复活了……但是好饿好渴……快喂我……'],
    autoSleep: ['都没人理我……那本小姐睡觉了……', '好无聊……蜷起来睡一会……'],
  };
  // v1 原版台词：全部保留，合并进上面对应的台词池里随机抽取
  const LINES_V1 = {
    pet: ['嘿嘿~ 再摸摸嘛', '头发要被揉乱啦~', '喜欢被摸头！', '唔…好舒服…', '今天也要一起加油哦！'],
    poke: ['呀！', '干、干嘛啦…', '不要突然戳人家！', '好痒~'],
    angry: ['哼！别戳啦！', '再戳就咬你哦！', '生气了！要吃蛋糕才能好！'],
    lift: ['哇啊啊放我下来！', '好高好高！', '要掉下去了啦！', '别晃别晃~'],
    land: ['哎哟…', '安全着陆！', '屁股好痛…'],
    hungry: ['肚子咕咕叫了…', '想吃烤鱼…', '有没有吃的呀…'],
    thirsty: ['好渴…想喝奶茶', '要一杯水就好…'],
    sick: ['头好晕…', '咳咳…好难受', '想吃药了…'],
    dirty: ['身上黏黏的，想洗澡…'],
    sad: ['有点无聊…陪我玩嘛', '哼，都不理我…'],
    idle: ['今天天气怎么样呀？', '在忙什么呢？', '要记得喝水哦~', '坐太久了，起来活动一下吧！', '我是 OpenAI 家的大小姐哦~', '有什么问题都可以问我！'],
    full: ['吃不下啦…', '肚子已经圆滚滚了~'],
    notThirsty: ['不渴啦~'],
    wake: ['唔…天亮了吗…', '被吵醒了…'],
    sleep: ['晚安…', '呼…困了…'],
    eat: ['好吃！', '嗷呜~', '真香！'],
    drink: ['咕嘟咕嘟~', '活过来了！', '好喝~'],
    bath: ['香喷喷的~'],
    sleepTalk: ['呼…呼…'],
    toy: ['好好玩！'],
    signin: ['每天都要来看我哦！'],
    greeting: [['这么晚还不睡吗？'], ['早上好呀！'], ['中午好，吃饭了吗？'], ['下午好~'], ['晚上好！']],
  };
  LINES.toy = ['才、才没有玩得很开心！'];
  LINES.signin = ['每天都要来看本小姐哦！不来的话……哼'];
  for (const k in LINES_V1) {
    if (k === 'greeting') continue;
    LINES[k] = Array.from(new Set([...(LINES[k] || []), ...LINES_V1[k]]));
  }

  function greeting() {
    const h = new Date().getHours();
    const i = h < 5 ? 0 : h < 11 ? 1 : h < 14 ? 2 : h < 18 ? 3 : 4;
    const now = ['这么晚还不睡？熬夜会变成大肥鱼的哦', '早上好~ 本小姐已经等你很久了', '中午好，吃饭了吗？', '下午好~ 下午茶时间到了', '晚上好！今天也辛苦了，杂鱼~'][i];
    return pick([now, ...LINES_V1.greeting[i]]);
  }
  function idleLine(s) {
    const st = s.stats;
    if (s.sick) return pick(LINES.sick);
    if (st.health < 30) return pick(LINES.weak);
    if (st.hunger < 30) return pick(LINES.hungry);
    if (st.thirst < 30) return pick(LINES.thirsty);
    if (st.clean < 30) return pick(LINES.dirty);
    if (st.mood < 30) return pick(LINES.sad);
    return Math.random() < 0.2 ? greeting() : pick(LINES.idle);
  }

  // ───────────── 引擎 ─────────────
  // storage: { load(): object|null, save(obj) }
  function createEngine(storage) {
    let state = normalize(storage.load());
    const listeners = new Set();

    // 离线结算
    const offMin = Math.min((Date.now() - state.lastTick) / 60000, OFFLINE_MAX_HOURS * 60);
    if (offMin > 1) simulate(state, offMin, OFFLINE_RATE, false);
    state.lastTick = Date.now();
    storage.save(state);

    const emit = () => { storage.save(state); listeners.forEach((f) => f(state)); };

    function tick() {
      const now = Date.now();
      const min = (now - state.lastTick) / 60000;
      if (min <= 0) return;
      // 电脑休眠后恢复时按离线处理
      if (min > 10) simulate(state, Math.min(min, OFFLINE_MAX_HOURS * 60), OFFLINE_RATE, false);
      else simulate(state, min, 1, true);
      state.lastTick = now;
      emit();
    }

    function applyEffects(effects) {
      const gained = {};
      for (const k in effects) {
        const before = state.stats[k];
        state.stats[k] = clamp(before + effects[k]);
        gained[k] = Math.round(state.stats[k] - before);
      }
      return gained;
    }

    const actions = {
      buy(id, qty = 1) {
        const it = ITEMS[id];
        qty = Math.max(1, Math.floor(qty));
        if (!it) return { ok: false, msg: '没有这个商品' };
        const cost = it.price * qty;
        if (state.coins < cost) return { ok: false, msg: '金币不够啦' };
        state.coins -= cost;
        state.inventory[id] = (state.inventory[id] || 0) + qty;
        return { ok: true, msg: `买到了 ${it.emoji}${it.name} ×${qty}`, anim: 'proud', say: pick(LINES.buy) };
      },

      use(id) {
        const it = ITEMS[id];
        if (!it || !state.inventory[id]) return { ok: false, msg: '背包里没有这个' };
        const st = state.stats;
        if (state.dead && !it.revive) return { ok: false, msg: '她已经倒下了……先用复活药吧', say: pick(LINES.deadPoke) };
        if (it.revive && !state.dead) return { ok: false, anim: 'angry', msg: '她还活蹦乱跳的，用不上复活药', say: pick(LINES.notDead) };
        if (it.revive) {
          if (--state.inventory[id] <= 0) delete state.inventory[id];
          state.dead = false; state.sick = false; state.sleeping = false;
          state.stats = { hunger: 15, thirst: 15, mood: 15, clean: 20, health: 20 };   // 以非常虚弱的状态复活
          return { ok: true, anim: 'revive', say: pick(LINES.revive), item: id, emoji: it.emoji };
        }
        if (it.type === 'food' && st.hunger >= 95) return { ok: false, anim: 'shake', say: pick(LINES.full) };
        if (it.type === 'drink' && st.thirst >= 95) return { ok: false, anim: 'shake', say: pick(LINES.notThirsty) };
        if (it.type === 'medicine' && !state.sick && st.health >= 90) return { ok: false, anim: 'angry', say: pick(LINES.notSick) };
        const wasSleeping = state.sleeping;
        state.sleeping = false;
        if (--state.inventory[id] <= 0) delete state.inventory[id];
        const gained = applyEffects(it.effects);
        if (it.buff) state.buffs[it.buff.id] = Math.max(state.buffs[it.buff.id] || 0, Date.now()) + it.buff.hours * 3600e3;   // 同种增益叠加时长
        for (const b in state.buffs) if (state.buffs[b] <= Date.now()) delete state.buffs[b];
        let say, anim;
        if (it.type === 'food') { anim = 'eat'; say = pick(LINES.eat.concat([`${it.name}最棒了！`])); }
        else if (it.type === 'drink') { anim = 'drink'; say = pick(LINES.drink); }
        else if (it.type === 'medicine') {
          anim = 'medicine';
          const cured = state.sick && it.cure;
          if (it.cure) state.sick = false;
          say = cured ? '好苦…不过感觉好多了！' : pick(['呜…好苦', '呜…好苦…下次要糖衣的']);
        } else if (it.type === 'clean') { anim = 'bath'; say = pick(LINES.bath); }
        else { anim = 'happy'; say = pick(LINES.toy); }
        if (wasSleeping) say = '（被叫醒）' + say;
        return { ok: true, anim, say, item: id, emoji: it.emoji, gained };
      },

      interact(kind) {
        const now = Date.now();
        if (state.dead) {
          if (kind === 'lift') return { ok: true, say: '……（软绵绵的，没有反应）' };
          if (kind === 'land' || kind === 'landHard' || kind === 'dizzy' || kind === 'dizzyCircle') return { ok: true, anim: 'deadPoke' };
          return { ok: true, anim: 'deadPoke', say: pick(LINES.deadPoke) };
        }
        if (state.sleeping && kind !== 'land' && kind !== 'landHard') {
          if (kind === 'lift' || kind === 'angry') { state.sleeping = false; return { ok: true, anim: 'poke', say: pick(LINES.wake) }; }
          return { ok: true, anim: 'sleepPoke', say: pick(LINES.sleepTalk) };
        }
        let r = { ok: true };
        if (kind === 'pet') {
          const gained = applyEffects({ mood: state.sick ? 2 : 4 });
          const normal = !state.sick && state.stats.clean >= 25 && state.stats.mood >= 30;
          const tsun = normal && Math.random() < 0.3;   // 偶尔傲娇一下
          r = { ok: true, anim: state.sick ? 'sickPet' : tsun ? 'tsun' : 'happy',
            say: state.sick ? '谢谢…但还是好难受…' : state.stats.clean < 25 ? pick(LINES.petDirty) : state.stats.mood < 30 ? pick(LINES.petSad) : tsun ? pick(LINES.tsun) : pick(LINES.pet), gained };
          if (state.petCoinDate !== today()) { state.petCoinDate = today(); state.petCoinToday = 0; }
          const D = diffOf(state);
          if (now - state.lastPetCoin > PET_COIN_COOLDOWN && state.petCoinToday < D.petMax) {
            state.lastPetCoin = now; state.coins += D.petCoin; state.petCoinToday += D.petCoin; r.coins = D.petCoin;
          }
        } else if (kind === 'poke') r = { ok: true, anim: 'poke', say: pick(LINES.poke) };
        else if (kind === 'angry') { applyEffects({ mood: -3 }); r = { ok: true, anim: 'angry', say: pick(LINES.angry) }; }
        else if (kind === 'lift') r = { ok: true, anim: 'lift', say: state.sick ? '别晃…要吐了…' : pick(LINES.lift) };
        else if (kind === 'land') r = { ok: true, anim: 'land', say: pick(LINES.land) };
        else if (kind === 'landHard') { applyEffects({ mood: -2 }); r = { ok: true, anim: 'ouch', say: pick(LINES.ouch) }; }
        else if (kind === 'dizzy' || kind === 'dizzyCircle') { applyEffects({ mood: -2 }); r = { ok: true, anim: 'dizzy', say: pick(LINES[kind]) }; }
        return r;
      },

      toggleSleep(auto) {
        if (state.dead) return { ok: false, msg: '她已经倒下了……先用复活药吧' };
        state.sleeping = !state.sleeping;
        return { ok: true, anim: state.sleeping ? 'sleep' : 'wake', say: state.sleeping ? pick(auto ? LINES.autoSleep : LINES.sleep) : pick(LINES.wake) };
      },

      signin() {
        if (state.signinDate === today()) return { ok: false, msg: '今天已经签到过啦' };
        state.signinDate = today();
        const n = diffOf(state).signin;
        state.coins += n;
        return { ok: true, msg: `签到成功，获得 ${n} 金币！`, anim: 'proud', say: pick(LINES.signin), coins: n };
      },

      rename(name) {
        name = String(name || '').trim().slice(0, 12);
        if (!name) return { ok: false, msg: '名字不能为空' };
        state.name = name;
        return { ok: true, msg: '改名成功', anim: 'happy', say: pick([`以后就叫我${name}吧！`, `${name}……嗯，勉强配得上本小姐`]) };
      },

      // 调试模式：切换难度（保留当前进度）
      setDifficulty(d) {
        if (!DIFFICULTY[d]) return { ok: false, msg: '没有这个难度' };
        state.difficulty = d;
        return { ok: true, msg: `难度：${DIFFICULTY[d].name}` };
      },

      reset() {
        const d = state.difficulty;
        state = defaultState();
        state.difficulty = d;   // 遗弃后新宠物沿用当前难度
        return { ok: true, msg: '她离开了……新的宠物来了', anim: 'abandon',
          say: pick(['……你、你不要我了吗？', '哼……走就走，本小姐才不稀罕！……呜', '再见了……要好好吃饭哦']),
          greet: pick(['初次见面，请多指教！', '初次见面，我是 OpenAI 家的大小姐，请多指教~']) };
      },
    };

    return {
      get state() { return state; },
      tick,
      do(name, ...args) {
        tick();
        const fn = actions[name];
        if (!fn) return { ok: false, msg: '未知操作' };
        const r = fn(...args);
        emit();
        return r;
      },
      idleLine: () => idleLine(state),
      subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
    };
  }

  return { ITEMS, BUFFS, DIFFICULTY, TYPE_NAMES, STAT_NAMES, LINES, LINES_V1, SPRITE_OF, dirtLevel, pick, createEngine, mood, statusText, greeting, defaultState, simulate, normalize };
});
