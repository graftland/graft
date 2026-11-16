---
title: 隔離
description: 給一個掛載自己的服務，或在多個掛載之間共用一套服務。
---

**領域（realm）**是服務解析時所在的命名空間。預設情況下，所有掛載共用一個領域。`isolate`
給一個掛載換一個領域。

## 給掛載自己的領域

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Database extends Context.Service<Database, string>()("app/Database") {}
class Tenant extends Context.Service<Tenant, string>()("app/Tenant") {}

const tenant = Layer.effect(
	Tenant,
	Effect.gen(function* () {
		const database = yield* Database
		return `tenant on ${database}`
	}),
)

export const program = Effect.gen(function* () {
	yield* Graft.mount(Layer.effect(Database, Effect.succeed("dedicated")), {
		name: "database",
		isolate: [Database],
	})
	yield* Graft.mount(tenant, { name: "tenant", requires: [Database] })
})
```

`isolate: [Database]` 給這個掛載一個專屬於 `Database`
的私有領域。它的子掛載繼承這層對應：它們在同一個私有領域裡查找
`Database`，所以看到的是這個專屬值。

| 選項形式                      | 領域                                                 |
| ----------------------------- | ---------------------------------------------------- |
| 不傳                          | 共用的根領域。                                       |
| `isolate: [Database]`         | 這個掛載的私有領域。                                 |
| `isolate: [[Database, "eu"]]` | 標籤為 `eu` 的共用領域；所有使用該標籤的掛載共用它。 |

標籤讓多個掛載共用一套服務。私有領域和根領域都無法透過標籤存取。

## 隔離涵蓋什麼

| 規則       | 說明                                                          |
| ---------- | ------------------------------------------------------------- |
| 按鍵隔離   | 每個鍵單獨隔離。一個掛載可以隔離 `Database`，其他一切都共用。 |
| 繼承       | 子掛載從建立它的位置繼承領域。                                |
| 提供者唯一 | 一個領域裡，一個鍵只由一個掛載或一次發布提供。                |
| 查找       | 掛載先在自己的領域裡找服務，再找 `Graft.layer` 的環境。       |
| 不繼承值   | 子掛載從不直接拿到父層的提供值；它在同一個領域裡自行解析。    |
| 環境       | 來自環境的服務在每個領域裡都可見。                            |

領域標籤和服務鍵是服務身分中相互獨立的部分，即使其中任一包含特殊字元也是如此。

## 發布環

發布一個值，可能直接或經由其他掛載重新啟動發布它的那個掛載。Graft 以
`Graft.ServiceConflict` 原子地拒絕這樣的發布，領域保持不變。

1. **找到觀察者**：目標領域裡把這個鍵當作可選相依、或透過環境後備值使用它的執行中掛載。
2. **跟隨**它們的子掛載，以及它們使用的每個提供者的消費者。
3. 如果發布者也在其中，**拒絕**這次發布。

| `reason`          | 情況                           |
| ----------------- | ------------------------------ |
| `SelfDependency`  | 掛載在觀察它自己正在發布的鍵。 |
| `DependencyCycle` | 環裡另一個掛載在觀察它。       |
| `Invalidated`     | 相依變化已經使這個掛載失效。   |

被拒絕的掛載等待它的規格、相依項目或造成阻塞的圖發生變化。它不會反覆重試進同一個環。見[失敗與重試](../failures-retry/#serviceconflict)。

## 隔離與 Intercept

| 工具        | 改變什麼                                       |
| ----------- | ---------------------------------------------- |
| `isolate`   | 服務在哪個領域解析，也就是掛載看到哪個提供者。 |
| `intercept` | 掛載及其子掛載看到的 `Context.Reference` 值。  |

用 `isolate` 把租戶隔開；用 [Intercept](../intercepts/)
調整逾時、功能旗標這類設定。
