# 03 · Events

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

插件通过属于自己的处理器监听事件。插件卸载时，它的处理器也会随之消失。

你将学到：

- `Event.make` 定义一个带类型的事件。
- `Event.on` 在插件的 `apply` 内注册处理器。
- `Event.emit` 调用此刻已注册的所有处理器。
- 没有取消订阅的调用。卸载插件时，Graft 会移除它的处理器。

所有代码都在 [`src/main.ts`](src/main.ts) 中。

## 运行

在仓库根目录运行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-events start
```

```text
Sending a message to both plugins.
printer: hello
shouter: HELLO!
Unloading shouter, then sending another message.
printer: anyone there?
```

## 试一试

- 处理器也可以给出回答。`Event.make<[question: string], Option.Option<string>>`
  搭配
  `Event.bail`，会返回第一个处理器给出的回答。这种方式以及其他分发方式，请参阅[事件](../../packages/docs/content/docs/zh-cn/events.md)。

下一个：[04 · Failures](../04-failures)。
