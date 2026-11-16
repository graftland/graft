# 02 · 发布与重建

简体中文

配置并不特殊。它是一个发布到图里的值。需要它的挂载会在值变化时被重建。

你会学到：

- `Graft.publish` 把一个值放进图里，并返回带 `set`
  的 Publication。值由图的主管应用，所以如果下一步依赖它，先
  `publication.await`。
- 挂载的 `requires`
  列出 Layer 需要从图里取得什么。只有全部可用时 Layer 才会被构建。
- `publication.set` 替换值。每个需要它的挂载都会被拆除，并用新值重新构建。
- `mount.stable` 等待挂载及其子挂载完成加载。

示例逻辑在 [`src/program.ts`](src/program.ts) 里，[`src/main.ts`](src/main.ts)
运行它。

## 运行它

在仓库根目录：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/02-publish-rebuild start
```

```text
Building the greeter with "Hello"
Hello, world!
Releasing the greeter for "Hello"
Building the greeter with "Hi"
Hi, again!
Releasing the greeter for "Hi"
```

## 试一试

- 在发布 `Config` 之前挂载 `greeter`。挂载会保持
  `Pending`，直到值出现，然后自行构建。
- 删掉 `requires: [Config]`。TypeScript 会拒绝这个挂载，因为 Layer 需要
  `Config`，但 `requires` 没有列出它。
