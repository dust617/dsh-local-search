/**
 * dsh-local-search —— 执行层（无 dsh 依赖，可被 node 直接单测）。
 *
 * 约定（用户终版）：
 *  - Everything 1.5a 由桌面壳常驻看护（隐藏后台，随壳同生命周期），工具侧只查不等、
 *    绝不自动拉起。未就绪时快速失败并提示重启壳。
 *  - 所有外部命令走 argv（无 shell 层），不存在引号/注入问题。
 *  - es.exe 无控制台输出可能是 GBK，需要 utf8 → gbk 回退解码。
 */
import { spawn, spawnSync } from 'node:child_process'
import { TextDecoder } from 'node:util'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'

const GBK = new TextDecoder('gbk')
const UTF8 = new TextDecoder('utf-8', { fatal: true })

function tryDecode(buf) {
  try {
    return UTF8.decode(buf)
  } catch {
    try {
      return GBK.decode(buf)
    } catch {
      return Buffer.from(buf).toString('utf-8').replace(/\uFFFD/g, '')
    }
  }
}

/**
 * 跨机可移植的二进制发现（优先级从高到低）：
 *  1. preset 显式 config（受管机器可 pin 死）；
 *  2. 环境变量（EVERYTHING_ES / EVERYTHING_EXE / RG_EXE / RGA_EXE / AST_GREP_EXE / DOWSE_EXE）；
 *  3. PATH（where.exe 同名查找，换机最稳）；
 *  4. 本机常见落点（本机 E:\ 绿色版、Program Files、%USERPROFILE%\.local\bin）。
 * 找不到时返回 null，由调用方报"装什么 + 怎么装"，绝不静默用错二进制。
 */
function whereExe(name) {
  try {
    const r = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    if (r.status !== 0 || !r.stdout) return null
    const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    return first && existsSync(first) ? first : null
  } catch {
    return null
  }
}

function pickBinary(explicit, envNames, pathName, candidates) {
  if (explicit && existsSync(explicit)) return explicit
  for (const e of envNames) {
    const v = (process.env[e] || '').trim()
    if (v && existsSync(v)) return v
  }
  const viaPath = whereExe(pathName)
  if (viaPath) return viaPath
  for (const c of candidates) {
    const expanded = c.replace(/%([^%]+)%/g, (_, n) => process.env[n] ?? '')
    if (expanded && existsSync(expanded)) return expanded
  }
  return null
}

const INSTALL_HINTS = {
  es: '装 Everything（自带 es.exe）或单下 ES CLI：https://www.voidtools.com/downloads/；绿色版解压后设环境变量 EVERYTHING_ES 指向 es.exe',
  ev15: '装 Everything 1.5 beta（需要 content: 正文索引）：https://www.voidtools.com/downloads/；或设 EVERYTHING_EXE',
  rg: 'winget install BurntSushi.ripgrep 或下载便携包：https://github.com/BurntSushi/ripgrep/releases；或设 RG_EXE',
  rga: 'cargo install ripgrep-all 或下载：https://github.com/phiresky/ripgrep-all/releases；或设 RGA_EXE',
  ast: '下载 ast-grep：https://github.com/ast-grep/ast-grep/releases；或设 AST_GREP_EXE',
  dowse: 'cargo install --git https://github.com/ltspace/dowse dowse（只要 CLI，不过 overlay、不设热键、无常驻）；或设 DOWSE_EXE',
}

