---
title: 事件
description: 有型別的事件，處理函式歸註冊它的外掛所有。
---

事件是一個有型別的識別物件，型別規定了三件事：

- 派發時的引數。
- 每個處理函式的回傳值。
- 處理函式可能產生的錯誤。

```ts
import { Event } from "@graftland/graft"

// Handlers take a message and return nothing.
const Message = Event.make<[text: string]>("app/message")

// Handlers take a command and may answer it.
const Command = Event.make<[name: string], Option.Option<string>>("app/command")
```

## 處理事件

`Event.on` 註冊一個處理函式，在目前的 scope 關閉時移除。在 `apply`
內註冊時，它會一直保留到外掛停止：

```ts
const logger = Plugin.make({
	name: "logger",
	apply: () => Event.on(Message, (text) => Effect.log(text)),
})
```

### 選項

| 選項      | 作用                                       |
| --------- | ------------------------------------------ |
| `prepend` | 排在先前註冊的處理函式前面執行。           |
| `global`  | 接收來自所有領域的事件，並忽略派發過濾器。 |

### 處理函式的 context

處理函式使用註冊它的程式碼的 context，而不是派發事件的程式碼的 context。

- **能看到什麼。** 所屬外掛的服務、領域（realm）和 intercept。
- **每次呼叫的 scope。** 還原註冊 context 之後，Graft 會為每次呼叫安裝獨立的
  `Scope`。並行呼叫的 scope 互不影響。
- **scope 擁有什麼。** 處理函式取得的資源、scoped
  fiber 和子 fork 歸這次呼叫所有。Graft 在呼叫完成、取消清理結束後釋放它們。
- **存活更久的資源。** 請在 activation 的 `apply`
  中、註冊處理函式之前取得，再由處理函式的閉包引用。

### `Event.once`

`Event.once` 註冊一個最多執行一次的處理函式。

- Graft 會在它執行前將其移除，因此即使它再次派發同一個事件，也不會重複執行。
- 執行中的處理函式仍保有歸屬，直到執行及取消清理完成；隨後 Graft 釋放該註冊，無須等到 owner 的 scope 關閉。

## 派發事件

| 函式              | 呼叫處理函式的方式 | 結果                                            |
| ----------------- | ------------------ | ----------------------------------------------- |
| `Event.emit`      | 依序呼叫           | 遇到第一個失敗就停止。                          |
| `Event.parallel`  | 同時呼叫           | 收集所有結果，將所有失敗合併到一個 `Cause` 中。 |
| `Event.bail`      | 依序呼叫           | 回傳處理函式給出的第一個 `Some`。               |
| `Event.waterfall` | 依中介軟體鏈呼叫   | 回傳整條鏈的輸出。                              |

```ts
const status = Effect.gen(function* () {
	yield* Event.emit(Message, "Hello")
	const answer = yield* Event.bail(Command, "status")
	return Option.getOrElse(answer, () => "Nobody answered")
})
```

### 派發期間的移除與取消

| 情況                     | 結果                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| 派發過程中處理函式被移除 | 之後不會再被呼叫。                                                        |
| 處理函式所屬的外掛停止   | 中斷會使該處理函式被略過。                                                |
| 處理函式主動中斷或被取消 | 它完整的 `Cause` 會透過派發傳遞，清理產生的 defect 也一樣。               |
| 取消 `Event.parallel`    | 先等待所有呼叫清理完成，再將中斷與已經發生的失敗、defect 及清理失敗合併。 |

框架管理的 Scope 若在釋放時發生純中斷，會以 `ReleaseInterrupted`
defect 回報，原始中斷保存在它的 `cause`
中。這樣，釋放失敗經過巢狀事件或背景工作仍能傳到呼叫端；正常取消仍按中斷處理。

## 中介軟體

`Event.middleware` 定義一種事件，其處理函式可以逐層包裹。每個處理函式接收輸入和
`next`，可以：

- 修改輸入、
- 修改輸出，或
- 直接回應而不呼叫 `next`。

`waterfall` 使用 `last` 作為鏈的末端：

```ts
const Render = Event.middleware<string, string>("app/render")

const render = Effect.gen(function* () {
	yield* Event.on(Render, (input, next) =>
		Effect.map(next(input.trim()), (output) => `<p>${output}</p>`),
	)
	// "<p>HI</p>"
	return yield* Event.waterfall(Render, "  hi  ", (input) =>
		Effect.succeed(input.toUpperCase()),
	)
})
```

### 各部分在哪個 context 中執行

| 部分             | 執行時使用的 context                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| 已註冊的中介軟體 | 其註冊時的 context。                                                   |
| `last` 回呼      | 派發者的 context：`waterfall` 開始時擷取的服務、Reference 和日誌註解。 |

關於 `last`：

- 無論有沒有中介軟體，它都有全新的呼叫
  `Scope`，因此可以取得 scoped 資源，不需要派發者提供 scope。
- 它的資源在執行及取消清理結束後、控制權回到呼叫它的中介軟體之前關閉。
- 中介軟體在等待 `next` 及處理其結果期間，自身的資源仍然存活。
- 增加中介軟體或在 `next` 外提供值，都不會改變 `last` 的 context。
- 這只會還原 context，不會切換執行的 fiber，也不會使下游脫離取消關係。

### `next` 函式

每一步的 `next` 只會執行一次下游。

- 首次執行選擇輸入；之後的執行（包括並行執行）共用同一個成功、失敗或中斷結果。
- 如果處理函式被略過，鏈條會使用同一個 `next` 繼續。
- 處理函式所屬的外掛卸載後，已經執行過的下游不會重播。
- 如果首次下游執行被中斷，之後的呼叫會得到該中斷結果，不會重新開始。

## 領域與過濾器

事件和服務使用相同的[領域](../isolation/)機制。派發事件時，只有在該事件自己的領域內註冊的處理函式會被呼叫。將事件加入 fork 的
`isolate` 選項，就能為這部分外掛樹設定獨立的處理函式。

需要更細緻的控制時，可以用 `Event.filtered`
為派發加上過濾器。過濾器會收到每個處理函式註冊時的 context，因此可以檢查其中的任何服務或 Reference：

```ts
const formalOnly = Event.emit(Message, "Hello").pipe(
	Event.filtered((owner) => Context.get(owner, Formal)),
)
```

以 `global: true` 註冊的處理函式不受領域和過濾器限制。
