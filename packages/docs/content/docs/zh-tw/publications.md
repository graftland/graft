---
title: 發布
description: 從 Layer 外部把一個值放進圖裡，並在執行期間替換它。
---

`Graft.publish`
把一個值放在某個服務鍵下，放進圖裡。所有需要這個鍵的掛載都會帶著它建置，並在它變化時重建。

## 發布一個值

```ts import.meta.vitest name="publications: a published value reaches a layer"
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}
class Report extends Context.Service<Report, { region: string }>()(
	"app/Report",
) {}

const report = Layer.effect(
	Report,
	Effect.map(Region, (region) => ({ region })),
)

const region = await Effect.runPromise(
	Effect.gen(function* () {
		const publication = yield* Graft.publish(Region, "eu")
		yield* publication.await
		const mount = yield* Graft.mount(report, { requires: [Region] })
		yield* mount.await
		const value = yield* Graft.await(Report)
		yield* publication.set("us")
		return value.region
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
region // => "eu"
```

發布屬於建立它的那個 scope。關閉 scope 會撤回值；需要它的掛載變成
`Pending`，如果相依項目是可選的，就重建為不含該值。

`Graft.publish`
回傳控制代碼時，值還沒有真正發布：supervisor 會非同步套用它。在立刻相依這個值之前，先
`yield* publication.await`（或 `publication.stable`）。

## 在掛載內部發布

在掛載內部呼叫 `Graft.publish`——無論是在 Layer 的建置裡，還是在 `Graft.fork`
的 fiber 裡——這次發布也歸那個掛載所有。

- 掛載被拆除時，發布隨之撤回。
- 掛載已經開始拆除後再發布，會以 defect 終止。

發布仍然屬於建立它的 scope，所以它也會隨那個 scope 結束。

## 替換值

`Publication` 在[掛載控制代碼](../mounting/#持有掛載)的基礎上增加 `set`：

| 成員      | 行為                                                                 |
| --------- | -------------------------------------------------------------------- |
| `set`     | 替換值，並重建所有需要它的掛載。                                     |
| `state`   | 相依方重建期間回到 `Loading`，之後是 `Active`。                      |
| `await`   | 等到發布穩定；`Failed` 狀態以它的 `Cause` 失敗，即使設定了 `retry`。 |
| `unmount` | 撤回值，並從掛載樹中移除這次發布。                                   |

`set`
在變化被接受時完成，而不是等重建結束。快速連續呼叫它可能跳過中間值；最後一個被接受的值生效。

## 規則

| 規則       | 說明                                                                           |
| ---------- | ------------------------------------------------------------------------------ |
| **身分**   | 一次發布在其領域裡擁有這個鍵，直到它被卸載。                                   |
| **唯一性** | 同一領域裡，一個鍵只能由一個發布或一個掛載提供。                               |
| **衝突**   | 因為鍵已被佔用而被拒絕的值，會讓這次發布的 `await` 以 `ServiceConflict` 失敗。 |
| **環境**   | 發布的值存在期間，會遮住環境中同名的鍵。                                       |
| **順序**   | 發布和撤回與相依檢查共用一筆交易。                                             |

發布一個會重建它自己提供者的值，也會被同樣拒絕；見[發布環](../isolation/#發布環)。

## 檔案與設定

設定檔就是一個值的清單，所以在建立發布的地方讀取檔案，然後逐一發布：

```ts
import { Context, Effect } from "effect"

import { Graft } from "@graftland/graft"

class AppConfig extends Context.Service<AppConfig, { region: string }>()(
	"app/Config",
) {}

declare const readConfig: Effect.Effect<{ region: string }>

export const program = Effect.gen(function* () {
	const config = yield* readConfig
	const publication = yield* Graft.publish(AppConfig, config)
	yield* publication.await
})
```

用 `publication.set` 修改值。每個需要 `AppConfig`
的掛載都會帶著新值重建，所以設定變化無需重新啟動程式即可生效。