export function resolveConfig(config = {}) {
  const home = process.env.USERPROFILE ?? ''
  return {
    es: pickBinary(config.es, ['EVERYTHING_ES', 'ES_EXE'], 'es.exe', [
      'E:\\Everything-1.4.1.1032.x64\\es.exe',
      'E:\\Everything-1.5b\\es.exe',
      '%ProgramFiles%\\Everything\\es.exe',
      `${home}\\.local\\bin\\es.exe`,
    ]),
    ev15: pickBinary(config.ev15, ['EVERYTHING_EXE'], 'Everything.exe', [
      'E:\\Everything-1.5b\\Everything.exe',
      'E:\\Everything-1.4.1.1032.x64\\Everything.exe',
      '%ProgramFiles%\\Everything\\Everything.exe',
    ]),
    instance: config.instance ?? process.env.EVERYTHING_INSTANCE ?? '1.5a',
    rg: pickBinary(config.rg, ['RG_EXE'], 'rg.exe', [
      `${home}\\.local\\bin\\rg.exe`,
      '%ProgramFiles%\\ripgrep\\rg.exe',
    ]),
    rga: pickBinary(config.rga, ['RGA_EXE'], 'rga.exe', [
      `${home}\\.local\\bin\\rga.exe`,
    ]),
    ast: pickBinary(config.ast, ['AST_GREP_EXE'], 'ast-grep.exe', [
      `${home}\\.local\\bin\\ast-grep.exe`,
    ]),
    dowse: pickBinary(config.dowse, ['DOWSE_EXE'], 'dowse.exe', [
      `${home}\\.local\\dowse\\bin\\dowse.exe`,
      `${home}\\.cargo\\bin\\dowse.exe`,
    ]),
    popplerBin:
      config.popplerBin ?? process.env.POPPLER_BIN ?? '',
    readyTimeoutMs: config.readyTimeoutMs ?? 8000,
    runTimeoutMs: config.runTimeoutMs ?? 30000,
    maxChars: config.maxChars ?? 12000,
    _explicit: config,
  }
}

function needBin(o, key, label) {
  if (o[key]) return o[key]
  const hint = INSTALL_HINTS[key] ?? ''
  throw new Error(`${label} 找不到。${hint}`)
}

function execBin(cmd, args, { timeoutMs = 30000, env } = {}) {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      windowsVerbatimArguments: false,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    const err = []
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        if (child.pid) child.kill('SIGKILL')
      } catch { /* 忽略 */ }
      resolveP({ ok: false, code: null, stdout: '', stderr: `timeout ${timeoutMs}ms: ${cmd} ${args.join(' ')}`.slice(0, 300) })
    }, timeoutMs)
    if (timer.unref) timer.unref()
    child.stdout?.on('data', (c) => out.push(c))
    child.stderr?.on('data', (c) => err.push(c))
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveP({ ok: false, code: null, stdout: '', stderr: `spawn 失败 ${cmd}: ${e.message}` })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveP({
        ok: code === 0,
        code,
        stdout: tryDecode(Buffer.concat(out)),
        stderr: tryDecode(Buffer.concat(err)),
      })
    })
  })
}

/** Everything IPC 是否就绪（只查不等，默认 8s 超时）。rg 的 exit 1 表示"无匹配"属正常。 */
export async function checkEverything(o) {
  const t0 = Date.now()
  if (!o.es) return { ok: false, ms: 0, error: `es.exe 找不到。${INSTALL_HINTS.es}` }
  const r = await execBin(o.es, ['-instance', o.instance, '-n', '1', 'a'], { timeoutMs: o.readyTimeoutMs })
  const ms = Date.now() - t0
  if (r.ok) return { ok: true, ms, error: '' }
  if (/error/i.test(r.stderr || '')) {
    return { ok: false, ms, error: `Everything ${o.instance} 未就绪：${(r.stderr || '').trim().slice(0, 200)}（壳会看护自动拉起；持续失败请重启桌面壳）` }
  }
  return { ok: false, ms, error: `es.exe 异常退出（code=${r.code}）：${(r.stderr || '').trim().slice(0, 200)}` }
}

function splitWords(query) {
  return String(query ?? '').split(/\s+/).map((s) => s.trim()).filter(Boolean)
}

function clampN(n, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(200, Math.max(1, Math.floor(v)))
}

