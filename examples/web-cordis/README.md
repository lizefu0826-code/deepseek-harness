# web-cordis

English | [中文](README.zh.md)

Self-referential demonstration of [`@deepseek-ai/dsh-tool-cordis`](../../packages/extensions/tool-cordis/README.md). The agent can inspect its current Cordis process and mount or unmount model-authored plugins in memory. Temporary plugins disappear when they are unmounted or the process exits and may affect other sessions in the same process.

## Run it

Start the browser interface:

```sh
pnpm run demo:cordis
```

Start the ACP automation server instead:

```sh
pnpm run demo:cordis acp
```

Both commands require `DEEPSEEK_API_KEY`. The [Cordis tool reference](../../packages/extensions/tool-cordis/README.md) defines the tool arguments, lifetime, cleanup, and safety contracts.

## Engineering review overlay

`engineering-review.cordis.yml` is an opt-in patch overlay for the generic Web profile. Apply it after the profile configuration to mount the generic engineering gate and the C/C++/embedded/HDL adapter. It adds no browser package or specialized renderer; `engineering_review` uses the existing generic tool card.

```bash
dsh web --patch ./examples/web-cordis/engineering-review.cordis.yml
```

The mounted core uses the existing filesystem, subprocess sandbox, skill registry, agent loop, and one-shot `spawn` subagent services. The overlay starts automatic reviewers only at high risk and caps them at 2,048 output tokens; manual deep review remains available. Project checks remain opt-in through `.dsh/engineering-review.yml`; the overlay never installs analyzers or generates build metadata.
