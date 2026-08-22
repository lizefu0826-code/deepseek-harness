# 工程质量审查

[English](engineering-review.md) | 中文

工程质量审查子系统是面向产出代码的 agent 轮次、按需启用的结束门禁。它把确定性的项目证据与按风险触发的独立判断组合起来，只把高置信度 blocker 返回给产生变更的原 agent。核心保持领域中立；适配器只能增加风险、focus 和检查配方，不能获得宣布 finding 的权限。

> **实验性测试版本：**部署必须显式启用本子系统；首次稳定发布前，应以项目自身验证为准。

Service Definition 为 [`@deepseek-ai/dsh-engineering-review`](../../packages/guard/engineering-review)（`ctx.engineeringReview`、`engineering_review` 工具、内置 skill 与 `engineering-review/result`）。首个 Service Consumer 是 [`@deepseek-ai/dsh-engineering-review-hardware`](../../packages/guard/engineering-review-hardware)，它注册一个覆盖 C/C++／嵌入式和 HDL 的适配器。设计理由见[工程质量门禁 Agent Note](../../.agents/notes/implemented/feature/2026-08-15-engineering-review-quality-gate.md)。

## 审查流水线

每轮首次 pre-step 时，服务会捕获 Git 对象标识基线，或启动一个非 Git 窗口，快照每个被触碰文件在首次变更前的内容。停止边界会生成变更路径、受限 diff（非 Git 轮次为基于内容快照生成的真实 unified diff）和 fingerprint。没有变化就不审查；已经审查的 fingerprint 会复用结果；后续修改会改变 fingerprint 并重新进入流水线。

引擎会加载版本化项目检查，或者只发现已有的标准脚本，然后合并适配器贡献，并在已挂载的子进程沙箱中运行适用的精确 argv 检查。引擎先运行确定性检查，再选择 `checks-only`、`fast` 或 `deep`。低风险只做检查；没有通用或适配器风险证据的普通自动代码改动也只做检查；带有这类证据的中风险使用精简 fast reviewer；高风险、未知 shell 范围或证据截断进入 deep。必需检查失败会短路 reviewer 调度但仍阻止结束。手动 `deep` 在检查之后启动 reviewer；warning 不阻止结束。

```text
pre-step baseline
  -> stopping fingerprint
  -> deterministic checks
  -> risk contributions
  -> optional isolated reviewer
  -> pass | steer correction | final blocker report
```

reviewer 或可选分析器故障属于可见降级，而非静默成功。reviewer 在输出结构化结果前耗尽输出预算时，会用简洁作答指令、无工具、预算翻倍的子代理重试一次；只有再次失败才进入降级路径，主 agent 会针对该 fingerprint 收到一次聚焦自审请求。reviewer 子 agent 有可配置的准备、启动、执行、清理、watcher 和总 deadline。总 deadline 会限制每个阶段，因此任何 reviewer 操作都不能延长 parent agent 的关键路径。启动超时后所有权转交给有界 watcher；迟到 handle 会尽力回收，未确认的所有权保持 `unknown`。清理是尽力而为，失败会与审查结果分开记录。超时会显式降级并进入自审回退。blocker 最多触发 `maxCorrectionPasses` 次修正请求。仍未解决时，下一个边界只触发一次“停止编辑并报告”的请求；再下一个边界正常结束。修正预算为零时是只报告模式，首个 blocker 会直接进入最终报告边界。

## 证据与安全边界

Git 检查会禁用 optional lock、external diff 和 text conversion，并在不运行仓库 filter 的情况下散列 staged/worktree 标识。非 Git 证据在每个被触碰文件首次变更时快照内容，并把该基线 diff 到当前文本，因此 reviewer 拿到真实内容而不是空的变更清单；同一轮内创建再删除的文件或无法读取的路径会产生空 diff 且不授予 reviewer 工具。shell 或 terminal 成功会把变更范围标成未知并提高风险。文件数量、diff 字节数、分析器输出和日志摘要都有上限。

项目检查是只包含数据的精确 argv。运行时拒绝直接命令 shell、依赖安装、自动修复参数、迁移、部署、重复 id 与工作区相对路径逃逸。它绝不会安装依赖、创建构建元数据或要求分析器改写代码。检查在已有沙箱权限内运行，不会自动申请更宽权限。

one-shot reviewer 只接收最近一条直接用户任务中最多 16 KiB 的文本投影、路径、受限 diff、检查结果、项目指令、skill 流程、rubric 与 focus；prompt 有可配置的 `maxReviewContextBytes` 总预算（默认 128 KiB）；fast review 不携带完整 skill 和 rubric。父 agent 输出与插件 steering 均不会进入请求。prompt 要求最终消息必须是纯结构化 JSON 对象、不得有散文，文件检查仅限于验证具体候选。diff 完整的 fast 审查没有导航工具；deep 审查、diff 截断或 diff 缺失时，才允许使用部署中已有的只读文件／图片、LSP 与 Git 导航工具。结构化 schema 要求从共享的稳定工程分类中选择类别。父运行时只接纳高置信度、critical/high 且引用行落在变更 diff hunk 内的 candidate（行级接纳；diff 截断或缺失时回退到文件级接纳），生成 finding id，并把每个接纳的 finding 映射为 blocker；较低置信度 candidate 会被省略，而不是变成 warning。

## 适配器约定

`registerAdapter()` 通过 Cordis effect 管理注册生命周期。适配器的异步 `contribute()` 方法可以返回风险信号、reviewer focus、精确 argv 检查与降级原因报告，但不能返回 finding 或 blocker。`review()` 按 agent 缓存不可变的 fingerprint／depth／focus 请求，既共享并发调用，也保持 agent 之间隔离。

硬件分类有意只充当选择器。C/C++ 路径会贡献嵌入式并发、内存、时序和恢复重点；HDL 路径会贡献时钟、复位、位宽、握手、综合、时序和断言重点。`clang-tidy` 要求已有 compilation database；Verilator 要求已有项目参数，并始终使用 `--lint-only`。

## 持久化投影

每个 fingerprint 只记录一个 `engineering-review/result` 事件，其中包含精简决策证据：fingerprint、风险、通过状态、检查 id／status／required 三元组、finding 标识／类别／severity／confidence、文件与行坐标，以及可选降级原因；还包含紧凑的生命周期 id、结果、资源状态、受限事件与 incident。证据正文、diff、完整分析器输出、prompt 和重复的缓存报告都会被排除。该事件只进入日志，不进入普通模型历史。

包级 invariant 会拒绝 `passed` 与“必需检查失败／不可用”及 blocker finding 的反值关系不一致的结果。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxengineeringreview--engineeringreviewruntime"></a>

### `ctx.engineeringReview` — `EngineeringReviewRuntime`

Generic engineering review engine and adapter registry.

```ts cordis-catalog
/**
 * Register one adapter until the calling plugin is disposed.
 * @param adapter - domain contribution provider with one stable id.
 * @returns the exact Cordis effect disposer for this registration.
 */
registerAdapter(adapter: EngineeringReviewAdapter): () => void

/**
 * Review one immutable change fingerprint, sharing in-flight and completed work.
 * @param request - bounded evidence, route owner, depth, and workspace readers.
 * @returns the canonical deterministic and reviewer report.
 */
review(request: EngineeringReviewRequest): Promise<EngineeringReviewReport>
```

Source: [`packages/guard/engineering-review/src/index.ts:362`](../../packages/guard/engineering-review/src/index.ts)
<!-- END GENERATED cordis-surface -->
