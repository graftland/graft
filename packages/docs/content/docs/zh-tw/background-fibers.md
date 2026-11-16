---
title: 背景 fiber
description: 啟動歸掛載所有的工作，並讓它的失敗使掛載失敗。
---

Layer 常常啟動比建置活得更久的工作：輪詢、伺服器、訂閱者。`Graft.fork`
啟動這樣的 fiber，並給它一個歸屬。

## 在 Layer 裡 fork

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Events extends Context.Service<Events, string>()("app/Events") {}

export const events = Layer.effect(
	Events,
	Effect.gen(function* () {
		yield* Graft.fork(
			Effect.log("Subscribed").pipe(Effect.andThen(Effect.never)),
		)
		return "ready"
	}),
)
```

這個 fiber 屬於正在建置該 Layer 的掛載。掛載被拆除時它被中斷，它的失敗會使掛載失敗。

| 行為                   | 結果                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| 歸屬                   | 正在執行這個 Layer 的掛載。                                         |
| 拆除時                 | 等掛載的消費者釋放租約之後被中斷。                                  |
| 失敗時                 | 掛載帶著 fiber 完整的 `Cause` 變為 `Failed`，然後遵循它的 `retry`。 |
| 純中斷                 | 不會使掛載失敗。                                                    |
| 錯誤型別               | 透過 `Graft.Tasks<E>` 和 `Graft.BackgroundError` 帶到掛載上。       |
| 裸 `Effect.forkScoped` | 生命週期跟隨 scope，但失敗不會到達掛載。                            |

## 在 fiber 內處理錯誤

失敗的 fiber 會連累掛載，所以能在其中復原的錯誤就在其中捕捉：

```ts
import { Effect, Schedule } from "effect"

import { Graft } from "@graftland/graft"

export const poll = Graft.fork(
	Effect.log("Polling").pipe(
		Effect.andThen(Effect.never),
		Effect.retry(Schedule.exponential("1 second")),
	),
)
```

被 fork 的 fiber 的錯誤型別是 Layer 契約的一部分：Layer 裡 fork 了
`Effect<never, HttpError>` 的掛載可以以 `HttpError` 失敗，`mount.await`
會暴露它。見[失敗與重試](../failures-retry/)。

## 撤回之後

掛載被拆除時，先撤回它發布的服務，然後消費者釋放租約，只有這時才中斷背景 fiber。消費者的終結器仍然可以呼叫它正在使用的服務。

- 仍然健康執行的 fiber 在消費者排空期間繼續執行。
- 排空期間失敗的 fiber 把它的 `Cause` 加進掛載的失敗。
- 所有 fiber 都在掛載的 scope 關閉之前被中斷。

把失敗應當使掛載失敗的工作交給
`Graft.fork`。屬於更小 scope、失敗在別處回報的工作，用 `Effect.forkScoped`。
