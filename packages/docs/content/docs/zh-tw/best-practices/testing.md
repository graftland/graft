---
title: 測試
description:
  使用 @effect/vitest 測試外掛和整個應用程式，不必 sleep，測試之間也不共用狀態。
---

Graft 的測試是一個 Effect，由 `@effect/vitest` 在專屬的 runtime 上執行。它用
`Graft.plugin`
載入外掛、等待明確的訊號，再檢查發生了什麼，包括外掛停止之後的情況。

## 建立測試

範例測試的是 `welcome`，一個啟動時寄出一封郵件的外掛：

```ts title="welcome.ts"
import { Context, Effect, Schedule, Schema } from "effect"

import { Plugin } from "@graftland/graft"

export class MailRejected extends Schema.TaggedError<
	MailRejected,
	{ readonly brand: unique symbol }
>()("MailRejected", { to: Schema.String }) {}

export class Mailer extends Context.Service<
	Mailer,
	{ readonly send: (to: string) => Effect.Effect<void, MailRejected> }
>()("app/Mailer") {}

export const welcome = Plugin.make({
	name: "app/welcome",
	config: Schema.Struct({ to: Schema.String }),
	inject: [Mailer],
	retry: Schedule.spaced("1 second"),
	apply: ({ to }) =>
		Effect.gen(function* () {
			const mailer = yield* Mailer
			yield* mailer.send(to)
		}),
})
```

每個測試都經過 `run`，由它為測試提供專屬的 runtime：

```ts title="run.ts"
import { Effect, Layer, type Scope } from "effect"

import { Graft } from "@graftland/graft"

export const run = <A, E>(
	effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))
```

測試提供外掛所需的服務、載入外掛，再檢查發生了什麼：

```ts
import { Array, Effect, Ref } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { run } from "./run.ts"
import { Mailer, welcome } from "./welcome.ts"

it.effect("sends one mail on start", () =>
	Effect.gen(function* () {
		const outbox = yield* Ref.make<ReadonlyArray<string>>([])
		yield* Graft.provide(Mailer, {
			send: (to) => Ref.update(outbox, Array.append(to)),
		})
		const fork = yield* Graft.plugin(welcome, { to: "alice@example.com" })
		yield* fork.await
		const sent = yield* Ref.get(outbox)
		assert.deepStrictEqual(sent, ["alice@example.com"])
	}).pipe(run),
)
```

