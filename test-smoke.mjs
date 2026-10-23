#!/usr/bin/env node
/**
 * dsh-local-search 冒烟：换机装完跑 `node test-smoke.mjs`，全绿即工具可用。
 * 只读 search.js，不依赖 dsh。单个 mode 失败不阻断其余（分别计分）。
 */
import { resolveConfig, runStatus, runFind, runGrep, runContent, runAst } from './lib/search.js'

const o = resolveConfig({})
let pass = 0
let fail = 0

async function step(name, fn) {
  try {
    const out = await fn()
    const first = String(out).split('\n').slice(0, 4).join('\n')
    console.log(`[ok] ${name}\n${first}\n`)
    pass++
  } catch (e) {
    console.log(`[FAIL] ${name}: ${e.message}\n`)
    fail++
  }
}

await step('status', () => runStatus(o))
await step('find (Everything 热)', () => runFind(o, { query: 'Everything', n: 5 }))
await step('grep (rg)', () => runGrep(o, { query: 'local_search', n: 5 }, process.cwd()))
await step('content (正文索引)', () => runContent(o, { query: 'local_search', n: 5 }))
await step('ast (结构)', () => runAst(o, { query: 'function $NAME($$$)', lang: 'js', n: 5 }, process.cwd()))

console.log(`冒烟结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
