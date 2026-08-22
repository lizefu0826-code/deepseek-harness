# Agent Note: 通用工程质量门禁

Status: implemented

[English](2026-08-15-engineering-review-quality-gate.md) | 中文

## 问题

工程变更可能在局部看起来合理，却遗漏常见的系统约束：有界进度、取消、所有权、部分 I/O、清理、状态提交顺序、兼容性、实时限制或充分的负向验证。只针对某一种串口模式或某一种语言的检测器会漏掉其他领域中同形的失败；永久注入大清单或无条件调用第二个模型，则会让每一轮都承担成本，却仍无法执行项目检查。

## 决策

在 agent 生命周期边界提供按需启用的 `@deepseek-ai/dsh-engineering-review` 服务。可用时捕获每轮 Git 标识基线，否则观察成功的变更工具；无法确定的 shell 副作用成为明确的高风险。审查以不可变的变更 fingerprint 为键，因此未变化的停止边界会去重，后续编辑则重新进入审查。

在模型判断之前运行项目拥有的确定性检查。配置采用版本化的 `.dsh/engineering-review.yml` 精确 argv 格式；没有配置时，只保守发现已有的标准脚本。运行时拒绝命令 shell、安装、自动修复、迁移、部署和路径逃逸。必需检查失败会形成 blocker；可选分析器失败会明确请求主模型自审。

适配器只能贡献风险信号、reviewer focus 和检查配方，不能产生 finding。首个适配器覆盖 C/C++／嵌入式与 Verilog/SystemVerilog，并且仅在项目已经提供所需元数据时调用 `clang-tidy` 或 Verilator lint。

达到风险阈值时，启动一个全新的 one-shot 结构化 reviewer；默认继承父 agent 路由，只接收受限证据、项目指令、最终生效的 skill 与包内 rubric。请求最多包含最近一条直接用户任务中的 16 KiB 文本，使 reviewer 能按任务约定检查变更，同时不继承父 agent 输出、推理或插件 steering。diff 完整的 fast 审查没有导航工具；deep 审查或证据截断时，只允许使用已有的只读导航。类别必须来自稳定的工程分类；仅接纳高置信度、critical/high 且带变更行证据的 candidate，较低置信度 candidate 会被省略而不是保留为 warning。接纳的 blocker 最多按配置预算返回原 agent 修正；之后只请求一次最终未解决 blocker 报告，并允许再下一个停止边界结束。预算为零时提供只报告审查，不授权修复轮次。

reviewer 输出默认限制为 8,192 token，并可通过 `reviewerMaxTokens` 显式覆盖。自动生命周期审查是常规门禁；`engineering_review` 工具只用于用户明确要求的额外或聚焦审查，避免 agent 重复发起同一次模型调用。中风险自动调度由证据驱动：没有通用或适配器风险信号的普通代码改动只做 checks-only；匹配到风险信号时可以绕过微小改动抑制。每个隔离 reviewer 还有可配置的墙钟时限；超时会取消并释放子 agent，然后沿用现有的可见自审降级路径。`r`n`r`n整个 reviewer 所有的生命周期由 `prepareTimeoutMs`、`startTimeoutMs`、`executionTimeoutMs`、`disposeTimeoutMs`、有界迟到 handle watcher 和 `totalTimeoutMs` 限制。`DeadlineContext` 从单调时钟的总 deadline 派生每个阶段预算，因此准备、启动、执行或清理卡住都不能延长 parent agent 路径。启动超时后所有权转交 watcher；未确认的 provider 保持 `unknown`，迟到 handle 会尽力释放。审查结果与清理／资源状态分开报告，生命周期诊断按优先级记录并有数量和字节上限。

每个 fingerprint 持久化一个精简的 `engineering-review/result` 事件。保留决策事实与降级原因，排除大段 diff、prompt、分析器流和重复缓存报告。

## 曾考虑的替代方案

- 在每个系统提示词中放置完整清单。这会让无变化和低风险轮次也承担 token，削弱提示焦点，而且无法运行确定性项目检查。
- 为阻塞式串口等已知错误增加模式检测器。模式命中缺少足够的执行上下文，不能宣布缺陷，也无法跨领域推广。
- 把策略直接实现到 agent loop 内部。现有生命周期与服务缝已经足够；归入核心会让领域适配器和按需 rollout 更困难。
- 对每个变化都启动独立 reviewer。这提高一致性，但会给低风险变更带来不必要的延迟和模型成本。
- 允许 reviewer 修改工作区。这样会混淆独立证据与修正责任，并通过带变更能力的子 agent 扩大权限面。

## 后果

门禁通过一条可复用流水线捕获广泛的工程失效类别，并允许项目把自己的构建与测试证据提升为必需 blocker。审查成本集中在中高风险变更和显式 deep 调用。硬件支持验证了扩展方式，而没有让核心绑定硬件。

非 Git 跟踪只对观察到的变更工具保持精确；任意 shell 副作用会有意降级为未知范围。可选分析器缺失和 reviewer 故障仍然可见，但不能伪造确定性证据。rubric 要求适用的工程要求与变更行证据，识别在已记录 timeout 范围内的无符号 elapsed subtraction 是 rollover-safe，并把 low/medium 建议、泛化的 API 风格偏好、可选加固与未记录的边界假设排除在 finding 之外。

Keyless 验证覆盖缓存共享与重试、进程限制、warning 与 blocker 结果、reviewer 释放、未知 shell 范围、Loader 组合以及 built CLI Web overlay 启动。手动 benchmark 将金标数据和外部 oracle 保持在临时工作区之外，在基线捕获后注入盲化 candidate，为每次运行隔离 Harness home，并扫描产物中是否出现复制的凭据材料。

手动 benchmark 包含 12 个成对 family 和 24 个 buggy/fixed 变体：Embedded C/C++、HDL 和后端代码中有 8 个一般 family、3 个组合风险 family 与 1 个 HDL 拔高 family。可用外部 oracle 会拒绝全部 8 个非 HDL buggy 变体，并接受其 fixed 对侧；宿主机没有 Icarus Verilog 或 Verilator 时，8 个 HDL 变体会报告 `oracle-unavailable`。UART oracle 接受任意非零的 timeout 失败码，不强加任务未声明的数值约定。资源生命周期一般题、重试／幂等组合题与 HDL 位宽拔高题各进行一次 review-only 校准，使用产品默认 medium 阈值、3,072-token reviewer 上限与零修正预算；每个 treatment 都调用一次 reviewer，其独立门禁命中金标，Recall 与 Precision 均为 1。一组配对 UART fix 运行的两个外部 oracle 均通过，修复后不再分配残余金标；fixed review 运行会分别报告 control 与 treatment 的 False Block，并汇总手动审查调用尝试造成的协议违规。这些随机样本验证了分层生命周期和评分路径，但不是发布证据；仍需重复的配对 A/B 采样。
