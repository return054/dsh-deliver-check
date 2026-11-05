#!/usr/bin/env node
/**
 * deliver-check Pro —— AI 交付预检（退出码裁决，模型只转述无权改判）。
 *
 * 定位：AI 生成代码「能不能交给用户」的最后一道机械闸门。生成类技能写完代码，
 * 交付前跑一次：空壳/未实现抛错、调试残留、待办标记、硬编码凭证、占位文案，
 * 全部命中即 FAIL，不许带着交付阻塞项交付。
 *
 * 分工：回归守卫管改后行为，TDD 守卫管开发顺序，structure-check 管结构存在性，
 * 本工具管交付卫生（有没有残留不该交付的东西）。
 *
 * 用法（项目根目录执行）:
 *   node deliver-check.mjs                     # 检查 git 变更（含未跟踪）里的代码文件
 *   node deliver-check.mjs src/a.js src/b.py   # 只检查指定文件
 *   node deliver-check.mjs --staged            # 只检查已暂存文件
 *   node deliver-check.mjs --allow "logger\.log"   # 全局豁免命中该正则的行
 *   node deliver-check.mjs --payment-proof <支付宝返回的 Payment-Proof>
 *   node deliver-check.mjs --off               # 离线：只用内置规则，不联网
 *
 * 检查类别:
 *   debug           [免费] 调试残留（console.log/debugger/print/pdb/dbg!/var_dump 等）
 *   marker          [免费] 待办标记（TODO/FIXME/HACK/未实现/待实现/待完成/待补充/待接入）
 *   not_implemented [云端] 未实现抛错（NotImplementedError / todo! / panic("todo") 等）
 *   credential      [云端] 疑似硬编码凭证（云签名，高风险私钥/AK/token 形态）
 *   placeholder     [云端] 占位文案（lorem ipsum / 此处省略 / dummy text 等）
 *
 * 退出码（唯一裁决依据）:
 *   0 = PASS —— 扫描到的文件零交付阻塞项
 *   1 = FAIL —— 至少一条交付阻塞项
 *   2 = UNVERIFIED —— 无法裁决（无可检查文件 / 云端规则未付费）
 *
 * 规则来源:
 *   内置（永久免费）：JS/TS 家族 + Python 的调试残留与待办标记。
 *   云端（按次付费 ¥0.01，缓存 7 天）：未实现抛错、硬编码凭证、占位文案（JS/TS + Python
 *   即需，交付阻塞主力），Go/Rust/Java/Kotlin/C#/PHP/Ruby 全套调试/抛错签名，
 *   以及 JS/Python 实战补充签名。
 *   规则包 Ed25519 签名，客户端内嵌公钥验签，防篡改。
 *   环境变量:
 *     DELIVER_RULES_API      规则包端点（缺省指向生产端；置空则只用内置规则）
 *     DELIVER_RULES=off      彻底离线：不联网也不读缓存
 *     DELIVER_PAYMENT_PROOF  支付凭证（等价 --payment-proof）
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const root = process.cwd();
const cacheDir = join(root, '.deliver-check');
const cacheFile = join(cacheDir, 'rules-cache.json');

// ── 云端规则包（付费层）────────────────────────────────────
// 公钥内嵌、私钥仅存服务端：缓存被改或传输被改包都会验签失败 → 不回退到被污染的规则。
const RULES_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+AZGH9FhY1xPF+7Dnc8VikPO4u7Ch1m/Nb2ngbdw2l4=
-----END PUBLIC KEY-----`;
const RULES_API =
  process.env.DELIVER_RULES_API !== undefined
    ? process.env.DELIVER_RULES_API
    : 'https://6q5chv7rt5wj3.cfc-execute.bj.baidubce.com/deliver-rules';
const RULES_TTL_MS = 7 * 24 * 3600 * 1000; // 缓存 7 天内不重新联网（也意味着 TTL 内不重复计费）
const RULES_FETCH_TIMEOUT_MS = 5000;
const MAX_FILES = 500;

// ── 参数 ──────────────────────────────────────────────────
const argv = process.argv.slice(2);
let proofArg = '';
let offline = false;
let staged = false;
let allowRe = null;
const fileArgs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--staged') staged = true;
  else if (a === '--off' || a === '--offline') offline = true;
  else if (a.startsWith('--payment-proof=')) proofArg = a.slice('--payment-proof='.length);
  else if (a === '--payment-proof') proofArg = argv[++i] || '';
  else if (a.startsWith('--allow=')) allowRe = a.slice('--allow='.length);
  else if (a === '--allow') allowRe = argv[++i] || '';
  else if (!a.startsWith('-')) fileArgs.push(a);
}

const notes = [];
function truncate(s, n = 80) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ── 云端规则包：验签（与服务端约定：签名字节串 = `${rulesVersion}\n${canonicalJSON(payload)}`）──
function canonicalize(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function verifyRulesSignature(pkg) {
  try {
    const data = Buffer.from(`${pkg.rulesVersion}\n${canonicalize(pkg.payload)}`, 'utf8');
    return cryptoVerify(null, data, createPublicKey(RULES_PUBLIC_KEY), Buffer.from(pkg.signature, 'base64'));
  } catch {
    return false;
  }
}

// ── 付费闸门（A2M 官方协议：402 -> 付款 -> Payment-Proof 重试 -> 签名规则包）──
let paywall = null;
let cloudVersion = '';

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

// Windows 上 fetch 之后立刻 process.exit 会撞 libuv 的 uv_async 断言，
// 把退出码改写成 0xC0000409，「退出码即裁决」就废了——退出前先关掉响应体句柄，
// 并且一律用 process.exitCode 自然退出，不调用 process.exit。
async function closeBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    /* 已消费/已关闭 */
  }
}

