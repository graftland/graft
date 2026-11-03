# 03 · Events

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

外掛透過屬於自己的處理器監聽事件。外掛卸載時，它的處理器也會隨之消失。

你將學到：

- `Event.make` 定義一個帶型別的事件。
- `Event.on` 在外掛的 `apply` 內註冊處理器。
- `Event.emit` 呼叫此刻已註冊的所有處理器。
- 沒有取消訂閱的呼叫。卸載外掛時，Graft 會移除它的處理器。

所有程式碼都在 [`src/main.ts`](src/main.ts) 中。

## 執行

請在儲存庫根目錄執行：

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

## 試一試

- 處理器也可以給出回答。`Event.make<[question: string], Option.Option<string>>`
  搭配
  `Event.bail`，會回傳第一個處理器給出的回答。這種方式以及其他分派方式，請參閱[事件](../../packages/docs/content/docs/zh-tw/events.md)。

下一個：[04 · Failures](../04-failures)。