| 部分                                       | 原因                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `Layer.fresh(Graft.layer)`                 | 即使 Layer 會被 memoize，也照樣建立新的 runtime，因此服務、fork ID 和日誌不會從一個測試洩漏到另一個測試。                    |
| `Effect.scoped`                            | 卸載測試載入的所有外掛。清理失敗會以 defect 拋出，使測試失敗。                                                               |
| `it.effect`                                | 在 `TestClock` 上執行：只有測試推進時，時間才會前進。請參閱[控制時間](#控制時間)。                                           |
| `it.live`                                  | 使用真實時鐘，適用於真實的伺服器、子行程和 worker。                                                                          |
| [環境服務](../../services/#來自環境的服務) | `Layer.provideMerge(Layer.fresh(Graft.layer), NodeServices.layer)`。測試本體也看得到它們，而且它們不會讓外掛停在 `Pending`。 |
| 測試資料                                   | 在測試內建立 `Ref`、`Deferred` 和假服務。定義在模組層級的會被所有測試共用。                                                  |

這裡的 `Mailer` 是一個**假服務**（fake）：它把呼叫記錄在 `Ref`
中，失敗時回傳真實服務宣告的有型別錯誤，例如 `MailRejected.make({ to })`。

| 發布假服務的方式                                         | 適用時機                                     |
| -------------------------------------------------------- | -------------------------------------------- |
| 在測試本體中使用 `Graft.provide`                         | 整個測試期間都存在，runtime 關閉時撤回。     |
| `Plugin.service(Mailer, Effect.succeed(fake), { name })` | 測試要卸載或取代它，以觀察消費者停止並等待。 |
| 環境                                                     | 真實服務也來自環境。                         |

## 等待狀態

下面的輔助函式會等待 fork 第一次到達指定的[狀態](../../lifecycle/#fork-狀態)。其他等待方式請參閱
[`await`、`stable` 和 `state`](../../fork-handle/#awaitstable-和-state)。

```ts title="reach.ts"
import { Effect, Stream } from "effect"

import type { Fork } from "@graftland/graft"

export const reach = (fork: Fork.Fork, tag: Fork.ForkState["_tag"]) =>
	fork.state.pipe(
		Stream.filter((state) => state._tag === tag),
		Stream.runHead,
		Effect.flatMap((state) => Effect.fromOption(state)),
	)
```

| 常見陷阱                                                                           | 正確做法                                                          |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 以為 `fork.await` 之後就是 `Active`。它在 `Pending` 時也會回傳，即使提供者剛載入。 | 斷言狀態，或使用 `reach(fork, "Active")`。                        |
| 用 sleep 或反覆呼叫 `Effect.yieldNow`，等待某件事發生。                            | 等待某個狀態、[`Deferred`](#用-deferred-協調) 或 `loader.ready`。 |
| 提供者 `dispose` 之後，立刻斷言消費者處於 `Pending`。                              | `dispose` 在消費者停止時就回傳。請使用 `reach(fork, "Pending")`。 |

## 斷言失敗

回傳有型別錯誤的假服務會讓 `welcome` 失敗。

| 要檢查的內容                 | 做法                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| 有型別的錯誤                 | `Effect.flip(fork.await)`。defect 不會被翻轉，而是直接讓測試失敗。                  |
| defect，或同時發生的多個失敗 | `Effect.exit(fork.await)`，再讀取 `Cause`。                                         |
| fork 保留的失敗              | `reach(fork, "Failed")`，再讀取它的 `cause`。                                       |
| 無法解碼的設定               | `Effect.flip(fork.await)` 會得到 `SchemaError`。                                    |
| 卸載時發生的失敗             | `Effect.flip(fork.dispose)` 會得到 `Fork.CleanupError`；它的 `cause` 保留原始失敗。 |

## 記錄發生的事

**紀錄簿**（journal）是一個
`Ref`，外掛把事件追加到其中。要檢查停止時做了什麼，就關閉一個內層 scope，在它之後斷言；此時 runtime 仍然開啟：

```ts
import { Array, Effect, Ref, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { run } from "./run.ts"

it.effect("restarts on a new config", () =>
	Effect.gen(function* () {
		const journal = yield* Ref.make<ReadonlyArray<string>>([])
		const record = (event: string) => Ref.update(journal, Array.append(event))
		const echo = Plugin.make({
			name: "app/echo",
			config: Schema.Struct({ text: Schema.String }),
			apply: ({ text }) =>
				Effect.acquireRelease(record(`start ${text}`), () =>
					record(`stop ${text}`),
				),
		})
		yield* Effect.scoped(
			Effect.gen(function* () {
				const fork = yield* Graft.plugin(echo, { text: "a" })
				yield* fork.await
				yield* fork.update({ text: "b" })
				yield* fork.await
			}),
		)
		const entries = yield* Ref.get(journal)
		assert.deepStrictEqual(entries, ["start a", "stop a", "start b", "stop b"])
	}).pipe(run),
)
```

- `fork.update` 和 `fork.restart`
  不會等待[重新啟動](../../fork-handle/#update-和-restart)完成。下一次
  `fork.await` 會等待新的 activation。
- [原地更新](../../plugins/#原地更新)的外掛接受變更時，不會記錄停止和啟動。要斷言的正是這個差異。
- 有多個外掛時，先等待前一個再載入下一個，否則啟動順序不固定。停止順序遵循[歸屬與停止順序](../../lifecycle/#歸屬與停止順序)。

## 控制時間

`it.effect` 會安裝 `effect/testing` 中的 `TestClock`。`TestClock.adjust`
會立即執行計時器和重試排程：

```ts
import { Effect, Ref } from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { reach } from "./reach.ts"
import { run } from "./run.ts"
import { Mailer, MailRejected, welcome } from "./welcome.ts"

it.effect("retries until the mail goes out", () =>
	Effect.gen(function* () {
		const attempts = yield* Ref.make(0)
		yield* Graft.provide(Mailer, {
			send: (to) =>
				Effect.flatMap(
					Ref.updateAndGet(attempts, (n) => n + 1),
					(n) => (n < 3 ? MailRejected.make({ to }) : Effect.void),
				),
		})
		const fork = yield* Graft.plugin(welcome, { to: "alice@example.com" })
		const error = yield* Effect.flip(fork.await)
		assert.strictEqual(error._tag, "MailRejected")
		yield* TestClock.adjust("2 seconds")
		yield* reach(fork, "Active")
		const count = yield* Ref.get(attempts)
		assert.strictEqual(count, 3)
	}).pipe(run),
)
```

- 推進時鐘之前，先讓程式碼執行到開始 sleep 的地方；這裡是第一次失敗。推進之後才開始的 sleep 會從新的時間起算。
- 一次 `adjust` 會依序執行所有到期的 sleep，包括被喚醒的 fiber 新開始的 sleep。
- 出現警告
  `A test is using time, but is not advancing the test clock`，表示程式碼正在等待時鐘。請推進時鐘，或在涉及真實 I/O 時改用
  `it.live`。

## 用 Deferred 協調

要讓外掛停在某個點上，就給它兩個
`Deferred`：一個用來發出訊號，另一個用來等待。外掛在閘門前等待時，測試可以檢查、更新、重新啟動或卸載它，也可以撤回它使用的服務：

```ts
import { Deferred, Effect, Option, Stream } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { reach } from "./reach.ts"
import { run } from "./run.ts"
import { Mailer, welcome } from "./welcome.ts"

it.effect("is Loading while the mail is sent", () =>
	Effect.gen(function* () {
		const sending = yield* Deferred.make<void>()
		const gate = yield* Deferred.make<void>()
		const signal = Deferred.succeed(sending, undefined)
		yield* Graft.provide(Mailer, {
			send: () => Effect.andThen(signal, Deferred.await(gate)),
		})
		const fork = yield* Graft.plugin(welcome, { to: "alice@example.com" })
		yield* Deferred.await(sending)
		const current = yield* Stream.runHead(fork.state)
		assert.strictEqual(Option.getOrThrow(current)._tag, "Loading")
		yield* Deferred.succeed(gate, undefined)
		yield* reach(fork, "Active")
	}).pipe(run),
)
```

## 收集日誌

`Graft.logs`
會先重播最近的日誌項目，之後保持開啟。先記錄一個標記，再讀到該標記為止：

```ts import.meta.vitest name="testing: collect logs"
import { Array, Effect, Equal, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { run } from "./run.ts"

const messages = Effect.gen(function* () {
	yield* Effect.log("end of log")
	const entries = yield* Stream.runCollect(
		Stream.takeUntil(Graft.logs, (entry) =>
			Equal.equals(entry.message, ["end of log"]),
		),
	)
	return Array.map(Array.dropRight(entries, 1), (entry) => entry.message)
})

const greeter = Plugin.make({
	name: "app/greeter",
	apply: () => Effect.log("hello"),
})

await Effect.runPromise(
	run(
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(greeter)
			yield* fork.await
			return yield* messages
		}),
	),
) // => [["hello"]]
```

| 規則     | 細節                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| 歷史     | 新訂閱者只會取得[最近的項目](../../lifecycle/#日誌)。在較長的測試中，請針對過濾後的日誌行斷言。                        |
| 外掛失敗 | 以 `Error` 層級記錄，完整的 `Cause` 放在 `cause` 中。訊息列於 [Graft 記錄的內容](../observability/#graft-記錄的內容)。 |
| 並行     | 並行外掛的日誌行會交錯。請依單一外掛的 `graft.plugin` 註解過濾，或斷言某個序列依序出現。                               |

## 測試設定項目

`Loader.plugin` 執行保存在記憶體中的設定項目，`ModuleResolver.fromRecord`
把項目的名稱對應到外掛，因此完全不需要檔案：

```ts
import { Deferred, Effect } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"

import { run } from "./run.ts"
import { Mailer, welcome } from "./welcome.ts"

const resolver = ModuleResolver.fromRecord({ welcome })

it.effect("loads welcome from an entry", () =>
	Effect.gen(function* () {
		const sent = yield* Deferred.make<string>()
		yield* Graft.provide(Mailer, {
			send: (to) => Effect.asVoid(Deferred.succeed(sent, to)),
		})
		yield* Graft.plugin(Loader.plugin, [
			{ id: "welcome", name: "welcome", config: { to: "alice@example.com" } },
		])
		const to = yield* Deferred.await(sent)
		assert.strictEqual(to, "alice@example.com")
	}).pipe(run, Effect.provide(resolver)),
)
```

| 規則      | 細節                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 名稱      | `fromRecord` 依項目的 `name` 精確查找，不套用[命名慣例](../../config-file/#外掛名稱)。找不到名稱時以 `ModuleNotFound` 失敗。                            |
| `Loader`  | 這個服務發布在註冊表中，而不是環境中。要編輯設定項目或呼叫 `loader.ready`，請在一個探測用的外掛中注入 `Loader.Loader`，再透過 `Deferred` 把它交給測試。 |
| 等待      | 編輯在儲存後就回傳，此時外掛尚未變更。斷言前先呼叫 `loader.ready`；請參閱[編輯提供的保證](../../loader-api/#編輯提供的保證)。                           |
| `!env`    | 在檔案中會寫 `!env` 的位置改寫 `new Entry.Env({ name })`，並用 `ConfigProvider.fromEnvRecord` 提供變數。                                                |
| YAML 檔案 | 把 `graft.yml` 寫入 `fs.makeTempDirectoryScoped()` 建立的目錄，載入 `Include.Include`，並在環境中加入 `NodeServices.layer`。                            |

## 測試遠端外掛

[遠端外掛](../../remote/overview/)的實作就是一般的外掛：像上面一樣在行程內測試即可。[06 · Remote](https://github.com/graftland/graft/tree/main/samples/06-remote/test)
範例的測試跨越了邊界：`globalSetup` 先把它建置成供 Node 匯入的 JavaScript，再由
`it.live` 測試在 `local` 和 `worker` 上執行它。
