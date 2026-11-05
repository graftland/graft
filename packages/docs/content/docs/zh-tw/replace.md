---
title: 取代外掛
description: 在一次交易中把外掛換成新版本。
---

`Graft.replace`
把外掛換成新版本。舊外掛的每個 fork 都會使用新版本重新啟動，之後再載入舊外掛，也會載入新版本：

```ts import.meta.vitest name="replace: swap a plugin for a new version"
import { Array, Effect, Option, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const greeterV1 = Plugin.make({ name: "greeter v1", apply: () => Effect.void })
const greeterV2 = Plugin.make({ name: "greeter v2", apply: () => Effect.void })

const names = await Effect.runPromise(
	Effect.gen(function* () {
		const running = yield* Graft.plugin(greeterV1)
		yield* running.await
		yield* Graft.replace([[greeterV1, greeterV2]])
		const later = yield* Graft.plugin(greeterV1)
		yield* later.await
		// Wait until the running fork has restarted as well.
		return yield* Graft.forks.pipe(
			Stream.map(Array.map((fork) => fork.name)),
			Stream.filter(Array.every((name) => name === "greeter v2")),
			Stream.runHead,
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

names // => Option.some(["greeter v2", "greeter v2"])
```

## 型別規則

TypeScript 會逐對獨立檢查：

| 目標外掛的部分 | 必須                                                      |
| -------------- | --------------------------------------------------------- |
| 輸入型別       | 與來源完全相同。                                          |
| 錯誤           | 是來源錯誤上界的子集，上界包含解碼失敗（`SchemaError`）。 |

這讓既有的 fork 控制代碼在取代後仍然有效。定義的輸入與錯誤契約是不變的：無法透過把同一個物件指派給更寬的錯誤型別或更窄的輸入型別來繞過檢查。需要的錯誤聯集應在建立外掛時宣告，再載入外掛。

:::caution

動態載入的模組使用參數為 `any` 的
`Plugin`。這個邊界刻意移除了靜態契約，HMR 和 loader 仍可使用。在這裡，取代的相容性**不會**在執行階段檢查。明確改成
`any` 或使用型別斷言，同樣可以繞過 TypeScript 的保證。

:::

## 外掛身分

外掛的身分由定義物件的參照決定，不由名稱或欄位決定。

- 同一個物件就是同一個外掛。
- `{ ...plugin }` 會建立不同的外掛。取代一個副本不會影響其他副本或原物件。
- 載入、alias 查找和衝突檢查都遵循這個規則，凍結的物件和自訂了 `Equal` 或 `Hash`
  的定義也不例外。Graft 不會修改呼叫端所擁有物件上的這些實作。

## 交易

Graft 在一次交易中套用所有配對，因此任何 fork 都不會看到只完成一部分的取代。接著，每個受影響的 fork 依照正常的[服務撤回順序](../services/#服務撤回流程)停止並重新啟動。[熱重載](../hot-reload/)使用的就是
`replace`。

## 衝突

有些批次無法用執行階段的 alias 表達，會以 `Graft.ReplacementConflict` 失敗，其
`indices` 欄位列出衝突的配對。

| 衝突的批次                                   | 範例           |
| -------------------------------------------- | -------------- |
| 同一個來源對應不同目標                       | `P → Q, P → R` |
| 重疊的變更                                   | `P → Q, Q → R` |
| 會使現有 fork 停留在其他外掛上的過期來源身分 | —              |

失敗時，交易不會修改 alias 或 fork。以下兩種情況仍然支援：讓多個來源指向同一個未變更的目標，以及還原到舊版本。
