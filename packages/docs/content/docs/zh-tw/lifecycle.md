---
title: 生命週期
description: 載入外掛、觀察狀態，並在執行期間修改外掛。
---

## 載入外掛

`Graft.plugin` 載入外掛並回傳它的 fork（請參閱
[fork 控制代碼](../fork-handle/)）：

```ts title="app.ts"
import { Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const greeter = Plugin.make({
	name: "app/greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	apply: ({ greeting }) => Effect.log(`${greeting}, world`),
})

export const app = Plugin.make({
	name: "app/app",
	apply: () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(greeter, { greeting: "Hello" })
			yield* fork.await
		}),
})
```

| 引數    | 內容                                                         |
| ------- | ------------------------------------------------------------ |
| 第 1 個 | 外掛。                                                       |
| 第 2 個 | 外掛的輸入，由外掛的設定 schema 解碼。不需要設定時可以省略。 |
| 第 3 個 | 選項：[`isolate` 和 `intercept`](../isolation/)。            |

### 歸屬與停止順序

fork 隸屬於目前的 `Scope`。這個 `Scope` 關閉時，fork 就會卸載。在 `apply`
內，目前的 `Scope` 屬於外掛自身，因此在其中載入的外掛就是它的子外掛。

- 父外掛停止或重新啟動時，子外掛也會停止。
- 和父外掛 `Scope`
  中的其他內容一樣，它們依相反順序釋放：在父外掛開啟某個資源之後載入的子外掛，會在該資源關閉之前停止。
- 子外掛如果透過 `inject`
  使用父外掛的服務，則無論順序如何都會先停止。請參閱[服務撤回流程](../services/#服務撤回流程)。

## fork 狀態

fork 一律處於下列其中一個狀態：

| 狀態       | 含義                                         |
| ---------- | -------------------------------------------- |
| `Loading`  | 正在解碼設定或執行 `apply`。                 |
| `Pending`  | 等待必要的服務，`missing` 列出缺少的服務鍵。 |
| `Active`   | `apply` 已執行完畢，外掛正在執行。           |
| `Failed`   | 啟動或執行失敗，`cause` 包含完整的 `Cause`。 |
| `Disposed` | 已卸載，這是最終狀態。                       |

fork 會自動在這些狀態之間切換：

| 從        | 到         | 時機                                      |
| --------- | ---------- | ----------------------------------------- |
| `Pending` | `Loading`  | 所需的服務出現。                          |
| `Active`  | `Pending`  | 所需的服務消失。                          |
| `Failed`  | `Loading`  | 設定或相依項目變更，或 `retry` 排程觸發。 |
| 任何狀態  | `Disposed` | fork 被卸載，或其父 Scope 關閉。          |

### 失敗與重試

| 失敗來源                       | 結果                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| `apply`                        | `Failed`，然後走一般的 `retry` 路徑。                                       |
| `Plugin.fork` 任務（非純中斷） | 與 `apply` 相同。兄弟任務被取消並清理之後，完整的 `Cause` 仍會保留。        |
| 建構或執行 intercept           | `Failed` 並保留完整的 `Cause`，`await` 隨之結束。`retry` 排程**不會**重試。 |
| 單純的 `Effect.forkScoped`     | 不會回報給 supervisor。                                                     |

對於 intercept 失敗，fork 會等待設定更新或明確呼叫
`restart`。失敗歸屬於 supervisor 當時正在處理的 spec，包括原地更新。已經處理過的更新不會觸發再次嘗試；清理期間送達的新請求仍保持待處理。

重試如何與變更互動：

- retry driver 的初始化和每一步執行，都受同一個變更監督管理。
- 設定或相依項目變更會取消過時的操作，並等待其清理完成後再開始下一次嘗試。
- spec 和相依項目解析均未變更時，保留原有的 `Schedule` 狀態與重試預算。
- 排程失敗（包括變更引發的清理失敗）會合併進 activation 的 `Failed`
  `Cause`。卸載取消重試時新發生的失敗，則進入
  `CleanupError.cause`；先前已經發布的啟動失敗不會重播。

### 清理順序

1. 停止 `apply`。
2. 關閉發布並撤回服務。
3. 排空所有消費者。健康的任務繼續服務消費者的 finalizer，即使這次清理是由另一個任務的失敗觸發也一樣。
4. 停止剩餘任務並關閉它們的 Scope。
5. 關閉 activation Scope。
6. 釋放外掛自身相依項目的 lease。

排空期間發生的失敗同樣保留完整的
`Cause`，並由 Graft 記錄日誌。如果清理由失敗觸發，這些失敗會併入最終的 `Failed`
狀態。

## 觀察應用程式

### fork 樹

`Graft.forks`
是一個串流，描述整棵 fork 樹，並在每次變化時再次送出。每個節點包含 fork 的
`id`、`name`、`input`、`state` 和 `children`：

```ts import.meta.vitest name="lifecycle: read the fork tree"
import { Effect, Option, Stream } from "effect"

import { Fork, Graft } from "@graftland/graft"

import { app } from "./app.ts"

const trees = await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(app)
		yield* fork.stable
		return yield* Stream.runHead(Graft.forks)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

trees // => Option.some([{ id: 1, name: "app/app", input: undefined, state: Fork.ForkState.Active(), children: [{ id: 2, name: "app/greeter", input: { greeting: "Hello" }, state: Fork.ForkState.Active(), children: [] }] }])
```

### 日誌

`Graft.logs` 收集使用 `Graft.layer` 的環境中的日誌，包括宿主應用程式的日誌。

- 新的訂閱者會先收到最近的 1000 筆日誌。
- 外掛執行時送出的日誌帶有 `graft.fork` 和 `graft.plugin` 註解。
- 宿主日誌保留自己的註解，Graft 不會替它們捏造外掛身分。因此讀取日誌時，應允許這些註解缺少。
- 日誌層級、自訂註解和 span，請見[日誌與追蹤](../best-practices/observability/)。

## 相關頁面

| 頁面                                           | 內容                                                |
| ---------------------------------------------- | --------------------------------------------------- |
| [fork 控制代碼](../fork-handle/)               | `await`、`stable`、`update`、`restart`、`dispose`。 |
| [變更](../transitions/)                        | 在核心中部署外掛的新版本。                          |
| [錯誤](../errors/)                             | 所有具名的錯誤，以及該如何處理。                    |
| [疑難排解](../best-practices/troubleshooting/) | 找出 fork 為何沒有啟動或什麼也不做。                |
