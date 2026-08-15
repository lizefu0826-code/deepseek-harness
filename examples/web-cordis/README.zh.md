# web-cordis

[English](README.md) | 中文

[`@deepseek-ai/dsh-tool-cordis`](../../packages/extensions/tool-cordis/README.md) 的自指示例。agent（智能体）可以检查当前 Cordis 进程，并在内存中挂载或卸载模型编写的插件。临时插件会在卸载或进程退出时消失，并可能影响同一进程中的其他会话。

## 运行

启动浏览器界面：

```sh
pnpm run demo:cordis
```

改为启动 ACP（Agent Client Protocol）自动化服务器：

```sh
pnpm run demo:cordis acp
```

这两条命令都需要 `DEEPSEEK_API_KEY`。[Cordis 工具参考](../../packages/extensions/tool-cordis/README.md)定义了四类约定：工具参数、存续时间、清理行为和安全性。

## 工程审查 overlay

`engineering-review.cordis.yml` 是面向通用 Web profile、按需启用的 patch overlay。把它应用在 profile 配置之后，即可挂载通用工程门禁以及 C/C++／嵌入式／HDL 适配器。它不会增加浏览器包或专用 renderer；`engineering_review` 使用已有的 generic tool card。

```bash
dsh web --patch ./examples/web-cordis/engineering-review.cordis.yml
```

挂载后的核心复用现有文件系统、子进程沙箱、skill 注册表、agent loop 与 one-shot `spawn` subagent 服务。overlay 只在 high risk 时启动自动 reviewer，并把输出限制为 2,048 token；仍可手动执行 deep 审查。项目检查继续通过 `.dsh/engineering-review.yml` 按需配置；overlay 不会安装分析器或生成构建元数据。
