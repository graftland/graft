---
title: 替換與停止
description: 遠端外掛如何停止、如何被替換，以及如何撐過網路中斷。
---

遠端外掛的行程跟隨它的設定項目：卸載設定項目就會停止它，重新啟動設定項目就會替換它。透過 runner 時，Remote 保證：

- 只有確認舊行程已退出後，替換才會開始。
- 實例的每次啟動都會得到更大的 generation，runner 重新啟動後也一樣。

## 停止

遠端設定項目停止時，Remote 依以下順序進行：

1. **停止使用者。** 使用外掛服務的宿主外掛先停止，這時服務仍可正常使用。
2. **優雅停止。** 外掛在自己的行程中被卸載，finalizer 照常執行，受
   `shutdownTimeout` 限制。
3. **確保行程已經消失**，做法取決於它在哪裡執行：

| 執行於   | 優雅停止之後                                                                                |
| -------- | ------------------------------------------------------------------------------------------- |
| `local`  | 有一秒可以自行退出，之後被終止，再過一秒用 `SIGKILL` 強制結束。Remote 會一直等到確認退出。  |
| `worker` | 有一秒可以自行退出，之後呼叫 `worker.terminate()`。Remote 會一直等到執行緒確實退出。        |
| Runner   | runner 中斷行程，過了 `grace` 後強制結束它。宿主最多等待租約加上 `margin`，等 runner 確認。 |

`local` 子行程或 worker 錯過這一秒的時限時，會以 `LocalTerminationTimeout`
出現在 `Fork.CleanupError` 的 `cause`
中，即使隨後的終止成功也一樣。這通常表示 finalizer 執行完後，還留著定時器、socket 或其他控制代碼。

## Generation 與 fencing

runner 為實例的每次啟動分配一個
**generation**：一個存在磁碟上、只增不減的數字。外掛從 `Instance` 讀取自己的值：

```ts import.meta.vitest name="remote/lifecycle: read the instance"
import { Effect, Ref } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Instance } from "@graftland/plugin-remote"

const claimed = Ref.makeUnsafe({ owner: "", generation: -1 })
const ledger = {
	claim: (claim: { owner: string; generation: number }) =>
		Ref.set(claimed, claim),
}

const writer = Plugin.make({
	name: "app/writer",
	apply: () =>
		Effect.gen(function* () {
			const { id, generation } = yield* Instance
			yield* ledger.claim({ owner: id, generation })
		}),
})

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(writer)
		yield* fork.await
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

await Effect.runPromise(Ref.get(claimed)) // => { owner: "local", generation: 0 }
```

像這裡這樣不經 Remote 載入時，讀到的是 `local` 與 `0`：

| 執行於           | `id`                | `generation`     |
| ---------------- | ------------------- | ---------------- |
| 透過 runner      | 實例名稱            | 每次替換都會增長 |
| `local`/`worker` | 每次啟動一個新 UUID | 始終為 `1`       |
| 不是遠端外掛     | `local`             | `0`              |

用它來做
**fencing**：外部系統記住見過的最大 generation，並拒絕來自更小 generation 的寫入，慢吞吞的舊副本就無法覆蓋新副本的成果。

- 外部系統必須自己檢查 generation，Remote 不會代為檢查。
- 它不會撤銷已發生的寫入，也不能讓呼叫恰好執行一次。
- 每個 runner 各自計數，不同 runner 之間沒有協調。
- runner 重新啟動後，狀態目錄記錄著當時仍在執行的行程，runner 會先處理它們，再進行替換。

## 租約與網路中斷

宿主為自己的外掛行程持有一份**租約**，每過租約的三分之一就續約一次。宿主停止續約時（當機或網路中斷），runner 會在租約到期時停止外掛行程。runner 消失時，它的外掛行程也會自行關閉。

外掛行程自行結束時，runner 會立即通知宿主，宿主設定項目以 `ProcessExited`
失敗。無法送出此通知的 runner，宿主要等續約失敗時才會發現。

連線中斷時：

- 進行中的呼叫會失敗，錯誤是 `fromClient` 把 `RpcClientError`
  轉換成的錯誤。呼叫不會重試，正在呼叫外掛的 finalizer 也可能被中斷。
- 宿主設定項目以 `RemoteError`
  失敗，其中保存連線錯誤。它會在設定或相依變化時再次啟動，或依 `Remote.plugin`
  的 `retry` 排程重試。
- 外掛行程會一直執行到租約到期。
- 下一條連線在確認舊行程退出後替換它，並帶著更大的 generation。

租約不是硬即時的期限：整台機器暫停時，執行也隨之暫停。runner 在向行程送出訊號前會核對它的身分，但仍有一個很窄的窗口，可能把重複使用的行程 ID 誤認為舊行程。請讓[服務管理器](../runners/#架設-runner)負責 runner 的後代行程。

## 停止結果

| 結果                           | 意義                                                            | 回報方式                                    |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------------------- |
| `Exited`                       | 外掛已停止，且確認了它的退出。                                  | 宿主日誌中的 `remote.termination`。         |
| `Killed`                       | 行程被強制結束，並確認了這一點。部分 finalizer 可能沒有執行完。 | 宿主日誌中的 `remote.termination`。         |
| `RemoteTerminationUnconfirmed` | 沒有人能確認退出：宿主失去聯繫，或 runner 無法確認。            | dispose 時 `Fork.CleanupError` 的 `cause`。 |

這條日誌是 info 等級的 `Remote execution terminated`，附帶
`remote.termination`、`remote.instance` 與 `remote.generation`。請把
`RemoteTerminationUnconfirmed`
當作「可能仍在執行」：等到逾時並不能證明什麼，請檢查 runner 所在的機器。runner 在確認退出之前，會拒絕替換該實例。如果外掛經常以
`Killed` 結束，請調高 `shutdownTimeout`，或找出讓它忙碌的原因。

## 逾時與預設值

| 項目                          | 預設值             | 設定方式                                          |
| ----------------------------- | ------------------ | ------------------------------------------------- |
| 優雅停止                      | 5 秒               | `Remote.plugin` 的 `shutdownTimeout`；YAML 中固定 |
| `local`/`worker` 的退出時限   | 1 秒               | 固定                                              |
| `local`：終止後送出 `SIGKILL` | 1 秒後             | 固定                                              |
| 租約                          | 15 秒              | runner 的 `lease`，或宿主的 `connect.lease`       |
| 租約續約                      | 每過租約的三分之一 | 固定                                              |
| runner 上從中斷到強制結束     | 5 秒               | runner 的 `grace`                                 |
| 宿主等待退出確認              | 租約 + 5 秒        | 宿主的 `connect.margin`                           |

時長是 `30 seconds` 或 `500 millis` 這樣的字串。`lease`、`grace` 與 `margin`
必須是有限的正值。