function cap(text, maxChars, hint) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…（输出超长已截断，${hint}）`
}

function relativize(text, workdir) {
  if (!workdir) return text
  const prefix = workdir.endsWith('\\') || workdir.endsWith('/') ? workdir : `${workdir}\\`
  return text
    .split('\n')
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .join('\n')
}

/** find：全盘文件名，多词 AND，可 --path 前缀过滤。 */
export async function runFind(o, { query, path, n }) {
  const words = splitWords(query)
  if (words.length === 0) throw new Error('find 需要 query（空格分隔多词=AND）')
  const ready = await checkEverything(o)
  if (!ready.ok) throw new Error(ready.error)
  const limit = clampN(n, 20)
  const args = ['-instance', o.instance, '-n', String(limit)]
  if (path && String(path).trim()) args.push('-p', String(path).trim())
  args.push(...words)
  const r = await execBin(o.es, args, { timeoutMs: o.runTimeoutMs })
  if (!r.ok) throw new Error(`es.exe 失败（code=${r.code}）：${(r.stderr || '').trim().slice(0, 300)}`)
  const out = r.stdout.trim()
  return cap(out === '' ? '(无结果)' : out, o.maxChars, `加更具体的词或 --path 缩小范围（${ready.ms}ms）`)
}

/** 去 ANSI 颜色码 + \\?\ 前缀：dowse 输出含高亮色，直接给模型是噪音。 */
function cleanDowse(text) {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.replace(/^\\\\\?\\/, ''))
    .join('\n')
}

/** dowse 已注册根目录（60s 缓存；无 dowse/无索引返回 null）。 */
let dowseRootsCache = { at: 0, roots: null }
export async function getDowseRoots(o) {
  if (!o.dowse) return null
  if (Date.now() - dowseRootsCache.at < 60_000) return dowseRootsCache.roots
  const r = await execBin(o.dowse, ['status'], { timeoutMs: 10000 })
  let roots = null
  if (r.ok) {
    const lines = r.stdout.split('\n')
    const idx = lines.findIndex((l) => l.includes('已注册根目录'))
    if (idx >= 0) {
      roots = lines.slice(idx + 1).map((l) => l.trim()).filter((l) => /^[A-Za-z]:[\\/]/.test(l))
    }
  }
  dowseRootsCache = { at: Date.now(), roots }
  return roots
}

/**
 * dowse 正文搜索（持久索引 + 中文分词 + 评分排序）。
 * 只在"有索引覆盖"时用：无 path 查询默认用（根即范围）；有 path 则 path 须落在某注册根下。
 * 没覆盖/没装/失败 → 返回 null，由 runContent 回落 Everything。
 */
export async function runDowse(o, { query, path, ext, n }) {
  if (!o.dowse) return null
  const words = splitWords(query)
  if (words.length === 0) return null
  const roots = await getDowseRoots(o)
  if (!roots || roots.length === 0) return null
  if (path && String(path).trim()) {
    const p = String(path).trim().toLowerCase()
    const covered = roots.some((r) => p.startsWith(r.toLowerCase()))
    if (!covered) return null
  }
  const args = ['search', ...words, '-n', String(clampN(n, 10))]
  if (ext && String(ext).trim()) args.push('--ext', String(ext).trim().replace(/\./g, ''))
  // 有 path 且为字面路径（非 glob）时，用 path: 操作符限定在该子树内
  if (path && String(path).trim() && !/[*?]/.test(String(path).trim())) {
    args.push(`path:${String(path).trim()}`)
  }
  const r = await execBin(o.dowse, args, { timeoutMs: o.runTimeoutMs })
  if (!r.ok) return null
  const out = cleanDowse((r.stdout || '').trim())
  if (!out) return null
  // dowse 无匹配时 exit 0 + "没搜到…"：这是索引内的确定结论，不回落（回落只会引入跨盘噪音）
  if (/^没搜到/.test(out)) {
    return { text: `${out}\n（dowse 索引内无匹配；换关键词，或改用 mode=deep 深扫）`, via: 'dowse' }
  }
  return { text: cap(out, o.maxChars, '加词或 ext 缩小范围'), via: 'dowse' }
}

/** content：优先 dowse 持久索引（分词+排序），无覆盖时回落 Everything 1.5 正文索引。 */
export async function runContent(o, { query, path, ext, n }) {
  const words = splitWords(query)
  if (words.length === 0) throw new Error('content 需要 query（空格分隔多词=AND）')
  try {
    const hit = await runDowse(o, { query, path, ext, n })
    if (hit) return hit.text
  } catch { /* 回落 */ }
  const ready = await checkEverything(o)
  if (!ready.ok) throw new Error(ready.error)
  const limit = clampN(n, 10)
  const exts = String(ext ?? '').split(',').map((s) => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)
  const terms = words.map((w) => `content:${w}`)
  if (exts.length > 0) terms.unshift(`*.${exts.join('|*.')}`)
  const args = ['-instance', o.instance, '-n', String(limit), '-s', ...terms]
  const r = await execBin(o.es, args, { timeoutMs: o.runTimeoutMs })
  const out = (r.stdout || '').trim()
  if (out !== '') return cap(out, o.maxChars, '加词或 ext 缩小范围')
  const deepExt = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', '7z']
  if (exts.some((e) => deepExt.includes(e))) {
    return `(无结果；文本索引不含 ${exts.filter((e) => deepExt.includes(e)).join('/')}，改用 mode=deep 深扫)`
  }
  return '(无结果；PDF/Office/压缩包正文不在文本索引内，可改用 mode=deep 深扫)'
}

function resolveTarget(workdir, p) {
  if (!p || !String(p).trim()) return workdir
  const s = String(p).trim()
  return isAbsolute(s) ? s : resolve(workdir, s)
}

/** grep：rg 内容搜索（默认尊重 .gitignore；--path 可带 glob）。 */
export async function runGrep(o, { query, path, n, ignoreCase, include }, workdir) {
  const pattern = String(query ?? '')
  if (!pattern.trim()) throw new Error('grep 需要 query（rg 正则）')
  needBin(o, 'rg', 'rg.exe')
  const limit = clampN(n, 30)
  const target = resolveTarget(workdir, path)
  const args = ['-n', '-m', String(limit), '--heading', '-S', pattern]
  if (ignoreCase) args.push('-i')
  if (include && String(include).trim()) args.push('-g', String(include).trim())
  // 路径含通配符时拆成 base + glob（与 q 保持一致）
  if (target && /[*?]/.test(target)) {
    const idx = target.search(/[*?]/)
    const sep = Math.max(target.lastIndexOf('\\', idx), target.lastIndexOf('/', idx))
    const base = sep > 0 ? target.slice(0, sep) : '.'
    const glob = sep > 0 ? target.slice(sep + 1) : target
    args.push('-g', glob, base)
  } else {
    args.push(target)
  }
  const r = await execBin(o.rg, args, { timeoutMs: o.runTimeoutMs })
  if (r.code === 1) return '(无匹配)'
  if (!r.ok) throw new Error(`rg 失败（code=${r.code}）：${(r.stderr || '').trim().slice(0, 300)}`)
  const out = r.stdout.trim()
  if (!out) return '(无匹配)'
  return cap(relativize(out, workdir), o.maxChars, '加 -g 或缩小 path')
}

/** deep：rga 无索引深扫（PDF/Office/压缩包），多词 AND。 */
export async function runDeep(o, { query, path, n, ext }, workdir) {
  const words = splitWords(query)
  if (words.length === 0) throw new Error('deep 需要 query（空格分隔多词=AND）')
  needBin(o, 'rga', 'rga.exe')
  const target = resolveTarget(workdir, path)
  if (!existsSync(target)) throw new Error(`目录不存在：${target}`)
  const limit = clampN(n, 10)
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pat = words.map((w) => `(?=.*${esc(w)})`).join('') + '.*'
  const args = ['-P', '-m', String(limit), '-S', pat]
  const exts = String(ext ?? '').split(',').map((s) => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)
  for (const e of exts) args.push('-g', `*.${e}`)
  args.push(target)
  const env = o.popplerBin && existsSync(o.popplerBin)
    ? { ...process.env, PATH: `${o.popplerBin}${delimiter}${process.env.PATH ?? ''}` }
    : process.env
  const r = await execBin(o.rga, args, { timeoutMs: Math.max(o.runTimeoutMs, 60000), env })
  if (r.code === 1) return '(无匹配)'
  if (!r.ok) throw new Error(`rga 失败（code=${r.code}）：${(r.stderr || '').trim().slice(0, 300)}`)
  const out = r.stdout.trim()
  if (!out) return '(无匹配)'
  return cap(relativize(out, workdir), o.maxChars, '加 ext 或缩小目录')
}

/** ast：ast-grep 结构搜索（代码模式，非纯文本）。 */
export async function runAst(o, { query, path, lang, n }, workdir) {
  const pattern = String(query ?? '')
  if (!pattern.trim()) throw new Error('ast 需要 query（ast-grep pattern，如 function $NAME($$$)）')
  needBin(o, 'ast', 'ast-grep.exe')
  const target = resolveTarget(workdir, path)
  const args = ['run', '-p', pattern]
  if (lang && String(lang).trim()) args.push('-l', String(lang).trim())
  args.push(target)
  const r = await execBin(o.ast, args, { timeoutMs: o.runTimeoutMs })
  // ast-grep 无匹配时 exit 0 + 空输出；有匹配 exit 0
  if (!r.ok) throw new Error(`ast-grep 失败（code=${r.code}）：${((r.stderr || '') + (r.stdout || '')).trim().slice(0, 300)}`)
  const out = (r.stdout || '').trim()
  if (!out) return '(无匹配)'
  const lines = out.split('\n')
  const limit = clampN(n, 50)
  const shown = lines.slice(0, limit * 3).join('\n')
  const tail = lines.length > limit * 3 ? `\n…（还有 ${lines.length - limit * 3} 行，缩小 path 或加 -l）` : ''
  return cap(relativize(shown, workdir) + tail, o.maxChars, '缩小 path 或指定 lang')
}

/** status：各后端版本 + Everything 热延迟 + dowse 索引概况（不拉起）。 */
export async function runStatus(o) {
  const parts = []
  for (const [label, bin, vargs] of [
    ['rg', o.rg, ['--version']],
    ['ast-grep', o.ast, ['--version']],
    ['dowse', o.dowse, ['--version']],
  ]) {
    if (!bin || !existsSync(bin)) {
      const hintKey = label === 'es' ? 'es' : label === 'ast-grep' ? 'ast' : label
      parts.push(`${label}: 缺失（${INSTALL_HINTS[hintKey] ?? '见 README 前置依赖'}）`)
      continue
    }
    const r = await execBin(bin, vargs, { timeoutMs: 10000 })
    const first = ((r.stdout || r.stderr || '').split('\n')[0] || '').trim().slice(0, 120)
    parts.push(`${label}: ${r.ok && first ? first : `异常 code=${r.code}`}`)
  }
  const ready = await checkEverything(o)
  parts.push(`es: ${o.es ?? '缺失'}`)
  parts.push(ready.ok ? `everything ${o.instance}: 热就绪（${ready.ms}ms）` : `everything ${o.instance}: 未就绪 —— ${ready.error}`)
  const roots = await getDowseRoots(o)
  parts.push(roots ? `dowse 索引根（${roots.length}）：${roots.join('；')}` : 'dowse 索引：无（装完后跑 `dowse index <目录>` 建索引，content 自动回落 Everything）')
  return parts.join('\n')
}
