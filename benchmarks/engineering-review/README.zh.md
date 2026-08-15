# Engineering Review benchmark

[English](README.md) | 中文

这个手动 benchmark 使用成对的 buggy 与 fixed 变体评估 engineering-review。它不属于 pnpm workspace、默认 Vitest 输入、CI 任务或随产品发布的 profile。命令只会写入仓库已忽略的 `.artifacts/engineering-review-bench/` 和操作系统临时目录。

首批语料包含 12 个成对场景 family，以及 Embedded C/C++、Verilog/SystemVerilog 和后端代码中的 24 个可独立运行 buggy/fixed 变体。其中 8 个 family 为一般题，3 个组合多项相互作用的风险，1 个是 HDL 表达式位宽拔高题；一般题保持主体，同时保留少量拔高样本。HDL oracle 使用 Icarus Verilog 或 Verilator；两者都不存在时会报告 `oracle-unavailable`。金标 manifest、参考 patch 和 oracle 源码位于临时 agent 工作区之外。

验证 manifest、把每个变体应用到新的 Git 仓库，并运行可用的外部 oracle：

```sh
pnpm exec tsx benchmarks/engineering-review/src/cli.ts validate
```

该命令会输出产物目录。`run.json` 记录仓库 revision 与宿主工具版本；`results.jsonl` 为每个变体记录一行。

显式运行隔离的 with-key 校准：

```sh
pnpm exec tsx benchmarks/engineering-review/src/cli.ts calibrate --runs 3 --variant all --condition all
```

可以使用 `--case ID`、`--variant buggy|fixed|all` 或 `--condition control|treatment|all` 缩小 pilot 范围。`--task-mode fix` 测量修复与外部 oracle 成功率。`--task-mode review` 会把 treatment 的修正预算设为零，保持 candidate 不变，并单独测量 finding Recall／Precision。两个条件都必须输出相同的带标记 JSON 报告；control 使用该报告评分，treatment 使用独立门禁事件评分，同时记录 root 报告是否格式正确。金标匹配还会执行声明的最低严重度要求。runner 从 `DSH_HOME/.credentials.yaml` 读取 Harness 托管的 DeepSeek 凭据，只把必需的 Harness 设置复制到临时 home，并在每个进程结束后删除。如果凭据出现在任何持久化结果中，runner 会失败并删除整个运行产物目录。

每个 candidate 都在基线捕获后注入。Control 与 treatment 使用相同任务、关闭 reasoning，并采用 8,192-token root 响应上限；treatment 只增加自动 engineering-review overlay，使用产品默认的 medium-risk 阈值和 3,072-token reviewer 输出上限。任务明确禁止手动调用 `engineering_review`。结果分别记录 root 与 subagent 用量、自动审查观测和 correction pass，保留最终 patch，并在 agent 声明之外独立运行外部 oracle。Outcome Recall／Precision 对两个条件的最终带标记报告评分；独立的 gate Recall／Precision 只评估 treatment 的审查事件，因此既能记录 fallback 自审的成功，也不会隐藏 reviewer 漏报。在 fix 模式中，最终 oracle 通过意味着没有预期的残余缺陷，评分只读取最后一次门禁结果；缺陷 Recall 由 review 模式衡量，Fix Success 则衡量修复结果。False Block Rate 会在 fixed review case 中分别报告 control 与 treatment：control 使用带标记报告中的 high 或 critical finding，treatment 使用实际门禁结果。汇总还会统计手动审查调用尝试次数，以及发生这类协议违规的运行数。金标匹配必须同时满足精确类别或显式声明的跨类别等价项、最低严重度、证据路径以及声明行区间；只有类别与路径相符、但没有区间内行号的 finding 会进入人工复核队列，不会靠关键词得分。

可以使用 `node node_modules/vitest/vitest.mjs run --config benchmarks/engineering-review/vitest.config.ts` 显式运行 benchmark 自有的 keyless 协议与评分器测试。

不要把小规模 pilot 当作发布证据。对资源生命周期一般题、重试／幂等组合题和 HDL 位宽拔高题各进行一次 review-only 校准后，三个 treatment 样本的 gate Recall 与 Precision 均为 1。Treatment 都增加一次 reviewer 调用，分别耗时 29.2、35.5 与 37.6 秒；对应 Control 分别为 10.8、15.0 与 19.6 秒。工具尝试记录还显示，root 模型可能无视任务禁令而尝试已禁用的手动审查工具；该尝试不计为 reviewer 调用。这些随机样本验证了分层路径并暴露协议行为，但在提出发布结论前，仍需重复的配对 A/B 采样。

2026-08-15 的六 case 配对 A/B 采样（每单元一次）覆盖两个 standard（embedded-uart-timeout、embedded-isr-event-loss）、三个 combined（backend-retry-idempotency、embedded-dma-buffer-lifetime、hdl-clock-domain-crossing）与一个 advanced（hdl-expression-width）case。两种条件下最终结果 Recall 均为 6/6。Treatment 的 False Block 为 0/6，而 Control 为 3/6：门禁的高置信度＋变更行 admission 规则过滤掉了裸模型在 retry、DMA、ISR 三个 fixed 变体上的误报 high/critical，且 treatment 在 retry 与 ISR 上的 finding precision 从 0.5 提升到 1。唯一一次门禁漏报发生在 DMA case，原因值得记录：fast reviewer 的 prompt 里同时收到了有界 diff 与任务要求——包括任务声明的保留契约（"platform_dma_start retains the supplied buffer until dma_send_complete"，经 reviewer prompt 的任务要求段传入）——却仍然返回空 findings，而读取了文件的 root 模型抓到了栈生命周期 bug。因此这次漏报是 reviewer 行为问题而非信息访问问题：文件访问不会改变 reviewer 看到的内容。记录的优化方向：强化 reviewer prompt，要求逐条把任务声明的要求对照变更行检查并接纳高置信度违规；任何改动都必须用配对 A/B 协议重新测量，因为放宽 admission 有可能在目前保持干净的 fixed 变体上抬高 False Block。
