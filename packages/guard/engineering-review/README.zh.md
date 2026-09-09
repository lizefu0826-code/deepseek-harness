# @deepseek-ai/dsh-engineering-review

[English](README.md) | 中文

这是 DeepSeek Harness 中一个按需启用的工程质量门禁。它记录当前轮次的代码变化、运行项目已有的确定性检查、在风险达到阈值时请求隔离的结构化审查，并把有证据支撑的 blocker 送回原 agent，最多进行两轮修正。审查标准覆盖通用工程失效模式，而不绑定某一种语言、协议或设备。

> **实验性测试版本：**请显式启用本包，并使用项目拥有的检查验证其 finding。首次稳定发布前，配置和审查行为可能变化。

## 安装

本包尚未发布到 npm。请直接安装 GitHub Release 中的固定版本产物：

```sh
pnpm add https://github.com/lizefu0826-code/deepseek-harness/releases/download/engineering-review-v0.2-rc.1/deepseek-ai-dsh-engineering-review-0.1.0-rc.5.tgz
```

该 tarball 会把版本匹配的 DeepSeek Harness 包声明为 peer dependency。如果工作区包含 C、C++、嵌入式、Verilog 或 SystemVerilog 代码，可从同一 Release 安装可选硬件适配器：

```sh
pnpm add https://github.com/lizefu0826-code/deepseek-harness/releases/download/engineering-review-v0.2-rc.1/deepseek-ai-dsh-engineering-review-hardware-0.1.0-rc.5.tgz
```

## 组合方式

请在 agent、文件系统、子进程、skill、tool 和 subagent 服务之后挂载本服务。默认 reviewer 使用全新的 one-shot `spawn` 后端；如果没有配置 `reviewerProvider` 或 `reviewerModel`，则继承父 agent 的 LLM provider 和 model。每次 reviewer 请求都受独立的 `reviewerMaxTokens` 输出上限约束（默认 8192）、`maxReviewContextBytes` 输入预算（默认 128 KiB）和 `reviewerTimeoutMs` 墙钟时限（默认 60000 ms）约束。生命周期还分别限制准备阶段（`prepareTimeoutMs`，5000 毫秒）、provider 启动（`startTimeoutMs`，10000 毫秒）、迟到 handle 回收（`spawnWatcherTimeoutMs`，30000 毫秒）、清理（`disposeTimeoutMs`，5000 毫秒）和 reviewer 总路径（`totalTimeoutMs`，90000 毫秒）；总 deadline 始终优先。

```yaml
- id: engineering-review
  name: '@deepseek-ai/dsh-engineering-review'
  config:
    automatic: true
    riskThreshold: medium
    maxCorrectionPasses: 2
    maxDiffBytes: 524288
    maxFiles: 100
    checkTimeoutMs: 120000
    subagentProvider: spawn
    reviewerMaxTokens: 8192
    maxReviewContextBytes: 131072
    reviewerTimeoutMs: 60000
    prepareTimeoutMs: 5000
    startTimeoutMs: 10000
    spawnWatcherTimeoutMs: 30000
    executionTimeoutMs: 60000
    disposeTimeoutMs: 5000
    totalTimeoutMs: 90000
```

本包会注册 `ctx.engineeringReview`、`engineering_review` 工具和 `engineering-review` skill。项目级 `.dsh/skills/engineering-review` 会按正常的 skill 优先级覆盖内置 skill。详细 rubric 保留在包内的 skill reference 中，并直接提供给隔离 reviewer。

## 变更证据与 fingerprint

首次 `agent/pre-step` 时，Git 工作区会捕获只读基线。Git 调用使用固定参数数组、`--no-optional-locks`、`--no-ext-diff` 和 `--no-textconv`；worktree 与 index 的对象标识可覆盖 staged、unstaged、untracked、rename 和 delete，而不会调用仓库控制的 filter。自动审查会在停止边界与该基线比较，因此预先存在的脏改动不会被算成本轮变化，除非本轮再次修改了它。文件数或 diff 超限会成为明确的高风险证据，不会静默隐藏。

非 Git 工作区通过成功的 `write`、`edit` 和 `str_replace_editor` 结果取得变更路径。成功的 shell 或 terminal 调用可能产生任意副作用，因此运行时会记录“变更范围未知”并提高风险，而不是声称追踪完整。每个 agent 的状态互相隔离；相同的 fingerprint／depth／focus 组合会共享正在进行或已经完成的审查。后续代码修改会产生新 fingerprint，并再次审查。

