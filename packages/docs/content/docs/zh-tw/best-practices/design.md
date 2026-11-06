---
title: 設計應用程式
description: 依照每個部分的擁有者和生命週期，把問題拆成外掛、服務、事件、領域和設定。
---

當 Graft 應用程式的結構與**生命週期**相符時，就容易修改。所謂生命週期，指的是能各自啟動、停止、變更、失敗或被取代的部分。先找出這些部分，為每個部分指定擁有者，該呼叫哪些 API 自然就清楚了。

## 為每個部分選擇構件

逐一檢視功能清單中的每個部分，問下列問題：

| 如果這個部分……                                     | 就做成                                    | 參閱                                   |
| -------------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| 能單獨啟用、停用、重新設定或取代                   | **外掛**，即 `graft.yml` 中的一個設定項目 | [外掛](../../plugins/)                 |
| 提供其他部分會呼叫的能力                           | 由所屬外掛發布的**服務**                  | [服務](../../services/)                |
| 少了另一個部分就完全無法運作                       | `inject` 中的必要鍵                       | [相依](../../plugins/#相依)            |
| 有另一個部分會更好，沒有也能運作                   | `inject` 中的 `Plugin.optional`           | [相依](../../plugins/#相依)            |
| 發出通知，讓任意數量的部分回應                     | **事件**                                  | [事件](../../events/)                  |
| 每個租戶需要自己的服務實例或處理函式               | **領域**，使用 `isolate`                  | [領域](../../isolation/)               |
| 是共用服務從呼叫端讀取的設定                       | `Context.Reference` 上的 **intercept**    | [Intercept](../../intercepts/)         |
| 與行程同壽，沒有人設定它                           | 由宿主提供的**環境服務**                  | [服務](../../services/#來自環境的服務) |
| 是由維運人員決定的值                               | 外掛設定 schema 中的欄位                  | [設定檔](../../config-file/)           |
| 必須單獨崩潰、使用自己的執行緒或在另一台機器上執行 | 仍然是外掛，它的設定項目使用 Remote       | [Remote](../../remote/overview/)       |

只建構一個服務，或包裝既有 `Layer` 的部分，同樣是外掛；請用
[`Plugin.service` 或 `Plugin.layer`](../../plugins/#從服務和-layer-建立外掛)
撰寫。

### 服務還是事件

| 問題               | 服務                                                         | 事件                                         |
| ------------------ | ------------------------------------------------------------ | -------------------------------------------- |
| 有幾個部分提供它？ | 每個領域中每個鍵一個。第二個發布者會得到 `ServiceConflict`。 | 任意數量的處理函式，也可以沒有。             |
| 必須先存在嗎？     | 是。必要鍵會讓呼叫端停在 `Pending`。                         | 否。派發只會送到現有的處理函式，沒有也無妨。 |
| 典型用途           | 連線、儲存、用戶端。                                         | 通知、貢獻項目、過濾鏈。                     |

許多外掛貢獻同一類東西（命令、路由、選單項目）時，請使用事件。帶有 `register`
方法的服務，會讓每個呼叫端都得記得呼叫 `unregister`。

貢獻的方式決定要用哪個[派發函式](../../events/#派發事件)：

| 處理函式……                             | 派發方式                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------ |
| 只需要知道發生了什麼                   | `Event.emit`                                                             |
| 各自為同一個結果加上一部分（說明文字） | `Event.parallel`                                                         |
| 認得輸入時才回應（命令）               | `Event.bail`                                                             |
| 包裹、修改或攔下一個值（過濾器）       | 在 [`Event.middleware`](../../events/#中介軟體) 上使用 `Event.waterfall` |

## 狀態放在哪裡

狀態屬於在 `apply`
中建立它的 fork。其他 fork 只能透過該 fork 的服務或事件存取它：

```ts import.meta.vitest name="best-practices/design: where state lives"
import { Context, Effect, Ref, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

class Visits extends Context.Service<
	Visits,
	{ readonly count: Effect.Effect<number>; readonly add: Effect.Effect<void> }
>()("@acme/graft-plugin-visits/Visits") {}

const visits = Plugin.make({
	name: "app/visits",
	apply: () =>
		Effect.gen(function* () {
			const count = yield* Ref.make(0)
			yield* Graft.provide(Visits, {
				count: Ref.get(count),
				add: Ref.update(count, (n) => n + 1),
			})
		}),
})

const visitor = Plugin.make({
	name: "app/visitor",
	inject: [Visits],
	apply: () =>
		Effect.gen(function* () {
			const visits = yield* Visits
			yield* visits.add
			const count = yield* visits.count
			yield* Effect.log(`Visit ${count}`)
		}),
})

const messages = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(visits)
		yield* (yield* Graft.plugin(visitor)).await
		yield* (yield* Graft.plugin(visitor)).await
		return yield* Graft.logs.pipe(
			Stream.take(2),
			Stream.map((line) => line.message),
			Stream.runCollect,
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
messages // => [["Visit 1"], ["Visit 2"]]
```

| 規則                                    | 原因                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 在 `apply` 中建立狀態，不要放在模組頂層 | 模組層級的值由該外掛在所有領域中的每個 fork 共用，fork 停止時也沒有東西會釋放它。                                |
| 預期重新啟動會從乾淨狀態開始            | 重新啟動會在新的 `Scope` 中再次執行 `apply`。要在設定變更時保留狀態，請回傳[更新函式](../../plugins/#原地更新)。 |
| 把持久狀態放在外掛後面                  | 必須比行程活得更久的資料，應存放在由外掛於 `apply` 中開啟、在終結器中寫回的儲存裡。                              |
| 預期 Remote 外掛在設定變更時遺失狀態    | 它[從不原地更新](../../plugins/#原地更新)。                                                                      |

## 以歸屬取代手動管理

每個處理函式、服務、資源和子 fork 都歸建立它的 scope 所有，因此外掛系統通常需要的那些程式碼都可以省掉：

| 手寫做法                       | 在 Graft 中                                                                                  | 手寫時的問題                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 中央註冊表加上取消註冊的呼叫   | 在 `apply` 中使用 `Event.on` 或 `Graft.provide`                                              | 漏掉一次取消註冊，就會留下一個呼叫已關閉部分的處理函式。 |
| 使用可選部分前先 `if (client)` | `inject: [Client]`，或 `Plugin.optional(Client)`                                             | 檢查通過了，用戶端卻在呼叫途中消失。                     |
| 一份啟動順序清單               | 每個外掛等待自己注入的服務                                                                   | 維運人員新增或停用設定項目時，清單就失效了。             |
| 模組層級的單例                 | 由外掛發布的服務，或環境服務                                                                 | 無法取代、隔離或釋放。                                   |
| 寫在程式碼裡的功能旗標         | 在設定項目上設定 `disabled: true`                                                            | 被停用的功能仍佔用著資源。                               |
| 重新啟動行程來套用設定         | 為設定項目提供新的 `config`；[只有該項目](../../config-file/#執行期間的變更)會更新或重新載入 | 其他所有部分也跟著重新啟動。                             |
| 一份與已載入內容保持同步的清單 | 一個每項功能都會處理的事件，需要時再收集                                                     | 功能失敗或卸載時，清單就會與實際情況脫節。               |

只為了記錄日誌就捕捉錯誤然後繼續執行，會讓壞掉的部分繼續運作。請在能採取行動的地方復原，否則就讓 fork 失敗並重試；請參閱[外掛中的 Effect](../effect/)。

一次註冊多樣東西的輔助函式（例如一個命令連同它的說明文字），不需要自己清理：只要在
`apply` 中呼叫，它註冊的一切都歸呼叫端的 fork 所有。

## 外掛的粒度

一個外掛就是一個生命週期。依照「哪些東西會一起變動」來拆分。

| 太大                                                                                            | 太小                                               |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 設定一變更，所有部分都重新啟動，除非有更新函式套用它。                                          | 一個生命週期分散在總是一起載入的多個設定項目中。   |
| 一個[背景任務](../../plugins/#任務失敗時)失敗，會讓整個 activation 失敗，無關的部分也一起停止。 | 共用私有狀態的部分，必須把狀態發布為服務才能存取。 |
| 維運人員無法單獨關閉其中一部分。                                                                | 每次互動都需要公開的識別物件。                     |

當命令會單獨變動時，把用戶端和使用它的命令做成兩個外掛：重新設定或停用某個命令時，用戶端的連線仍保持開啟。命令注入用戶端的服務，並在服務消失前停止。

### 群組項目還是組合外掛

兩者都把多個外掛當作一個單位載入，差別在於由誰決定成員：

```ts import.meta.vitest name="best-practices/design: group entry or composing plugin"
import { Effect, Option, Schema, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

const notes = Plugin.make({ name: "app/notes", apply: () => Effect.void })
const storage = Plugin.make({
	name: "app/storage",
	config: Schema.Struct({ file: Schema.String }),
	apply: () => Effect.void,
})

const tenant = Plugin.make({
	name: "app/tenant",
	config: Schema.Struct({ file: Schema.String }),
	apply: (config) =>
		Effect.gen(function* () {
			yield* Graft.plugin(notes)
			yield* Graft.plugin(storage, config)
		}),
})

const trees = await Effect.runPromise(
	Effect.gen(function* () {
		yield* (yield* Graft.plugin(tenant, { file: "acorn.json" })).stable
		return yield* Stream.runHead(Graft.forks)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
trees // => Option.some([{ id: 1, name: "app/tenant", input: { file: "acorn.json" }, state: Fork.ForkState.Active(), children: [{ id: 2, name: "app/notes", input: undefined, state: Fork.ForkState.Active(), children: [] }, { id: 3, name: "app/storage", input: { file: "acorn.json" }, state: Fork.ForkState.Active(), children: [] }] }])
```

```yaml title="graft.yml"
- id: acorn
  name: acorn
  group: true
  isolate:
    "@acme/graft-plugin-notes/NoteStore": true
  config:
    - name: "@acme/graft-plugin-notes"
    - name: "@acme/graft-plugin-storage"
      config:
        file: acorn.json
```

|                        | 組合外掛                                                 | 群組項目                                                        |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| 成員由誰決定           | 外掛作者，在 `apply` 中                                  | 維運人員，在 `graft.yml` 中                                     |
| 變更其中一個成員       | 新設定會重新啟動父外掛和每個子外掛，除非有更新函式套用它 | [只有該項目](../../config-file/#執行期間的變更)會更新或重新載入 |
| `isolate`、`intercept` | `Graft.plugin` 的選項，由設定計算而來                    | 設定項目的欄位                                                  |
| 適用情況               | 成員固定：每個租戶都執行這兩個外掛                       | 成員依部署而不同                                                |

## 設定該放在哪裡

依照誰設定這個值、它存活多久來決定：

| 設定                                            | 由誰設定       | 存活期間 | 放在                                                                                       |
| ----------------------------------------------- | -------------- | -------- | ------------------------------------------------------------------------------------------ |
| 單一外掛的值：連接埠、字詞清單、API 金鑰        | 維運人員       | 設定項目 | 設定欄位。機密使用 [`Schema.RedactedFromValue`](../../config-file/#型別與機密) 和 `!env`。 |
| 每個外掛都可能使用的能力：檔案系統、HTTP 用戶端 | 宿主的作者     | 行程     | 在建構 `Graft.layer` 處提供的環境服務。                                                    |
| 共用服務依呼叫端讀取的值：方案、日誌註解        | 載入該子樹的人 | 子樹     | `Context.Reference` 上的 intercept。                                                       |
| 獨立的服務實例或處理函式：每個租戶一份          | 載入該子樹的人 | 子樹     | 領域，使用 `isolate`。                                                                     |

| 常見錯誤                            | 規則                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 在每次呼叫中傳遞租戶 ID             | 在子樹上 intercept 一次 Reference，在需要的地方讀取。                                                                             |
| 在建構服務時讀取 Reference          | `apply` 使用發布者的 context 執行。請在方法的 Effect 內讀取，它[使用呼叫端的 context](../../intercepts/#隨呼叫端變化的設定)執行。 |
| 從 `graft.yml` 設定自己的 Reference | 先在宿主中註冊它；[`graft start` 只註冊了兩個](../../intercepts/#設定檔-intercept)。                                              |
| 以為領域會遮蔽環境服務              | 領域隔離的是已發布的服務和事件；[消費者會退回使用環境](../../isolation/#環境後備與繼承)。                                         |
| 維運人員必須重新設定的環境服務      | 改為由外掛發布服務。環境會一直存活到宿主停止。                                                                                    |

## 在共用模組中宣告識別物件

把每個跨越外掛邊界的服務鍵、事件識別物件、Reference 和 tagged
error，放在發布者與其消費者都會匯入的模組中：

```ts title="tokens.ts"
import { Context, Schema, type Effect, type Option } from "effect"

import { Event } from "@graftland/graft"

export class ForecastUnavailable extends Schema.TaggedError<
	ForecastUnavailable,
	{ readonly brand: unique symbol }
>()("ForecastUnavailable", { city: Schema.String }) {}

export class Forecasts extends Context.Service<
	Forecasts,
	{
		readonly today: (
			city: string,
		) => Effect.Effect<Option.Option<string>, ForecastUnavailable>
	}
>()("@acme/graft-plugin-weather/Forecasts") {}

export const ForecastIssued = Event.make<[city: string, forecast: string]>(
	"@acme/graft-plugin-weather/ForecastIssued",
)
```

| 規則                     | 原因                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 鍵字串以套件名稱為範圍   | 字串就是鍵的身分：字串相同的兩個鍵就是同一個鍵。`graft.yml` 也是用它在 [`inject`、`isolate` 和 `intercept`](../../config-file/#規則) 中指稱這個鍵。 |
| 實作不放在這個模組裡     | 這樣消費者只相依於契約。發布者可以被[取代](../../replace/)或[移到另一個行程](../../remote/overview/)，而不必改動消費者。                            |
| 把預期的失敗寫進方法型別 | 呼叫端能看到必須處理哪些錯誤，Remote 契約也能傳遞它們。                                                                                             |
| 只定義值                 | 與任何[外掛模組](../../plugins/#外掛模組)一樣，匯入此模組不得執行任何 I/O。                                                                         |

要把識別物件和外掛發布為 npm 套件，請參閱[外掛套件](../packaging/)。

## 範例：聊天機器人

[`chat-bot` 範例](https://github.com/graftland/graft/tree/main/samples/chat-bot)
提供 `/roll`、`/weather <city>`、列出已載入命令的
`/help`，以及一個字詞清單可編輯的審核過濾器：

| 部分             | 做成                                              | 原因                                                                   |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| 收到的訊息       | 中介軟體事件 `Inbound`，以 `Event.waterfall` 執行 | 過濾器可以在任何命令看到訊息之前包裹、修改或攔下它。                   |
| 命令             | 事件 `Command`，以 `Event.bail` 回應              | 第一個認得該名稱的命令負責回應。                                       |
| 說明文字         | 事件 `Describe`，以 `Event.parallel` 收集         | 每個命令各自貢獻一行，因此 `/help` 永遠不會過時。                      |
| 審核             | 一個帶有 `Inbound` 處理函式和更新函式的外掛       | 新的字詞清單會原地套用；無效的清單只會讓審核失敗。                     |
| 天氣用戶端       | 一個發布 `Forecasts` 的外掛，以 Remote 執行       | 它擁有一條連線，其 SDK 崩潰時只會拖垮自己的行程。                      |
| `/weather`       | 一個帶有 `inject: [Forecasts]` 的外掛             | 只在用戶端存在時執行，在用戶端之前停止，並捕捉 `ForecastUnavailable`。 |
| `/roll`、`/help` | 各自一個外掛                                      | 各自單獨啟用和停用。                                                   |

另外兩個範例套用了同樣的問題：

| 範例                                                                                | 展示                                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`market-feed`](https://github.com/graftland/graft/tree/main/samples/market-feed)   | 由服務串成的管線。消費者在 `Pending` 中等待，讀取端失敗時整條鏈被撤回，再由 `retry` 排程重建。    |
| [`saas-tenants`](https://github.com/graftland/graft/tree/main/samples/saas-tenants) | 每個租戶一個組合外掛，每個租戶的儲存各有一個領域，另有一個共用的配額服務讀取被 intercept 的方案。 |

## 設計審查

下列規則全部成立時，設計就完成了：

- 每個部分都對應到外掛、服務、事件、領域、intercept、環境服務或設定欄位。
- 每份狀態都只有一個擁有它的 fork。其他部分透過服務或事件存取它。
- 每個資源都有 scope，每個背景 fiber 都使用 `Plugin.fork`。
- 外掛之間的每次互動都是一個識別物件，帶有以套件為範圍的鍵，放在共用模組中。沒有程式碼維護註冊表、檢查某個部分是否存在或安排啟動順序。
- 每個預期的失敗都有負責復原的地方。其他失敗則讓所屬 fork 失敗，在重試有幫助時搭配
  `retry` 排程。
- 每項設定都是設定欄位、環境服務、intercept 或領域，依誰設定它、它存活多久來選擇。
- 每個外掛都是一個生命週期：它的各個部分一起變動、一起失敗、一起重新啟動。