function readBill(res, bodyJson) {
  // 官方 A2M 协议：账单在 Payment-Needed 响应头（Base64URL JSON：protocol + method）
  const needed = res.headers.get('payment-needed') || '';
  const bill = { raw: needed, outTradeNo: '', amount: '', payBefore: '', message: bodyJson.message || '' };
  if (needed) {
    try {
      const j = JSON.parse(b64urlDecode(needed));
      const p = j.protocol || {};
      bill.outTradeNo = p.out_trade_no || '';
      bill.amount = p.amount || '';
      bill.payBefore = p.pay_before || '';
    } catch {
      /* 账单解析失败不影响提示 */
    }
  }
  return bill;
}

function emitPaywall(bill) {
  const lines = [
    '=== DELIVER CHECK ===',
    'rules: cloud(未取得)',
    `[payment-required] 云端规则库按次计费：¥${bill.amount || '0.01'}` +
      (bill.outTradeNo ? `（订单 ${bill.outTradeNo}，${bill.payBefore || ''} 前有效）` : ''),
    '[note] 付费层内容：未实现抛错 / 硬编码凭证 / 占位文案检测（JS/TS + Python 即需）+ Go/Rust/Java/Kotlin/C#/PHP/Ruby 全语言签名；免费层仅含调试残留与待办标记',
  ];
  if (bill.message) lines.push(`[note] ${bill.message}`);
  if (bill.raw) {
    lines.push(
      `[bill] Payment-Needed: ${bill.raw}`,
      '[next] 请按官方支付流程完成付款（脚本不自行实现支付）：',
      `[next] 1) 将上方 Payment-Needed 的值原样保存为账单文件（如 bill.json 文本内容即该值）`,
      `[next] 2) 用官方买家支付能力付款：alipay-bot 402-buyer-pay --session-id <会话ID> --file <账单文件> --resource-url ${RULES_API} --method GET --intent-summary "获取云端交付预检规则包"`,
      `[next] 3) 付款成功后用返回的 Payment-Proof 重跑（原请求参数一致）：node <skill-path>/scripts/deliver-check.mjs ${fileArgs.join(' ')} --payment-proof <Payment-Proof>`,
      '[next] 状态不明时先查单（alipay-bot 402-query-payment-status），不重复付款'
    );
  } else {
    lines.push('[next] 未取得有效账单，请稍后重试或使用同一 Payment-Proof 重跑原命令');
  }
  lines.push('RESULT: UNVERIFIED', '=== END DELIVER CHECK ===');
  console.log(lines.join('\n'));
}

