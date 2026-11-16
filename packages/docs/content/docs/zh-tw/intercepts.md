---
title: Intercept
description: 為某個掛載及其下所有掛載調整一個 Context.Reference。
---

**intercept** 為某個掛載改變一個 `Context.Reference`
的值。該掛載及其下的 Layer 和子掛載讀到調整後的值，應用程式的其餘部分保持原值。

## 攔截一個 Reference

```ts import.meta.vitest name="intercepts: adjust a reference"
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Greeting extends Context.Service<Greeting, string>()("app/Greeting") {}

const Prefix = Context.Reference<string>("app/Prefix", {
	defaultValue: () => "Hello",
})

const greeting = Layer.effect(
	Greeting,
	Effect.map(Prefix, (prefix) => `${prefix}, world`),
)

const text = await Effect.runPromise(
	Effect.gen(function* () {
		const mount = yield* Graft.mount(greeting, {
			name: "greeting",
			requires: [Prefix],
			intercept: [Graft.intercept(Prefix, (prefix) => `${prefix}!`)],
		})
		yield* mount.await
		return yield* Graft.await(Greeting)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
text // => "Hello!, world"
```

`Graft.intercept`
接收 Reference 和一個把外層值變成新值的函式。同一個 Reference 的多個 intercept 由內向外套用：清單裡靠後的那個看到的是前面幾個的結果。

## 攔截到達哪裡

| 到達                             | 不到達                 |
| -------------------------------- | ---------------------- |
| 掛載自身的建置                   | 兄弟掛載               |
| 它的背景 fiber                   | 它的父掛載             |
| 每個子掛載及其子掛載             | 另一個領域裡發布的服務 |
| 透過 `requires` 讀取的 Reference | 非 Reference 的服務    |

intercept 隨建立掛載時的上下文傳遞，所以子掛載在繼承來的值之上疊加自己的 intercept。

## 解析順序

對於 `requires` 裡的 Reference，值按以下順序解析：

1. 掛載所在領域裡發布的值。
2. 繼承來的 Reference 值，包括 intercept。
3. Reference 的預設值。

Reference 總有後備值，所以它不會讓掛載停在
`Pending`。發布仍然優先，該值出現或消失時掛載重建。直接讀取值的方式見[服務可用性](../availability/)。

## 何時使用 intercept

| 用 intercept 來……                | 用發布來……               |
| -------------------------------- | ------------------------ |
| 給一個子樹不同的設定             | 改變整個應用程式的值     |
| 為某個租戶收窄逾時或功能旗標     | 從檔案讀取設定           |
| 調整程式庫已經在讀取的 Reference | 提供一個原本不存在的服務 |

如果目標是一個獨立的提供者而不是不同的 Reference 值，用[隔離](../isolation/)。
