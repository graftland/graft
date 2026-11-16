---
title: 可觀測性
description: 跟隨掛載樹，並讀取 Graft 收集的日誌。
---

Graft 用兩條串流暴露圖：掛載樹和日誌。

## 掛載樹

`Graft.mounts`
在圖每次變化時送出整棵樹。每個節點帶有掛載的 ID、名稱、目前狀態和子節點。

```ts import.meta.vitest name="observability: read the mount tree"
import { Context, Effect, Layer, Option, Stream } from "effect"

import { Graft, Mount } from "@graftland/graft"

class Greeting extends Context.Service<Greeting, string>()("app/Greeting") {}

const greeting = Layer.effect(Greeting, Effect.succeed("hello"))

const tree = await Effect.runPromise(
	Effect.gen(function* () {
		const mount = yield* Graft.mount(greeting, { name: "greeting" })
		yield* mount.await
		return yield* Stream.runHead(Graft.mounts)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
tree // => Option.some([{ id: 1, name: "greeting", state: Mount.MountState.Active(), children: [] }])
```

| 欄位       | 用途                                  |
| ---------- | ------------------------------------- |
| `id`       | 在日誌和錯誤裡標識這個掛載。          |
| `name`     | `name` 選項；沒有設定時為 `"layer"`。 |
| `state`    | 與掛載控制代碼暴露的狀態相同。        |
| `children` | 在這個掛載的 Layer 裡建立的掛載。     |

把這棵樹送給狀態頁、健康檢查端點或偵錯日誌。一次重建會送出帶有新狀態的新樹。

## 日誌

`Graft.logs` 收集使用 `Graft.layer`
的環境裡的日誌，包括宿主應用程式和每個掛載的日誌。

| 行為     | 說明                                                           |
| -------- | -------------------------------------------------------------- |
| 重放     | 新的訂閱者先收到最近 1000 筆。                                 |
| 註解     | 掛載建置或執行期間寫的日誌帶有 `graft.mount` 和 `graft.name`。 |
| 宿主日誌 | 保留自己的註解；掛載相關的註解可能不存在。                     |
| 層級     | 層級、訊息、`Cause` 和註解都完整保留。                         |

```ts
import { Effect, Stream } from "effect"

import { Graft } from "@graftland/graft"

export const recent = Graft.logs.pipe(
	Stream.map((entry) => ({
		level: entry.level,
		message: entry.message,
		mount: entry.annotations["graft.mount"],
	})),
)
```

只取需要的部分，避免永遠訂閱下去：

```ts
import { Effect, Stream } from "effect"

import { Graft } from "@graftland/graft"

export const errors = Stream.runCollect(
	Stream.filter(Graft.logs, (entry) => entry.level === "Error").pipe(
		Stream.take(10),
	),
).pipe(Effect.map((entries) => entries.length))
```

## 追蹤

每次建置和每個執行中的掛載都是一個名為 `graft.mount <name>`
的 span。這個 span 包住 Layer 的建置以及它做的工作，所以你自己的 span 出現在它下面。日誌註解使用同樣的名字，讓一次緩慢的建置和它的日誌在追蹤檢視器裡保持在一起。

## 該看什麼

| 症狀         | 到哪裡看                                        |
| ------------ | ----------------------------------------------- |
| 掛載從不啟動 | `state` 顯示 `Pending`，並列出缺少的鍵。        |
| 掛載反覆重建 | `state` 的變化，以及其間的日誌行。              |
| 掛載失敗     | `state` 顯示 `Failed`；在日誌裡讀它的 `cause`。 |
| 拆除很慢     | 關於消費者仍在等待的那則警告。                  |
