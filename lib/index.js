/**
 * dsh-local-search —— 本地搜索工具（单工具 local_search，多 mode）。
 *
 * 形态：常驻 1 个工具 schema（≈0.4k tokens/步），与 glob/grep 并存：
 *   - find    全盘文件名（Everything 1.5a 热索引，毫秒级）
 *   - content 正文索引（Everything 1.5 实时内容索引，文本/代码）
 *   - grep    工作区内容（host rg，尊重 .gitignore）
 *   - deep    无索引深扫（rga，PDF/Office/压缩包）
 *   - ast     结构搜索（ast-grep，代码模式）
 *   - status  三件套版本 + Everything 热延迟
 *
 * 生命周期：Everything 由桌面壳常驻看护（隐藏后台，随壳同生死），
 * 本工具只查不等、绝不自动拉起；未就绪快速失败并提示重启壳。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  resolveConfig,
  runFind,
  runContent,
  runGrep,
  runDeep,
  runAst,
  runStatus,
} from './search.js'

export const name = 'dsh-local-search'
export const inject = ['tools']

const MODES = ['find', 'content', 'grep', 'deep', 'ast', 'status']

function apply(ctx, config) {
  const options = resolveConfig(config ?? {})

  ctx.tools.register(defineTool({
    name: 'local_search',
    description:
      '本地搜索（Everything 常驻热索引 + dowse 持久索引 + rg/rga/ast-grep）。mode=find 全盘文件名（多词AND，可path前缀）；content 正文（优先 dowse 索引：分词+排序，无覆盖自动回落 Everything）；grep 工作区内容（rg正则）；deep 深扫PDF/Office/压缩包；ast 代码结构模式；status 查各后端与热延迟。比 glob/grep 更快更全，优先用它。',
    parameters: {
      mode: { type: 'string', required: true, description: '搜索模式：find | content | grep | deep | ast | status' },
      query: { type: 'string', description: '关键词（find/content/deep 空格分隔=AND）或模式（grep 为 rg 正则，ast 为代码模式）；status 可空' },
      path: { type: 'string', description: '可选：find 为 Everything 路径前缀；grep/ast/deep 为工作区目标（相对/绝对，支持 glob）' },
      ext: { type: 'string', description: '可选：content/deep 的扩展名过滤，逗号分隔（如 md,pdf）' },
      lang: { type: 'string', description: '可选：ast 的语言（如 ts、py、js）' },
      n: { type: 'integer', description: '可选：最多结果数（默认 find 20/grep 30/content 10/deep 10/ast 50，上限 200）' },
      ignoreCase: { type: 'boolean', description: '可选：grep 忽略大小写' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args, exec) {
      const mode = String(args.mode ?? '').trim().toLowerCase()
      if (!MODES.includes(mode)) {
        throw new Error(`mode 非法：${args.mode}（可选 ${MODES.join(' | ')}）`)
      }
      const workdir = exec?.agent?.session?.header?.cwd ?? process.cwd()
      const base = {
        query: args.query ?? '',
        path: args.path ?? '',
        ext: args.ext ?? '',
        lang: args.lang ?? '',
        n: args.n,
        ignoreCase: !!args.ignoreCase,
      }
      let text
      switch (mode) {
        case 'find':
          text = await runFind(options, base)
          break
        case 'content':
          text = await runContent(options, base)
          break
        case 'grep':
          text = await runGrep(options, base, workdir)
          break
        case 'deep':
          text = await runDeep(options, base, workdir)
          break
        case 'ast':
          text = await runAst(options, base, workdir)
          break
        case 'status':
          text = await runStatus(options)
          break
        default:
          throw new Error(`未实现 mode：${mode}`)
      }
      return { text }
    },
  }))
}

export { apply }