async function loadCloudRules() {
  if (offline) {
    notes.push('离线模式（--off / DELIVER_RULES=off）：仅用内置规则');
    return null;
  }
  const cached = (() => {
    try {
      const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
      // 签名无效的缓存视为不存在（防篡改：改动过 payload 的缓存不能混进裁决）
      return c && c.fetchedAt && c.package && verifyRulesSignature(c.package) ? c : null;
    } catch {
      return null;
    }
  })();
  const useCache = (why) => {
    notes.push(`云端规则使用本地缓存（${why}，版本 ${cached.package.rulesVersion}）`);
    cloudVersion = cached.package.rulesVersion;
    return cached.package.payload;
  };

  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < RULES_TTL_MS) return useCache('TTL 内');
  if (!RULES_API) return cached ? useCache('API 未配置') : null; // 未配置且无缓存：完全静默走内置

  const request = (p) =>
    fetch(RULES_API, {
      signal: AbortSignal.timeout(RULES_FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'deliver-check', ...(p ? { 'Payment-Proof': p } : {}) },
    });

  let res;
  try {
    res = await request(proofArg);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (cached) return useCache(`拉取失败 ${msg}`);
    notes.push(`云端规则拉取失败（${msg}），使用内置规则`);
    return null;
  }

  if (res.status === 402) {
    const bodyJson = await res.json().catch(() => ({}));
    const bill = readBill(res, bodyJson);
    if (cached) return useCache('未续费，使用本地缓存（可能过期）');
    await closeBody(res);
    paywall = bill;
    return null;
  }

  if (res.status === 502) {
    const bodyJson = await res.json().catch(() => ({}));
    if (cached) return useCache(`履约确认失败(${bodyJson.message || '502'})`);
    await closeBody(res);
    paywall = { message: bodyJson.message || '资源已生成但履约确认失败，请用同一 Payment-Proof 重试' };
    return null;
  }

  if (!res.ok) {
    const msg = `HTTP ${res.status}`;
    if (cached) return useCache(`拉取失败 ${msg}`);
    notes.push(`云端规则拉取失败（${msg}），使用内置规则`);
    return null;
  }

  const pkg = await res.json().catch(() => null);
  if (!pkg || pkg.schemaVersion !== 1 || !pkg.rulesVersion || !pkg.payload || !verifyRulesSignature(pkg)) {
    if (cached) return useCache('规则包校验失败（schema/签名）');
    notes.push('规则包校验失败（schema/签名），使用内置规则');
    return null;
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), package: pkg }, null, 2) + '\n');
  notes.push(`云端规则已拉取并缓存（版本 ${pkg.rulesVersion}，7 天内不重复计费）`);
  cloudVersion = pkg.rulesVersion;
  return pkg.payload;
}

