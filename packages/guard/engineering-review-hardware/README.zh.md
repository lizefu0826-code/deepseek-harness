# @deepseek-ai/dsh-engineering-review-hardware

[English](README.md) | 中文

这是 [`@deepseek-ai/dsh-engineering-review`](../engineering-review) 的首个领域适配器：它识别发生变化的 C/C++／嵌入式与 Verilog/SystemVerilog 路径，提高相应工程风险，并贡献有针对性的审查问题和基于项目现有元数据的分析器配方。它绝不会把文件扩展名或文本模式本身当作 finding。

> **实验性测试版本：**请将本适配器与实验性 engineering-review 包配套使用，并使用项目自身工具链验证分析器结果。

## 配置与行为

```yaml
- id: engineering-review-hardware
  name: '@deepseek-ai/dsh-engineering-review-hardware'
  config:
    compilationDatabase: build/compile_commands.json
    verilatorArgsFile: .dsh/verilator.args
```

两个字段都是可选的工作区相对路径。没有显式路径时，C/C++ 审查只查找 `compile_commands.json` 或 `build/compile_commands.json`；HDL 审查只查找 `.dsh/verilator.args`、`verilator.f` 或 `verilator.args`。适配器不会创建这些文件、猜测构建图、安装任一可执行程序，也不会传递自动修复选项。显式配置的路径不存在时，会以降级原因消息上报（"configured compilationDatabase ... does not exist"），而不是静默跳过分析器，从而让用户知道分析器从未运行。

存在 compilation database 时，适配器贡献可选的 `clang-tidy -p <directory> <changed paths...>`。存在 Verilator 参数文件时，它贡献可选的 `verilator --lint-only -f <file>`。可执行程序缺失或可选运行失败时，核心门禁会明确降级到主模型自审；这些失败本身不会形成确定性 blocker。

C/C++ focus 包括阻塞进度、ISR／线程共享、锁与 I/O 交互、堆／栈、DMA／cache 一致性、超时与回绕算术、缓冲区、部分 I/O、寄存器访问、生命周期和恢复。新增的 C/C++ 控制流如果看起来会轮询硬件状态、却没有可观察的界限，审查风险会提升到 high；这仍然只是调度信号，绝不会直接宣布 finding。HDL focus 包括 CDC、复位释放、位宽／符号、锁存器推断、赋值语义、握手背压、综合语义、时序约束和断言。

## 模型体验

本包通过 dsh-engineering-review 的风险、focus、分析器结果以及 reviewer 或自审消息间接影响模型；适配器自身不注册提示词段或工具 schema。

#### KV Cache 影响

适配器自身不增加稳定模型上下文；由此产生的门禁消息只会追加，隔离 reviewer 请求则属于全新的子 agent。

## 已知限制与暂缓事项

- 适配器不会生成 compilation database、Verilator 参数列表、时序约束或 testbench。
- 分析器配方为可选，因为工具可用性与项目参数由部署拥有；项目可以在 `.dsh/engineering-review.yml` 中把等价检查提升为 `required`。
- 语言分类基于扩展名，只用于选择审查重点。最终 finding 仍必须来自确定性工具或工程审查提供的文件与行证据。
