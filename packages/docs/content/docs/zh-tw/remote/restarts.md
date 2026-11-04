---
title: 重新啟動、替換與停止
description: 重新部署、斷線和外掛停不下來時遠端外掛會怎樣，以及如何隔離外部副作用。
---

本頁面向遠端外掛的維運。這裡說明重新部署、宿主或網路消失、外掛沒能及時停止時會發生什麼，以及這些情況在日誌與錯誤中如何呈現。

## 遠端外掛如何停止

遠端項目被卸載、重新啟動或替換時，Remote 分兩個階段停止它的外掛行程：

1. **優雅停止。** 外掛在自己的行程裡被卸載，finalizer 照常執行。這個階段受
   `shutdownTimeout` 限制，預設五秒。只有 `Remote.plugin`
   能修改它；YAML 項目一律是五秒。
2. **確保行程已經消失。** 接下來怎麼做取決於外掛在哪裡執行：

| 執行於      | 優雅停止之後                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `local`     | 行程還有一秒可以自行結束。之後被終止，再過一秒以 `SIGKILL` 強制結束。Remote 會一直等到確認結束。                                         |
| `worker`    | worker 還有一秒可以自行結束。之後呼叫 `worker.terminate()`，Remote 會一直等到執行緒確實結束。                                            |
| 透過 runner | runner 中斷外掛行程；過了 `grace`（預設五秒，在 `runner.yml` 中設定）仍在執行就強制結束它。宿主最多等待租約加 `margin`，等 runner 確認。 |

對 `local` 與 `worker`
來說，超過這一秒的時間窗會記為清理錯誤（`LocalTerminationTimeout`），即使之後的終止成功也一樣。這通常表示外掛在 finalizer 執行完之後，還留著計時器、socket 或其他 handle。

## 重新部署外掛

以下情況會替換外掛行程：

- 宿主重新載入或重新啟動項目，例如它的 `config` 或 `connect` 變了；
- 宿主行程本身重新啟動；
- runner 收到同一身分、同一實例的新連線。

對直連的 `local` 或 `worker` 外掛而言，每次啟動都只是一個全新的行程。

透過 runner 時，替換嚴格得多。runner
**確認舊行程已經結束之後，才會啟動新行程**。無法確認時，替換就會失敗，而不是讓兩個副本同時執行。runner 重新啟動後也是如此：狀態目錄記得哪些行程當時仍在執行，runner 再次啟動時會先處理它們。

要把外掛套件的新版本部署到 runner：

1. 把新套件安裝到 runner 的安裝目錄。
2. 在宿主上重新啟動這個遠端項目，或重新啟動宿主。

runner 上的實作模組不參與宿主的[熱重載](../../hot-reload/)，在那邊儲存檔案對宿主沒有任何作用。如果**契約**改了，請重新建置並重新啟動宿主：契約的匯入同樣不參與熱重載。

## Generation：隔離外部副作用

runner 每為某個實例啟動一次外掛，就替這次啟動分配一個
**generation**（世代）：一個只增不減的數字。runner 把它存在磁碟上，所以 runner 重新啟動後它仍會繼續增長。

當外掛要寫入自身以外的東西（資料庫、佇列、鎖）時，就需要 generation。替換期間，一個慢吞吞的舊副本可能在新副本啟動時仍在完成某次寫入。如果外部系統記住見過的最大 generation，並拒絕來自較小 generation 的寫入，舊副本就無法覆蓋新副本的工作。這種做法稱為
**fencing**。

外掛從 `Instance` 讀取自己的身分：

```ts
import { Plugin } from "@graftland/graft"
import { Instance } from "@graftland/plugin-remote"
import { Effect } from "effect"

export default Plugin.make({
	name: "ledger",
	inject: [Ledger],
	apply: () =>
		Effect.gen(function* () {
			const { id, generation } = yield* Instance
			const ledger = yield* Ledger
			yield* ledger.claim({ owner: id, generation })
		}),
})
```

| 執行於           | `id`                  | `generation`     |
| ---------------- | --------------------- | ---------------- |
| 透過 runner      | 實例名稱              | 每次替換都會增長 |
| `local`/`worker` | 每次啟動一個新的 UUID | 一律為 `1`       |
| 不是遠端外掛     | `local`               | `0`              |

