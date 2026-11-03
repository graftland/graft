# 01 · Hello

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

你的第一个插件。它启动时说 hello，停止时说 goodbye。

你将学到：

- `Plugin.make` 定义插件。插件有名称、配置 schema，以及用来启动它的 `apply`。
- `Graft.plugin` 加载插件。正在运行的实例是一个 **fork**。
- `fork.update` 给 fork 一份新配置。默认情况下，插件会重启。
- `fork.dispose` 卸载插件。用 `Effect.acquireRelease`
  注册的清理逻辑会在插件每次停止时运行。

所有代码都在 [`src/main.ts`](src/main.ts) 中。

## 运行

在仓库根目录运行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-hello start
```

```text
Hello, Alice!
Goodbye, Alice!
Hello, Bob!
Goodbye, Bob!
```

`Goodbye, Alice!` 来自更新。Graft 会先停止旧实例，再启动新实例。

## 试一试

- 删除 `yield* fork.dispose` 这一行。`Goodbye, Bob!`
  仍然会被打印。程序结束时，Graft 会卸载它加载的所有插件。
- 把 `{ name: 42 }` 传给
  `Graft.plugin`。TypeScript 会拒绝它，因为配置 schema 规定 `name` 是字符串。

下一个：[02 · Services](../02-services)。
