# Agent Note: 工程审查加固与 reviewer 鲁棒性

Status: implemented

[English](2026-08-16-engineering-review-hardening.md) | 中文

## 问题

初始工程质量门禁（见 [质量门禁笔记](2026-08-15-engineering-review-quality-gate.md)）带着五个潜在正确性问题和一个在真实使用中会降级或乱撞的 reviewer 上线：

1. 证据接纳只检查 finding 的路径是否在变更集内，reviewer 可能拿被触碰文件里的任意旧行来拦截。
2. 已取消的检查仍可能启动进程并跑到自己的超时。
3. 硬件适配器显式配置指向缺失的工具输入时被静默忽略。
4. 最终报告后的"停止修改文件"只是提示，没有强制。
5. 第三方 adapter 抛错会拖垮整个审查。
6. 非 Git 审查（没有文本 diff）时，隔离 reviewer 靠读整个工作区重建变更（实测 21-31 步工具调用），然后把输出预算花在叙事散文而不是结构化 JSON 上，以 `max-tokens` 停止、没有 findings，导致门禁在一个会话里降级自审五次。同一轮内创建再删除的文件产生空 diff，却仍授予读文件工具，引发 25 步漫无目的的文件搜寻。

## 决策

- **行级证据接纳**：finding 必须引用变更 diff hunk 内的行（`changedLineRanges` 解析 unified diff）；diff 截断或缺失时回退到文件级接纳。
- **早取消**：`runArgv` 在启动前调用 `signal.throwIfAborted()`。
- **adapter 隔离**：每个 adapter 贡献在独立保护中执行；失败转为显式 `degradedReasons` 而不是中断审查；硬件适配器对指向缺失 `compilationDatabase`/`verilatorArgsFile` 的显式配置给出明确上报。
- **最终报告冻结**：一旦请求最终 blocker 报告，变更工具（`write`/`edit`/`str_replace_editor`）在 `tools/execute` 处以显式错误被拒绝。
- **reviewer prompt 纪律**：prompt 要求最终消息必须是纯结构化 JSON、不得有散文；文件检查仅限于验证具体候选。
- **max-tokens 重试**：以 `max-tokens` 停止且无结构化结果的 reviewer 用全新子代理重试一次——简洁作答指令、无工具、输出预算翻倍。
- **非 Git 快照 diff**：每轮在文件首次变更时快照内容，审查时用 `createTwoFilesPatch` 生成真实 unified diff（覆盖新建/修改/删除/截断）；空 diff 不授予工具，reviewer 直接作答而不是搜寻文件。
- **Web overlay**：`reviewerMaxTokens` 从 2048 提升到包默认值 8192。
- **动态调度与上下文预算**：确定性检查先于模型调度运行。运行时记录 `checks-only`、`fast` 或 `deep`；低风险、完整 diff 中的普通单行自动变更和必需检查失败不会启动 reviewer；有实质变更的中风险使用精简 fast prompt，高风险、未知 shell 范围或证据截断进入 deep。每个请求受 `maxReviewContextBytes` 限制（默认 128 KiB），fast prompt 不携带完整 skill 和 rubric。
- **推理等级固定**：隔离 reviewer 子代理无论父会话的推理等级如何都以 `reasoningEffort: off` 运行。父会话以 high 推理等级运行时（例如 apiproxy 默认），会在最终消息之前把整个输出预算花在链式推理上，以 `max-tokens` 停止、无结构化 findings，且重试也失败（实测两次：两个 attempt 的 `reasoningTokens == outputTokens == maxTokens`）。reviewer 在创建子代理时通过 `AgentOptions` 传入推理等级，并保留 `agent/request` waterfall 监听器作为后续请求的兜底；首次请求因此不会继承 provider 的 high 默认值，使 JSON-only prompt 纪律在所有部署上足够。校准 CLI 本来就全局设为 off，所以它的批次从未触发此问题。

## 考虑过的替代方案

- 每次代码路径变更都启动 reviewer 被否决，因为确定性检查和风险信号应当吸收完整 diff 中的琐碎变更，而不额外调用模型。
- 每条路由都传入完整父任务、skill 和 rubric 被否决，因为这会重现上下文增长问题；fast 审查使用精简 rubric 和总字节预算。
- 只在后续请求监听器中固定推理等级被否决，因为首个子代理请求可能在监听器生效前竞争发出；现在在 spawn 时通过 `AgentOptions` 传入设置，并保留监听器作为兜底。
## 验证

- 99/99 单元/集成测试，100% per-file 覆盖率（statements/branches/functions/lines），oxlint 干净，全工作区 typecheck 干净，keyless headless snapshot 场景通过。
- 六 case 配对 A/B 校准（2026-08-15，每单元一次）：两种条件下最终结果 Recall 均为 6/6；treatment 的 False Block 0/6，control 3/6；treatment 在 retry 与 ISR 上的 finding precision 从 0.5 提升到 1。唯一一次门禁漏报（DMA 栈生命周期）被定位为 reviewer 没有应用任务声明的契约——该契约已在 prompt 中，属行为问题而非信息访问问题；见 [召回诊断笔记](2026-08-15-engineering-review-recall-diagnosis.md)。
- 重启后的 GUI 实测：reviewer 调查从 21-31 步工具调用降到真实 diff 上的 1 步、先写后删轮次上的 2 步；零次 `max-tokens` 降级。
- 2026-08-17：benchmark-report 变更（9 行 diff，可排除数据噪音膨胀）上又出现两次 `max-tokens` 降级，定位为父会话的 `reasoningEffort: high` 被子代理继承；usage 日志显示每个输出 token 都花在推理上。修复方式是在子代理请求上通过 `agent/request` waterfall 监听器固定 `reasoningEffort: off`；新增专门集成测试断言该固定。

## 后果

门禁现在可以端到端稳定运行：确定性检查、在首次尝试或一次重试内完成的隔离 reviewer、受行级接纳约束的 findings。False Block 战绩（treatment 0/6）是最强的价值证据。DMA 类漏报仍是已知限制；发布级验收线仍需要 benchmark README 中记录的重复配对 A/B 采样（24 变体 × 10 次）才能对外宣称 Recall/Precision 达标。
