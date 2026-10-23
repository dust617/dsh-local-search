# dsh-local-search

DeepSeek Harness 的本地搜索插件：**常驻 1 个工具 schema**（`local_search`，≈0.4k tokens/步），统一 6 种模式。与原生 `glob`/`grep` 并存，优先用它。

| mode | 后端 | 说明 |
|---|---|---|
| `find` | Everything 1.5a（热） | 全盘文件名，多词=AND，可 `path` 前缀；~50ms |
| `content` | dowse 优先 → Everything 回落 | 持久索引（分词+评分排序），无覆盖/未建索引自动回落 `content:` |
| `grep` | host `rg` | 工作区内容，`query` 为 rg 正则，尊重 `.gitignore` |
| `deep` | `rga` + poppler | 无索引深扫目录（PDF/Office/压缩包），按需用 |
| `ast` | `ast-grep` | 代码结构模式（如 `function $NAME($$$)`），可 `lang` |
| `status` | — | 各后端版本 + Everything 热延迟 + dowse 索引根 |

设计结论（2026-10-23 实测）：小目录暖查各家都快；质变在**全盘 39ms、中文正文首条即中、junction 不漏检**（原生 glob 会漏掉 junction 目录，实测漏了 `dsh-turn-bill`）。详见 [实测记录](#实测记录)。

canonical 位置：本仓库（`D:\dsh-local-search`）。`deepseek-harness-remix` 里只留指针，profile 用 junction 指向这里，改这里即生效。

---

## 使用说明

### 前置依赖（换机安装清单）

| 依赖 | 用途 | 获取 |
|---|---|---|
| Everything 1.5 | `find`/`content`（正文索引是 1.5 功能，1.4 没有） | https://www.voidtools.com/downloads/ 绿色版解压即用；`content:` 需在 Everything 选项里启用内容索引 |
| ES CLI（es.exe） | Everything 的命令行 IPC | 随安装，或 https://github.com/voidtools/ES/releases 单下，放 PATH 或设 `EVERYTHING_ES` |
| ripgrep（rg） | `grep` | `winget install BurntSushi.ripgrep` 或 https://github.com/BurntSushi/ripgrep/releases |
| ripgrep-all（rga） | `deep`（PDF/Office/压缩包，可选） | https://github.com/phiresky/ripgrep-all/releases |
| ast-grep | `ast`（可选） | https://github.com/ast-grep/ast-grep/releases |
| dowse | `content` 首选后端（可选但推荐） | `cargo install --git https://github.com/ltspace/dowse dowse`（只要 CLI，不过 overlay、不设热键、无常驻）；或设 `DOWSE_EXE` |
| poppler | rga 读 PDF（可选） | `winget` 的 oschwartz10612.Poppler 包，或设 `POPPLER_BIN` |

找不到某个二进制时，工具报错会直接告诉你装什么、去哪下，不静默失败。跑 `local_search status` 一眼看全。

### 部署（dsh profile）

```powershell
# 1. junction 进 profile（改本仓库即生效）
cmd /c mklink /J C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-local-search D:\dsh-local-search

# 2. preset 加行（standard-lean / standard-extended 二选一或都加，无 config 即全默认走发现）
- id: tool-local-search
  name: 'dsh-local-search'

# 3. 同步并验证
node scripts/sync-agent-presets.mjs
node scripts/sync-agent-presets.mjs --check
node <dsh-bin> --dump-config --profile web   # 应含 dsh-local-search，exit 0

# 4. 重启 dsh web（新会话生效）
powershell -NoProfile -File restart-web.ps1
```

回滚：preset 删行 → 重跑 sync → 删 junction（`cmd /c rmdir ...`）→ 重启 dsh web。

### dowse 索引维护

```powershell
dowse index <目录>   # 全量建（首次）
dowse add <目录>     # 增量加根
dowse status         # 看根/文档数/体积
node test-smoke.mjs  # 5 项全绿 = 换机成功
```

content 路由：有索引覆盖 → dowse（分词+排序，无结果是确定结论，不回落）；无覆盖/没装 → Everything 1.5 `content:`。新目录记得 `dowse add`，否则走回落。

### 生命周期

- Everything 1.5a **由桌面壳常驻看护**（`deepseek-harness-remix/shell/src/everything-runtime.ts`）：隐藏后台（`-startup`，无任务栏窗口），随壳同生死，崩溃 20s 内自动拉回。
- 工具侧**只查不等、绝不自动拉起**：未就绪快速失败并提示重启壳。
- 运维记录 2026-10-23：1.5.0.1418b 偶发静默退出（非崩溃，疑被 `q stop` 或外部 `-exit` 带走）。`find` 失败时跑 `status` 确认；`content` 不受影响。

---

## 开发说明

### 结构

```
D:\dsh-local-search\
  package.json        插件包（name: dsh-local-search，peer @deepseek-ai/dsh-tools）
  lib/index.js        dsh 插件入口：apply(ctx, config) 注册 local_search（defineTool）
  lib/search.js       执行层，无 dsh 依赖，可被 node 直接单测
  test-smoke.mjs      冒烟：status/find/grep/content/ast，5 项
  README.md           本文件
```

`search.js` 不 import 任何 dsh 包——换机验证、单测都不需要 dsh 环境。

### 二进制发现（跨机可移植核心）

`resolveConfig()` 四级（高优先在前）：preset 显式 `config` → 环境变量（`EVERYTHING_ES` / `EVERYTHING_EXE` / `EVERYTHING_INSTANCE` / `RG_EXE` / `RGA_EXE` / `AST_GREP_EXE` / `DOWSE_EXE` / `POPPLER_BIN`）→ `PATH`（`where.exe` 同名查找）→ 常见落点（`E:\` 绿色版、`%ProgramFiles%`、`%USERPROFILE%\.local\bin`）。preset 行建议不写 config，换机零改动。

### 加一个后端（recipe）

1. `search.js` 里加 `runXxx(o, args, workdir)`，用 `execBin(cmd, argv, { timeoutMs })`（argv 直传、无 shell 层；输出走 `tryDecode` 自动 utf8→gbk）。
2. `needBin(o, key, label)` 找不到即报安装指引（先在 `INSTALL_HINTS` 加条目）。
3. `index.js` 的 `MODES` + switch 加分支；`runStatus` 加一行。
4. `test-smoke.mjs` 加一项；`node test-smoke.mjs` 全绿。
5. 跨机要求：必须走发现（不写死路径）、失败信息必须说清装什么。

### 约定

- 工具只查不等：任何后端都不自动拉起常驻进程（Everything/dowse 都是外部生命周期）。
- 回落只能向"更确定"的方向：dowse 无结果是确定结论，不回落到噪音更大的后端。
- 输出给模型的文本去 ANSI 色码、去 `\\?\` 前缀、超长截断（`maxChars`，默认 12000）。

---

## 实测记录

2026-10-23，同机对照（暖缓存）：

| | 新 | 老 |
|---|---|---|
| 找文件 `turn-bill` | es 全盘 39ms，2 条 | 原生 glob 0 条（junction 不跟随，漏检） |
| 正文"看护" | dowse 12~165ms，评分排序首条即中 | rg 22ms，7 行裸命中无排序；Everything `content:` 对"看护"/"local_search"交白卷 + GBK 乱码跨盘噪音 |

资源：Everything 1.5a 常驻 265MB（存量，本来就跑着）；新增常驻 0；dowse 索引 738KB/44 文件；每步多 ~0.4k tokens schema。

## 升级追踪（空闲时复查，有更好方案就升）

| 跟踪项 | 当前 | 值得升的信号 | 上次看 |
|---|---|---|---|
| Everything beta | 1.5.0.1418b | 升 1424b+（bugfix）；HTTP API 出"紧凑路径列表"正式版 → 可替换 es.exe 解析 | 2026-10-23 |
| ES CLI | 1.1.1.39 ✅（2026-10-24 已升，单文件替换，老版留 .bak-1.1.0.27） | 关注后续版有无 JSON 输出 | 2026-10-24 |
| ripgrep | 15.2.0 ✅（2026-10-24 已升，老版留 .bak-14.1.0） | — | 2026-10-24 |
| dowse | 1.2.1（git 编译） | releases 出预编译 CLI 包 → 换包免编译；MCP 稳定/语义搜索落地 → 重估直连 MCP | 2026-10-23 |
| everything-mcp（NingCiQiu，MIT） | 未用 | 它的 HTTP-JSON 回落 / count-before-fetch 值得抄；若 dsh 原生 MCP 更省 tokens，重估形态 | 2026-10-23 |
| Qoder codebase 索引 | 闭源云端，不可用 | 开源或出本地版 → 重估 | 2026-10-23 |
| Serena MCP（语义代码搜索） | 未用 | 代码语义场景可作 `ast` 之外的补充后端 | 2026-10-23 |

> 已设每月提醒复查上游更新（见会话 reminder）。决策原则：常驻不增、schema 不增、失败可回落，三条都满足才升。