generation 是一種工具，本身並不構成保證：

- 外部系統必須自己檢查它，Remote 不會替你檢查。
- 它不會撤銷已經發生的寫入。
- 它無法讓呼叫恰好執行一次。
- 它不協調不同的 runner，每個 runner 各自計數。

## 租約

runner 分辨不出安靜的宿主和已經死掉的宿主，所以宿主持有一份**租約**：一個定期續約、表示「我還在」的承諾。租約預設 15 秒。runner 用
`lease` 設定預設值，宿主項目可以用 `connect.lease` 申請不同的長度。

- 宿主停止續約（當機或網路中斷）時，runner 會在租約到期時停止外掛行程。
- runner 本身消失時，它的外掛行程也會察覺並自行關閉。

租約有一些需要知道的侷限：

- 它不是硬即時的期限。整台機器暫停時，執行也隨之暫停。
- runner 在向行程送出訊號前會核對行程身分，但仍有一個很窄的時間窗，被重用的行程 ID 可能被誤認為舊行程。
- 請讓服務管理器負責 runner 的後代行程，見[在另一台機器上執行外掛](../runners/#4-啟動-runner)。

## 網路中斷時

宿主與 runner 之間的連線中斷時：

- 進行中的呼叫會失敗。呼叫端看到的是服務的 `fromClient` 將 `RpcClientError`
  轉換成的錯誤。呼叫不會重試，正在呼叫外掛的 finalizer 也可能被中斷。
- 宿主上的遠端項目以 `RemoteError`
  失敗，其 cause 中包含連線錯誤。它會像其他失敗的外掛一樣再次啟動：在設定或依賴變更時；如果是透過
  `Remote.plugin` 載入，也會依它的 `retry` 排程重試。
- 在 runner 上，外掛行程會一直執行到租約到期。連線本身並不決定它活多久。
- 宿主重新連線時，新連線會在確認舊行程結束後替換它，generation 隨之增長。

runner 會記錄一則警告
`Remote host connection failed`，附上原因與宿主身分。宿主正常中斷連線時不會有警告。

## 外掛停不下來時

對直連外掛來說，停止緩慢會呈現為
`LocalTerminationTimeout`（見[遠端外掛如何停止](#遠端外掛如何停止)）。透過 runner 時，每次停止都會落入以下三種結果之一：

| 結果                           | 意義                                                            |
| ------------------------------ | --------------------------------------------------------------- |
| `Exited`                       | 外掛正常停止，行程結束已確認。                                  |
| `Killed`                       | 行程不得不被強制結束，且已確認。部分 finalizer 可能沒有執行完。 |
| `RemoteTerminationUnconfirmed` | 沒有人能確認行程已經結束：宿主失去聯繫，或 runner 無法確認。    |

前兩種會出現在宿主的 `Remote execution terminated` 日誌中，帶有
`remote.termination`、`remote.instance` 與 `remote.generation` 註記。

`RemoteTerminationUnconfirmed` 是清理錯誤：`dispose` 以 `Fork.CleanupError`
失敗，可以在它的 `cause`
中找到它。請把它理解為「行程可能仍在執行」。等到逾時並不能證明行程已經結束。請檢查 runner 所在的機器。在 runner 能確認結束之前，它會拒絕為這個實例啟動替換行程。

如果外掛經常以 `Killed` 收場，可以用 `shutdownTimeout`
給 finalizer 更多時間，或找出是什麼讓它們一直忙碌。

## 停止期間的服務

Remote 在邊界兩側維持 Graft 一貫的[撤回順序](../../services/#服務撤回流程)：

- 使用遠端外掛服務的外掛，會在這些服務被撤回**之前**停止，所以它們的 finalizer 仍能呼叫健康的遠端服務。
- 如果契約 `inject` 中的某個宿主服務被撤回，遠端外掛會停止，直到服務恢復。
- 如果遠端外掛撤回它提供的服務，使用該服務的宿主外掛會停止。撤回之後發出的呼叫以
  `RemoteWithdrawn` 失敗。
- 連線中斷仍可能在任何時刻中斷呼叫與 finalizer。

## 日誌

外掛行程的日誌會轉送到宿主的 logger。負載很高時可能遺失一部分，宿主會記錄
`Remote logs were dropped` 以及遺失的筆數。
