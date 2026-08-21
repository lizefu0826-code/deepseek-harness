# Agent Note: 可复现的基准报告（v0.1 报告基础设施）

Status: implemented

[English](2026-08-16-engineering-review-benchmark-report.md) | 中文

## 问题

校准 runner 已经产出每个 cell 的 `result.json` 工件，但缺少把它们变成可重复、可审阅的实验摘要的途径。解读数字 只能靠对 `.artifacts/` 做临时 shell 检索，而且很容易把开发期 pilot 批次（runner 有缺陷）与加固后的干净批次混在 一起。项目需要一条命令，不重跑任何模型即可确定性地重新生成回答成本、延迟、价值与风险问题的报告。

## 决策

- **提取器 + 聚合器合一**：`benchmarks/engineering-review/src/report.ts` 扫描 `.artifacts/engineering-review-bench/` 下的 `calibrate` 批次，遍历每个 cell（`case/variant/run-N/condition/result.json`），把每个 cell 归一化成一条 ML-实验记录（case_id、domain、difficulty、risk_tags、variant、condition、repetition、provider/model、 root 与 reviewer 拆分的 token 用量、reviewer 调用次数、correction passes、durationMs、oracle 状态、 matched/missed findings、bugRecall/findingPrecision/gateBugRecall/gateFindingPrecision/falseBlock、harness revision、 run 时间戳）。
- **确定性产物** 位于 `benchmarks/engineering-review/report/`：`results.csv`（每个 cell 一行）、 `results.json`（记录 + 头条聚合）、`report.md`（人类可读报告）。
- **头条批次选择**：只有记录在干净加固 revision `23bbce1d` 上的批次进入头条聚合；较旧的 `47f94385` 开发期 pilot 批次保留在原始数据中但不进入头条数字。选择依据是 revision 常量，因此报告可由相同工件复现。
- **诚实的实验框定**：报告明确 task mode 仅检测（Repair Success 刻意不测），记录 model + harness revision + reviewer 预算/风险阈值配置，把 DMA 漏报标记为已知局限，并把每个数字标注为模型相关的快照而非永久保证。
- **零模型成本**：生成过程是纯文件处理；回归命令 `pnpm exec tsx benchmarks/engineering-review/src/cli.ts report` 不消耗任何 token。

## 验证

- `tsc --noEmit -p benchmarks/engineering-review/tsconfig.json` 通过；benchmark `cli.spec.ts` 7/7 通过。
- 生成报告与会话中观测到的数字一致：治疗 False Block 0/7 vs 控制 3/7；Gate Recall 6/7（仅 DMA 漏报）； 治疗 finding precision 0.81 vs 控制 0.65；中位延迟增量 +18.5 秒；reviewer 边际成本 ≈ 每次 gate 调用 20.4K 输入 / 23.7K 输出 token。

## 考虑过的替代方案

- 每次报告都重新运行模型：不采用，因为报告生成必须保持确定性且不消耗模型额度。
- 混合 pilot 与加固后的批次：不采用，因为 runner 缺陷会污染头条聚合结果。
- 将仅审查指标当作修复成功：不采用，因为本报告不执行修复任务或外部修复 oracle。

## 后果

v0.1 报告基础设施完成：一条命令即可从既有工件重新生成 CSV/JSON/Markdown 报告，回归数据集与头条批次按 revision 固定。后续商定的步骤（风险分类器、自适应 reviewer、golden 集扩充、Correction benchmark）刻意未启动； engineering-review 功能本身进入维护模式。
