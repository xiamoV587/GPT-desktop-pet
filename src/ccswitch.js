// CC Switch 中转站余额：读取 ~/.cc-switch/cc-switch.db 里当前供应商的配置和「用量查询」脚本，
// 按脚本请求中转站接口，得到剩余费用。只读数据库，不改动 CC Switch 的任何配置。
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const CC_DIR = path.join(os.homedir(), '.cc-switch');
// CC Switch 默认的用量查询模板（供应商没配脚本时用）
const DEFAULT_SCRIPT = `({
  request: { url: "{{baseUrl}}/v1/usage", method: "GET", headers: { "Authorization": "Bearer {{apiKey}}" } },
  extractor: function (r) { return { isValid: r?.is_active ?? r?.isValid ?? true, remaining: r?.remaining ?? r?.quota?.remaining ?? r?.balance, unit: r?.unit ?? r?.quota?.unit ?? "USD" }; }
})`;

let SQL = null;
async function sql() {
  if (!SQL) SQL = await require('sql.js')({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
  return SQL;
}

// 取出某个应用（codex / claude）当前使用的供应商
async function currentProvider(app) {
  const dbFile = path.join(CC_DIR, 'cc-switch.db');
  if (!fs.existsSync(dbFile)) throw Object.assign(new Error('没有找到 CC Switch 数据'), { code: 'NO_CCSWITCH' });
  const S = await sql();
  const db = new S.Database(fs.readFileSync(dbFile));
  try {
    let id = null;
    try {
      const st = JSON.parse(fs.readFileSync(path.join(CC_DIR, 'settings.json'), 'utf8'));
      id = st['currentProvider' + app[0].toUpperCase() + app.slice(1)] || null;
    } catch (_) { /* 没有 settings.json 就用数据库里的 is_current */ }
    const q = id
      ? db.exec('select name, settings_config, meta, website_url from providers where app_type = ? and id = ?', [app, id])
      : db.exec('select name, settings_config, meta, website_url from providers where app_type = ? and is_current = 1', [app]);
    const row = q[0] && q[0].values[0];
    if (!row) throw new Error('CC Switch 里没有当前供应商');
    return { name: row[0], config: JSON.parse(row[1] || '{}'), meta: JSON.parse(row[2] || '{}'), website: row[3] || '' };
  } finally { db.close(); }
}

function credentials(app, cfg) {
  if (app === 'codex') {
    const m = /base_url\s*=\s*"([^"]+)"/.exec(cfg.config || '');
    return { baseUrl: m ? m[1] : '', apiKey: (cfg.auth && cfg.auth.OPENAI_API_KEY) || '' };
  }
  const env = cfg.env || {};
  return { baseUrl: env.ANTHROPIC_BASE_URL || '', apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '' };
}

async function query(app) {
  const p = await currentProvider(app);
  const { baseUrl, apiKey } = credentials(app, p.config);
  if (!baseUrl || !apiKey) throw new Error(`${p.name} 缺少地址或密钥`);
  const us = p.meta.usage_script && p.meta.usage_script.enabled ? p.meta.usage_script : null;
  const code = ((us && us.code) || DEFAULT_SCRIPT)
    .replace(/\{\{baseUrl\}\}/g, baseUrl.replace(/\/+$/, '')).replace(/\{\{apiKey\}\}/g, apiKey);
  const script = vm.runInNewContext('(' + code + ')', {}, { timeout: 1000 });
  const req = script.request || {};
  const res = await fetch(req.url, {
    method: req.method || 'GET', headers: req.headers || {}, body: req.body,
    signal: AbortSignal.timeout(((us && us.timeout) || 10) * 1000),
  });
  if (!res.ok) throw new Error(`${p.name} 查询失败 HTTP ${res.status}`);
  let out = script.extractor ? script.extractor(await res.json()) : null;
  if (Array.isArray(out)) out = out[0];
  const remaining = Number(out && out.remaining);
  if (!Number.isFinite(remaining)) throw new Error(`${p.name} 没有返回余额`);
  return { name: p.name, website: p.website, remaining, unit: (out && out.unit) || 'USD', valid: out.isValid !== false,
    interval: us && us.autoQueryInterval };
}

module.exports = { query };