## 检查、复核与停止行为

显式 `.dsh/engineering-review.yml` 优先于保守的自动发现。缺少该文件时，JavaScript 工作区可运行已有的 `typecheck` 和 `lint` 脚本（手动 deep 审查还会加入 `test`）；Cargo 工作区可运行 `cargo check`（deep 时加入 `cargo test`）。运行时不会生成构建元数据或安装工具。每个检查都以精确 argv 在现有子进程沙箱策略下执行；命令 shell、依赖安装、自动修复、迁移、部署、路径逃逸和重复 id 会在校验时失败。

warning 不会阻止结束。必需检查失败或不可用，或者 reviewer 给出 critical/high 且高置信度的发现，才形成 blocker。可选分析器或 reviewer 故障属于非阻塞降级：运行时会明确要求主 agent 完成一次基于 rubric 的自审。blocker 会被送回同一个 agent 修正。达到 `maxCorrectionPasses` 后，运行时只再要求一次最终证据报告，并允许下一个停止边界正常结束，从而避免无限循环。把修正预算设为零会启用只报告行为：首个 blocker 会直接请求最终报告，不会授权修复轮次。

独立 reviewer 是一个全新的 one-shot 子 agent，不继承父会话的推理历史。它接收最近一条直接用户任务中最多 16 KiB 的文本，以及受限的变更证据、检查结果、项目指令、最终生效的 skill 和 rubric；agent 输出和插件 steering 不会进入任务投影。prompt 要求最终消息必须是纯结构化 JSON 对象、不得有散文，文件检查仅限于验证具体候选。diff 完整的 fast 审查没有导航工具；自动门禁对完整 diff 中的普通单行变更保持 checks-only，只有有实质变更的中风险才使用 fast；deep 审查、diff 截断或 diff 缺失时才允许使用部署中已有的只读文件、图片、LSP 与 Git 导航工具。reviewer 不能调用写入、编辑、shell、terminal、部署或自动修复工具。即使父级路由的 provider 默认值更大，`reviewerMaxTokens` 也会约束每次子请求；超过 `reviewerTimeoutMs` 的子 reviewer 会被取消并降级为自审 steering。准备、启动、执行和清理分别受生命周期预算限制；清理是尽力而为，不会替换有效的审查结果。启动超时后所有权转交给有界 watcher：迟到的 handle 会被清理，未确认的 provider 保持 `unknown`，不会被误报为已确认泄漏。生命周期诊断包含 correlation id、受限事件、incident、结果和资源状态。

运行时只接纳高置信度、critical/high 且至少引用一个落在变更 diff hunk 内的变更文件行的 candidate（行级接纳；diff 截断或缺失时回退到文件级接纳）。较低置信度 candidate、low/medium 建议、诊断偏好、API 风格建议、可选加固以及只有变更范围外证据的 candidate 都不会进入报告。结构化 schema 把类别限制在稳定的工程分类中，覆盖并发、生命周期、恢复、数据完整性、实时行为、状态与兼容性、安全、验证，以及 HDL 专用的时钟／复位／CDC 和位宽／时序语义。接纳的 finding 还包含置信度、文件和行证据、影响、修复建议与验证方法；运行时生成稳定 id，并把每个接纳的 candidate 映射为 blocker。
## 项目检查

项目文件具有版本号，并且只包含数据，不接受 shell 字符串：

```yaml
version: 1
checks:
  - id: firmware-build
    argv: [cmake, --build, build, --target, firmware]
    cwd: .
    files: ['firmware/**/*.c', 'firmware/**/*.h']
    timeoutMs: 120000
    required: true
  - id: unit-tests
    argv: [ctest, --test-dir, build, --output-on-failure]
    files: ['src/**', 'tests/**']
    required: true
```

`cwd` 和 `files` 都相对于工作区。没有 `files` 的检查适用于所有变更 fingerprint。可选检查失败会记录为降级并请求自审；必需检查失败会阻止结束。

## 扩展 API

`ctx.engineeringReview.registerAdapter(adapter)` 注册一个可随 HMR 清理的适配器；`ctx.engineeringReview.review(request)` 运行共享且带缓存的引擎。适配器只能贡献风险信号、reviewer focus 和精确 argv 检查，不能直接产生 finding，因此正则或扩展名命中只能指导审查，不能宣布存在 bug。

