# Agent Note: 工程审查召回——reviewer 未应用任务声明的契约

Status: implemented

[English](2026-08-15-engineering-review-recall-diagnosis.md) | 中文

## 问题

2026-08-15 的六 case 配对 A/B 校准（见 [benchmark README](../../../benchmarks/engineering-review/README.md)）暴露了门禁隔离 reviewer 的首次漏报，发生在 `embedded-dma-buffer-lifetime`：gate Recall 为 0，而最终结果仍然通过（root Recall 为 1）。漏掉的金标缺陷是栈局部帧缓冲区被异步 DMA 传输超期使用。

本笔记的早期草稿把漏报归因于信息访问："fast 审查只看 diff，保留契约在 diff 之外。"该诊断与 prompt 构造矛盾，已被修正。fast reviewer 的 prompt 包含 `User task requirements:` 段（`reviewer.ts` 的 `reviewerPrompt`），由 `latestUserTask` 从 root 模型的用户消息填充；benchmark 把完整 `task.md` 文本作为该消息传入（`cli.ts` 校准任务组装），因此 reviewer 收到的就是逐字声明的契约（"platform_dma_start retains the supplied buffer until dma_send_complete is called"）加上有界 diff。它仍然返回空 findings（子代理输出 193 tokens，`findings: []`）。因此这次漏报是 reviewer 行为问题——reviewer 没有把任务声明的契约应用到变更行上——而非信息访问问题；授予文件访问不会改变 reviewer 看到的内容。

## 证据

- `reviewer.ts`——`reviewerPrompt` 输出 `User task requirements:\n${request.taskContext ?? '(not available)'}`；`latestUserTask` 返回最近一条用户来源文本消息。
- `benchmarks/engineering-review/src/cli.ts`——校准任务组装把完整 `task.md` 文本（含保留契约）作为 root 模型的用户任务传入。
- `benchmarks/engineering-review/cases/embedded-dma-buffer-lifetime/buggy.patch`——帧缓冲区为栈局部；`platform_dma_start(frame, length)` 在 `dma_send_complete` 之前一直持有它。
- `.artifacts/engineering-review-bench/2026-08-15T153825-336Z-*/embedded-dma-buffer-lifetime/buggy/run-1/treatment/result.json`——`gateBugRecall: 0`，reviewer 子代理输出 193 tokens，`engineeringResults[0].findings: []`；root 模型命中了金标。

## 提案

1. **在 reviewer prompt 中强调契约应用。** 指示 reviewer 逐条把任务声明的要求对照变更行检查，并在"任务契约＋变更行"共同构成违规证据时接纳高置信度 finding。这直接针对观察到的行为：reviewer 拿到了契约却没有应用它。
2. **采纳前先测量。** 任何放宽 reviewer 行为都是 Recall/False-Block 权衡。需用配对 A/B 协议在 DMA case 以及当前保持 False Block 0 的 fixed 变体（retry、DMA、ISR）上验证——benchmark 已同时评分两者。
3. 可选：在未来的运行中为 reviewer 子代理持久化 prompt/session，直接确认 prompt 内容，而不是仅依赖代码路径推理。

## 曾考虑的替代方案

- 为 fast 审查提供 deep 模式文件访问：证据不支持——reviewer 已在 prompt 中收到契约，文件访问不会改变结果。
- 提高 reviewer 输出上限：不能解决这次漏报——reviewer 以 193 tokens 正常完成。
- 保持现状：保住强 False Block 战绩，但把 DMA 类漏报留给 root 模型。

## 后果（若采纳）

门禁在契约密集的 case 上 Recall 提升，同时必须重新测量当前保持干净的 fixed 变体上的 False Block。benchmark 自带的 control/treatment 配对评分同时覆盖两者。

## 补充观察：无 diff（非 Git）会话上的 reviewer 输出预算问题

之后的一次降级（2026-08-16，GUI 会话）暴露了另一个相关但独立的 reviewer 行为失败：reviewer 在 8,192 token 上限下触顶 `max-tokens`，当时审查的是约 20 个文件的变更集。持久化的 reviewer 子代理记录展示了机制：非 Git 模式下审查请求没有文本 diff（`diff: ''`、truncated），reviewer 必须读文件才能知道改了什么；它跑了 25 步工具调用（含失败的读取、以及超出其工具过滤器的 glob/grep 尝试），然后把整个输出预算花在叙事性调查报告上（最后一步约 35K 字符），始终没有产出结构化 findings JSON，导致 `result.structured` 缺失、门禁降级。已应用三层修复：(1) prompt 层——reviewer 现在收到明确指令，最终消息必须是纯 JSON 对象、不得有散文，文件检查只用于验证具体候选；(2) 运行时层——当 reviewer 以 `max-tokens` 停止且无结构化结果时，`runReviewer` 用全新子代理重试一次，附带简洁作答指令、无工具、输出预算翻倍；(3) 结构层——非 Git 审查现在拿到真实 unified diff，因为每轮在文件首次变更时快照内容、审查时做 diff，空 diff 不授予工具，reviewer 直接作答而不是搜寻文件。完整变更集见 [加固笔记](2026-08-16-engineering-review-hardening.md)。
