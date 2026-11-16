# 03 · 失败与重试

简体中文

Layer 可能构建失败。Graft 会保留这个失败，并在被要求时按计划重试。

你会学到：

- 构建失败会让挂载进入 `Failed`，并保留完整的原因。
- `retry` 在每次失败后按 `Schedule` 重新构建挂载。每次失败的尝试都会以带原因的
  `Failed` 出现在 `mount.state` 里。
- 在 `mount.state` 里等待 `Active` 是示例越过失败的方式；`mount.await`
  用于最终稳定下来的挂载。

示例逻辑在 [`src/program.ts`](src/program.ts) 里，[`src/main.ts`](src/main.ts)
运行它。

## 运行它

在仓库根目录：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/03-failure-retry start
```

```text
Connecting (attempt 1)
The backend is not ready yet
Connecting (attempt 2)
The backend is not ready yet
Connecting (attempt 3)
The mount is active
Using the backend, ready: true
Closing the backend
```

图还会记录每次带 `NotReady` 原因的 `Failed` 尝试。这里省略了那些行。

## 试一试

- 删掉 `retry`。挂载会一直保持 `Failed`，而 `mount.await` 会以 `NotReady` 失败。
- 给挂载一个有界计划，例如
  `Schedule.recurs(1)`。它会失败两次，然后等待变化，而不是一直重试。
