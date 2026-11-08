---
title: 健康探針
description: 為服務嘗試註冊檢查，並明確請求執行。
---

**探針**是在 `apply` 中透過 `Plugin.probe`
註冊的具名 Effect。註冊不會執行檢查。每次服務嘗試擁有自己的註冊及正在執行的檢查。

## 註冊和請求探針

```ts import.meta.vitest name="probes: request a check"
import { Effect, Ref } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const program = Effect.gen(function* () {
	const calls = yield* Ref.make(0)
	const plugin = Plugin.make({
		name: "app/integration",
		apply: () =>
			Plugin.probe(
				"upstream",
				Ref.update(calls, (n) => n + 1),
			),
	})
	const fork = yield* Graft.plugin(plugin)
	yield* fork.await
	yield* Ref.get(calls) // => 0
	yield* fork.probes // => ["upstream"]
	yield* fork.probe("upstream")
	yield* Ref.get(calls) // => 1
})
await Effect.runPromise(
	program.pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
```

| 規則       | 行為                                                                   |
| ---------- | ---------------------------------------------------------------------- |
| 歸屬       | 註冊持續到註冊時的 scope 關閉。重新啟動會註冊新的檢查。                |
| 隔離       | 不同 fork 可以使用相同名稱。同一次嘗試中重複註冊會失敗。               |
| 上下文     | 檢查使用註冊時擷取的服務。每次請求都有自己的 scope。                   |
| 失敗       | `Fork.ProbeError` 保留檢查的完整 cause。檢查失敗不會自動重新啟動外掛。 |
| 取消       | 關閉註冊 scope 會中斷正在執行的檢查。中斷請求會取消該次呼叫。          |
| 檢查不存在 | 請求未註冊的名稱會得到 reason 為 `Missing` 的 `ProbeError`。           |

## 遠端檢查

Remote 執行單元透過控制通道接受探針請求。描述實作不會執行 `apply`
或探針。開始服務會執行一般的
`apply`；就緒檢查等待外掛及其匯出的服務就緒。探針成功、服務就緒和行程確認退出是不同的事實。

`fork.probe`
存取嵌入式執行環境中該 fork 自己的註冊。Change 會在新代開始服務前、以及對復原的代，執行
`requirements.probes`
中列出的探針。探針失敗時 Change 中止或復原，並在結局中保留其 cause。參閱[變更](../transitions/#請求欄位)。
