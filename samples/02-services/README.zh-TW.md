# 02 · Services

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

一個外掛發布服務，另一個外掛使用它。你不需要檢查服務是否存在。只有當服務存在時，Graft 才會啟動使用該服務的外掛。

你將學到：

- `Graft.provide` 在外掛被載入期間發布一個服務。
- `inject: [Greeter]` 表示外掛需要一個 `Greeter`。在 `Greeter`
  出現之前，外掛會處於 `Pending` 狀態等待。
- 提供者卸載時，使用該服務的外掛會先停止，然後重新等待。當另一個提供者出現時，外掛會用新的提供者重新啟動。

所有程式碼都在 [`src/main.ts`](src/main.ts) 中。

## 執行

請在儲存庫根目錄執行：

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

`welcome` 裡沒有處理 `Greeter` 缺失的
`if`，也沒有從英語切換到法語的程式碼。Graft 會用目前存在的 `Greeter`
重新啟動它。

## 試一試

- 在 `english` 仍然載入時載入 `french`。第二個 `Graft.provide` 會以
  `ServiceConflict`
  失敗。同一時間只有一個外掛可以發布某個服務。要換成另一個，請像範例那樣先卸載第一個。

下一個：[03 · Events](../03-events)。
