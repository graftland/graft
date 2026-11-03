# 02 · Services

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

一个插件发布服务，另一个插件使用它。你不需要检查服务是否存在。只有当服务存在时，Graft 才会启动使用该服务的插件。

你将学到：

- `Graft.provide` 在插件被加载期间发布一个服务。
- `inject: [Greeter]` 表示插件需要一个 `Greeter`。在 `Greeter`
  出现之前，插件会处于 `Pending` 状态等待。
- 提供者卸载时，使用该服务的插件会先停止，然后重新等待。当另一个提供者出现时，插件会用新的提供者重新启动。

所有代码都在 [`src/main.ts`](src/main.ts) 中。

## 运行

在仓库根目录运行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-services start
```

```text
Loading welcome. No Greeter exists yet, so it waits.
Loading english. welcome starts on its own.
Hello, world!
Unloading english. welcome stops first, then waits again.
welcome stopped
Loading french. welcome starts again, with the new Greeter.
Bonjour, world !
welcome stopped
```

`welcome` 里没有处理 `Greeter` 缺失的
`if`，也没有从英语切换到法语的代码。Graft 会用当前存在的 `Greeter` 重启它。

## 试一试

- 在 `english` 仍然加载时加载 `french`。第二个 `Graft.provide` 会以
  `ServiceConflict`
  失败。同一时间只有一个插件可以发布某个服务。要换成另一个，请像示例那样先卸载第一个。

下一个：[03 · Events](../03-events)。
