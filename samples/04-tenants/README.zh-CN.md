# 04 · 租户

简体中文

两个租户在一个进程里运行同一套 Layer。每个都有自己的笔记，每个挂载读取自己的租户名。两个 Layer 都不接收租户 ID。

你会学到：

- `isolate`
  让服务在挂载之下拥有自己的领域。两个挂载可以发布相同的服务键，而不会触发
  `ServiceConflict`。
- 像 `[Notes, "acorn"]`
  这样的标签会把使用该标签的所有挂载放进同一个共享领域。使用相同标签的消费者会看到同一个服务。
- `intercept` 为一个挂载及其下所有内容调整引用。`Graft.intercept(Tenant, ...)`
  给每个挂载自己的租户名。
- 卸载一个租户不会影响其他租户及其服务。

示例逻辑在 [`src/program.ts`](src/program.ts) 里，[`src/main.ts`](src/main.ts)
运行它。

## 运行它

在仓库根目录：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/04-tenants start
```

```text
Opening notes for "acorn"
Opening notes for "northstar"
Saving "launch checklist" for "acorn"
Reading notes
  { texts: [ 'launch checklist' ] }
The reader stopped
Closing notes for "acorn"
Acorn left; Northstar still has its own notes
Saving "launch checklist" for "northstar"
Reading notes
  { texts: [ 'launch checklist' ] }
```

## 试一试

- 删掉 `isolate` 选项。两个挂载会在同一个领域发布 `Notes`，所以第二个会以
  `ServiceConflict` 失败。
- 把 Acorn 的标签改成
  `"northstar"`，但不改它的 intercept。读取者现在会看到 Northstar 的笔记，因为标签选择领域。