配套包 [`@deepseek-ai/dsh-engineering-review-hardware`](../engineering-review-hardware) 是首个适配器。它增加 C/C++／嵌入式与 Verilog/SystemVerilog 的审查重点，仅在已有 compilation database 时使用 `clang-tidy`，并且仅在已有或显式配置参数文件时使用 Verilator `--lint-only`。

## 持久化结果

每个已审查 fingerprint 只追加一个精简的 `engineering-review/result` 日志事件。它保留 fingerprint、风险、通过状态、检查状态、简短 finding 标识／标题、类别／置信度、文件与行坐标、降级原因，以及紧凑的生命周期 id、结果、资源状态、受限事件和 incident；证据正文、大段 diff、分析器输出、reviewer prompt 和重复报告都不会持久化。包级 invariant 会验证 `passed` 恰好是必需检查 blocker 与 finding blocker 的反值。

设计记录：[通用工程质量门禁](../../../.agents/notes/implemented/feature/2026-08-15-engineering-review-quality-gate.md)。服务参考：[工程质量审查子系统](../../../docs/subsystems/engineering-review.md)。

## 模型体验

### 自动停止门禁

#### 模型看到的内容

轮次没有工程代码变化，或者 fingerprint 审查通过时，不会增加任何内容。reviewer 或可选分析器降级时，会追加一条由插件提供的自审消息。出现 blocker 时，会追加一条由插件提供的修正消息，其中包含必需检查摘要，以及归一化后的 blocker id、标题、修复建议和验证方法。修正预算耗尽后，最后一条报告消息会要求模型停止编辑并报告未解决证据。

#### Token 影响

正常通过路径不增加模型 token。降级与 blocker 消息会保留在会话历史中；检查摘要和 reviewer finding 在渲染前均受长度上限约束。

#### KV Cache 影响

所有 steering 消息都只会追加在可复用请求前缀之后。修正代码会产生新的审查 fingerprint，但不会改变工具目录或系统提示词。

### 工程审查工具

#### 模型看到的内容

[`engineering_review` schema](../../../docs/tool-catalog.md#deepseek-aidsh-engineering-review) 接受可选的 `depth: fast|deep` 和 `focus`，并在现有 generic tool card 中以格式化 JSON 返回规范报告。`deep` 总会请求独立 reviewer；`fast` 遵循配置的风险阈值。自动停止门禁已经会在完成时执行审查，因此模型只会在用户明确要求额外审查，或需要提前进行聚焦审查时调用此工具。

#### Token 影响

稳定工具 schema 按 ToolRuntime 模式计费。手动调用会把参数和受限的 JSON 结果保留在会话历史中；自动审查不会伪造工具调用。

#### KV Cache 影响

工具 schema 在已挂载部署中保持稳定。手动调用参数与结果只在可复用前缀之后追加。

### 内置 skill 与 reviewer 请求

#### 模型看到的内容

skill 目录会公开 `engineering-review`；只有模型加载该 skill 时，正文才进入上下文。隔离 reviewer 接收一个单独的 one-shot 请求，其中包含受限的最近直接用户任务、diff、路径、检查、项目指令、流程、rubric 和 focus。这个子请求不会插入父会话。

#### Token 影响

父 agent 默认只承担 skill 目录条目；主动加载 skill 时才承担正文。高风险／deep 审查会产生单独的子请求，其中 diff 受 `maxDiffBytes` 限制，输出受 `reviewerMaxTokens` 限制；持久化事件不会重放该请求。

#### KV Cache 影响

加载 skill 或收到门禁消息会扩展父会话。reviewer 上下文属于全新的子 agent，不会使父会话缓存失效。

## 已知限制与暂缓事项

- 非 Git 的 write/edit 跟踪只能观察成功的已注册工具调用；任意 shell 副作用会被有意归类为未知高风险，而不会尝试重建。
- Git 路径与 diff 上限保证工作量有界，但可能降低 reviewer 精度；超限仍会通过风险与截断标记显式呈现。
- 自动标准检查发现有意保持很小。使用非标准构建图的项目应提交 `.dsh/engineering-review.yml`。
- 可选分析器缺失时无法产生其领域诊断；主模型自审是可见的回退，而不是同等证据。
- provider 未确认启动时，资源所有权保持 `unknown`；迟到 handle 会在 watcher 预算内继续清理，且不能延长 parent agent 路径。
- reviewer 质量仍受模型影响。稳定 blocker 策略限制升级范围；仍需持续通过前向评测衡量不同领域的召回率与误判 blocker 比例。
