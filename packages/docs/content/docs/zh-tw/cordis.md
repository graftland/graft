---
title: 從 cordis 遷移
description: cordis 的概念如何對應到 Graft 和 Effect。
---

Graft 沿用 [cordis](https://github.com/cordiverse/cordis)
的設計：應用程式是一棵外掛樹，外掛發布並使用服務，這棵樹可以在執行期間變化。差別在於，Graft 沒有自己的 context 物件、effect 系統或生命週期輔助工具，而是直接使用 Effect 現有的，只補上 Effect 沒有的部分。

## 概念

| cordis                                 | Graft                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ctx`，服務作為屬性存取                | Effect 環境。使用 `yield* Key` 讀取服務。                                                    |
| `ctx.plugin(plugin, config)`           | [`Graft.plugin(plugin, input)`](../lifecycle/#載入外掛)，回傳一個 fork。                     |
| `ctx.effect()`、可釋放物件             | `Effect.acquireRelease`、`Effect.addFinalizer` 和外掛的 `Scope`。                            |
| `inject`                               | [`inject`](../plugins/#相依)，由編譯器檢查，支援可選的項目。                                 |
| `ctx.provide`、`ctx.set`               | [`Graft.provide`](../services/#發布服務)。                                                   |
| Fiber 狀態                             | [fork 狀態](../lifecycle/#fork-狀態)：`Loading`、`Pending`、`Active`、`Failed`、`Disposed`。 |
| `fiber.update`                         | `apply` 回傳的[更新函式](../plugins/#原地更新)。                                             |
| `fiber.restart`                        | `fork.restart`。                                                                             |
| `ctx.isolate`、標籤                    | [`isolate`](../isolation/#領域)，對服務和事件都適用。                                        |
| `ctx.intercept`                        | 搭配 `Context.Reference` 使用的 [`intercept`](../intercepts/)。                              |
| `registry.replace`                     | [`Graft.replace`](../replace/)。                                                             |
| `ctx.on`、`ctx.emit`、`serial`、`bail` | [事件](../events/)：`on`、`emit`、`parallel`、`bail`、`waterfall`。                          |
| 使用 Standard Schema 的設定            | Effect `Schema`，在外掛啟用期間解碼。                                                        |
| 日誌、計時器和檔案系統外掛             | Effect 的 `Logger`、`Schedule`、`Clock` 和 `FileSystem`。                                    |
| 透過 `eval` 執行的 `!!js` 標籤         | 只支援 `!env NAME`。設定檔絕不會執行程式碼。                                                 |

## Graft 增加的能力

- **相依檢查。** 讀取未在 `inject` 中列出的服務會觸發型別錯誤。
- **可選相依。** `Plugin.optional(Key)`
  允許外掛在缺少某個服務時啟動。該服務出現或消失時，外掛會重新啟動。
- **固定的清理順序。**
  先撤回提供者發布的服務，再停止使用這些服務的外掛，最後才釋放提供者的資源。請參閱[服務撤回流程](../services/#服務撤回流程)。
- **可中斷的啟動過程。**
  如果外掛仍在啟動時相依的服務就消失了，Graft 會中斷啟動，外掛不會在已經消失的服務上完成啟動。
- **有型別且保留原因的失敗。** 外掛失敗時保留完整的 `Cause`，並可依 `Schedule`
  重試。
- **可使用服務的設定解碼。** 解碼可以非同步執行，也可以使用外掛的相依服務。
- **保留情境的處理函式。**
  事件處理函式使用所屬外掛自身的服務、領域（realm）和 intercept 執行。
- **原子性取代。** `Graft.replace` 在一筆交易中完成所有外掛的取代。

## Graft 不提供的部分

- **情境代理、mixin 和存取器。** Effect 環境和一般函式即可完成同樣的工作。
- **資源樹。**
  cordis 可以列出每個外掛持有的 effect。Graft 顯示 fork 樹，資源層級的細節交給 Effect 的追蹤工具。

## 讓程式設計代理遷移

儲存庫提供兩個[代理 skill](https://github.com/graftland/graft/tree/main/skills)，引導代理完成遷移。`migrate-cordis-plugin`
改寫外掛、服務及其測試；`migrate-cordis-app` 遷移
`cordis.yml`、外掛清單和主程式。用下面的指令安裝：

```sh
npx skills add graftland/graft
```