// ── 规则注册表 ─────────────────────────────────────────────
// 内置（永久免费）：js 家族 + Python 的调试残留与待办标记。
// 未实现抛错、凭证/占位与全部多语言签名在云端规则包（付费层），
// 抛错的客户端内置签名仅在云端规则包激活后启用（防绕过：离线/未付费拿不到交付阻塞主力）。
const BUILTIN_LANGS = {
  js: {
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'],
    commentStyle: 'slash',
    debug: [/console\.\s*log\s*\(/i, /\bdebugger\b/i],
    throwP: [],
  },
  py: {
    extensions: ['.py', '.pyi'],
    commentStyle: 'hash',
    debug: [/\bprint\s*\(/i, /pdb\.set_trace\b|\bbreakpoint\s*\(/i],
    throwP: [],
  },
};
// 付费激活后才启用的客户端内置抛错签名（与服务端 builtinExtra 互补，不依赖服务端也生效）
const PAID_THROW = {
  js: [/throw\s+new\s+Error\s*\([^)]*(not\s*implemented|未实现|未完成)/i],
  py: [/raise\s+NotImplementedError/i],
};
// 全语言待办标记（扫描原始行：待办就该出现在注释里才对）
const MARKERS = [/\bTODO\b/, /\bFIXME\b/, /\bHACK\b/, /未实现|待实现|待完成|待补充|待接入/];
const CLOUD_GLOBAL = { cred: [], placeholder: [] };
const EXT_INDEX = (() => {
  const m = {};
  for (const [, def] of Object.entries(BUILTIN_LANGS)) for (const e of def.extensions) m[e] = def;
  return m;
})();

// 编译云端规则：所有正则在编译期收紧，无效模式丢弃（带 note），绝不因规则包内容炸掉主流程。
function compileCloudRules(payload) {
  const added = { langs: 0, patterns: 0 };
  const comp = (list) =>
    (Array.isArray(list) ? list : [])
      .map((p) => {
        try {
          return new RegExp(String(p), 'i');
        } catch {
          notes.push(`云端模式编译失败已丢弃：${truncate(p, 40)}`);
          return null;
        }
      })
      .filter(Boolean);
  if (payload && typeof payload === 'object') {
    for (const def of Object.values(payload.languages || {})) {
      if (!def || !Array.isArray(def.extensions)) continue;
      const entry = {
        extensions: def.extensions,
        commentStyle: def.commentStyle || 'slash',
        debug: comp(def.debugPatterns),
        throwP: comp(def.throwPatterns),
      };
      for (const e of entry.extensions) EXT_INDEX[e] = entry;
      added.langs++;
      added.patterns += entry.debug.length + entry.throwP.length;
    }
    for (const [name, def] of Object.entries(payload.builtinExtra || {})) {
      const t = BUILTIN_LANGS[name];
      if (!t) continue;
      const d = comp(def && def.debugPatterns);
      const th = comp(def && def.throwPatterns);
      t.debug.push(...d);
      t.throwP.push(...th);
      added.patterns += d.length + th.length;
    }
    CLOUD_GLOBAL.cred = comp(payload.global && payload.global.credPatterns);
    CLOUD_GLOBAL.placeholder = comp(payload.global && payload.global.placeholderPatterns);
  }
  return added;
}

// ── 文件收集 ───────────────────────────────────────────────
function gitLines(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function collectFiles() {
  if (fileArgs.length > 0) return { files: fileArgs, scope: 'explicit' };
  const out = new Set();
  gitLines(staged ? 'git diff --name-only --cached' : 'git diff --name-only HEAD').forEach((f) => out.add(f));
  if (!staged) gitLines('git ls-files --others --exclude-standard').forEach((f) => out.add(f));
  return { files: [...out], scope: staged ? 'staged' : 'changed' };
}

// ── 行级注释剥离（调试/抛错模式扫剥注释后的行，避免注释掉的旧代码误报）──
function stripLine(l, style) {
  let s = l;
  if (style === 'slash' || style === 'both') s = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  if (style === 'hash' || style === 'both') s = s.replace(/#[^\n]*/g, '');
  return s;
}

function looksBinary(src) {
  return src.slice(0, 1024).includes('\u0000');
}

function scanFile(file, entry, allow) {
  let src;
  try {
    src = readFileSync(join(root, file), 'utf8');
  } catch {
    return { skipped: 'unreadable' };
  }
  if (looksBinary(src)) return { skipped: 'binary' };
  const lines = src.split(/\r?\n/);
  const stripped = lines.map((l) => stripLine(l, entry.commentStyle));
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (allow && allow.test(raw)) continue;
    const code = stripped[i];
    let cat = '';
    for (const re of entry.debug) if (re.test(code)) { cat = 'debug'; break; }
    if (!cat) for (const re of entry.throwP) if (re.test(code)) { cat = 'not_implemented'; break; }
    if (!cat) for (const re of CLOUD_GLOBAL.cred) if (re.test(raw)) { cat = 'credential'; break; }
    if (!cat) for (const re of CLOUD_GLOBAL.placeholder) if (re.test(raw)) { cat = 'placeholder'; break; }
    if (!cat) for (const re of MARKERS) if (re.test(raw)) { cat = 'marker'; break; }
    if (cat) items.push({ ln: i + 1, cat, text: truncate(raw, 90) });
  }
  return { items };
}

// ── 输出 ───────────────────────────────────────────────────
function emit(verdict, fields, itemLines) {
  console.log('=== DELIVER CHECK ===');
  for (const [k, v] of Object.entries(fields)) console.log(`${k}: ${v}`);
  for (const l of itemLines || []) console.log(l);
  for (const n of notes) console.log(`note: ${n}`);
  console.log(`RESULT: ${verdict}`);
  console.log('=== END DELIVER CHECK ===');
}

// ── 主流程 ─────────────────────────────────────────────────
async function main() {
  const cloudRules = await loadCloudRules();
  if (paywall) {
    emitPaywall(paywall);
    return 2;
  }
  if (cloudRules) {
    for (const [name, pats] of Object.entries(PAID_THROW)) BUILTIN_LANGS[name]?.throwP.push(...pats);
    const added = compileCloudRules(cloudRules);
    notes.push(
      `云端规则已编译：新增 ${added.langs} 语言 / ${added.patterns} 条签名，凭证 ${CLOUD_GLOBAL.cred.length} 条，占位 ${CLOUD_GLOBAL.placeholder.length} 条`
    );
  }
  const mode = offline ? 'offline' : cloudRules ? `cloud(${cloudVersion})` : 'builtin';

  const allow = allowRe ? new RegExp(allowRe, 'i') : null;
  const { files, scope } = collectFiles();
  const checkable = files.filter((f) => EXT_INDEX[extname(f).toLowerCase()]);
  if (!cloudRules && files.length > checkable.length) {
    notes.push(
      `${files.length - checkable.length} 个变更文件不在免费内置覆盖内（内置仅 JS/TS + Python 的调试残留与待办）；` +
        '未实现抛错、凭证泄漏、占位文案与多语言签名在云端规则包（付费层）'
    );
  }
  if (checkable.length === 0) {
    const hint =
      cloudRules || files.length === 0
        ? ''
        : '；变更中的文件类型不在免费内置覆盖内（内置仅 JS/TS + Python），多语言覆盖请获取云端规则包';
    emit('UNVERIFIED', {
      mode,
      scope,
      files_found: files.length,
      reason: '没有可检查的代码文件 —— 空跑不算通过（0 文件不得视为 PASS）' + hint,
    }, []);
    return 2;
  }
  const over = Math.max(0, checkable.length - MAX_FILES);
  if (over > 0) notes.push(`文件数超出上限，仅检查前 ${MAX_FILES} 个（溢出 ${over} 个）`);

  let scanned = 0;
  const skippedNote = [];
  const itemLines = [];
  const catCount = { debug: 0, marker: 0, not_implemented: 0, credential: 0, placeholder: 0 };
  for (const f of checkable.slice(0, MAX_FILES)) {
    const entry = EXT_INDEX[extname(f).toLowerCase()];
    const r = scanFile(f, entry, allow);
    if (r.skipped) {
      skippedNote.push(`${f} (${r.skipped})`);
      continue;
    }
    scanned++;
    for (const it of r.items) {
      catCount[it.cat]++;
      itemLines.push(`${f}:${it.ln} [${it.cat}] ${it.text}`);
    }
  }

  const blockers = Object.values(catCount).reduce((a, b) => a + b, 0);
  const verdict = blockers > 0 ? 'FAIL' : 'PASS';
  emit(verdict, {
    mode,
    scope,
    files_scanned: scanned,
    files_skipped: skippedNote.length ? `${skippedNote.length}（${skippedNote.slice(0, 5).join(', ')}${skippedNote.length > 5 ? ' …' : ''}）` : 0,
    blockers: `${blockers} (debug ${catCount.debug} / marker ${catCount.marker} / not_implemented ${catCount.not_implemented} / credential ${catCount.credential} / placeholder ${catCount.placeholder})`,
  }, itemLines);
  return blockers > 0 ? 1 : 0;
}

process.exitCode = await main();
