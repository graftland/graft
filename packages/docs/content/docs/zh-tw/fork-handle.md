---
title: fork 控制代碼
description: fork 的各個成員，以及 update、restart 和 dispose 的行為。
---

`Graft.plugin`
會回傳 fork 控制代碼。本頁是其成員的參考。關於狀態，請參閱[生命週期](../lifecycle/)。

`generations`
以串流觀察受管理 fork 的有界代摘要；未受管理的 fork 回傳空清單。`generationEvents`
發布包含部署資料的即時變更，不提供重播。`update` 和 `restart`
在更改受管理 fork 或其祖先之前以 `ManagedFork`
失敗。見[執行轉換](../transitions/)。

## 成員

| 成員            | 作用                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `id`            | 用於在樹和日誌中識別 fork 的數字。                                                                     |
| `state`         | 先送出目前狀態，再送出每次變化的串流，以 `Disposed` 結束。                                             |
| `await`         | 等待 fork 離開 `Loading` 狀態。如果最終進入 `Failed`，則以外掛的錯誤失敗。                             |
| `stable`        | 等待目前的 fork 及其後代都離開 `Loading`。`Pending` 和 `Failed` 都視為已穩定，不會因子項目失敗而失敗。 |
| `update(input)` | 向 fork 傳入新輸入。外掛會[原地更新](../plugins/#原地更新)或重新啟動。                                 |
| `restart`       | 使用相同的輸入重新啟動外掛。                                                                           |
| `dispose`       | 卸載外掛及其載入的所有內容。                                                                           |

## `update` 和 `restart`

- 它們在請求被處理、被較新的請求取代，或 fork 已卸載時回傳。
- fork 只保留最新請求的設定。並行更新可能跳過中間輸入；被取代的更新仍會成功。
- 成功回傳不代表個別設定已經交付，這些呼叫也不會等待重新啟動完成。
- 若要觀察 fork 的目前狀態，請使用 `await` 或
  `state`。不要用它們來確認已被取代的輸入。

## `dispose`

- 並行及重複呼叫 `dispose` 會共用唯一一次關閉操作及其完整結果，其型別是
  `Effect<void, Fork.CleanupError>`。
- `CleanupError.cause` 保存原始的 typed
  failure、defect 和混合的中斷原因，它們來自 apply、被中斷的更新、受監督的任務、資源及 supervisor 清理。只有純中斷時，視為正常停止。
- 每個清理階段仍會執行，包括釋放相依項目的 lease。
- `Failed.cause` 會把清理失敗和原本的 activation 失敗合併在一起。結果一旦發布為
  `Failed`，之後卸載這個閒置的 fork 不會重播它。恢復時會使用新的清理結果。
- 父 Scope 會等待同一次清理，因此先卸載子外掛不會讓父資源提前釋放。取消等待者不會取消清理。
- 公開的 dispose 在 fork 與父層解除掛接後完成。
- Scope 自動關閉時，`CleanupError`
  會以 defect 回報，因為 Effect 的 finalizer 沒有 typed error 通道。原始的
  `Cause` 仍保留在錯誤中。
- 處理函式請求卸載自己的 fork 時，它自身也會被這次卸載中斷。

## `await`、`stable` 和 `state`

| 你想等到……                       | 使用                                                                       |
| -------------------------------- | -------------------------------------------------------------------------- |
| fork 離開 `Loading`              | `await`。它把 `Pending` 視為已穩定，因為等待中的 fork 可能永遠等不到服務。 |
| fork 正在執行                    | 觀察 `state`，等待 `Active`。                                              |
| 整棵子樹都沒有 `Loading` 的 fork | `stable`。                                                                 |
| Loader 的編輯已完全協調完成      | [`loader.ready`](../loader-api/)。                                         |

`fork.stable` 的型別是
`Effect<void>`。它透過子樹計數器等待，不必建構或訂閱整棵 fork 樹，並且只反映目前狀態，不反映尚未處理的設定請求。設定協調器仍須檢查請求版本和待處理的重新整理。失敗可透過
`state` 或 `await` 觀察。

卸載後才訂閱 `state`，仍會收到 `Disposed`，接著串流結束。
