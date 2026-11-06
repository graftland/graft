---
title: 取代外掛
description: 在一次交易中把外掛換成新版本，啟動失敗時回滾。
---

`Graft.replace`
把外掛換成新版本。舊外掛的每個 fork 都會使用新版本重新啟動，之後再載入舊外掛，也會載入新版本。取代或恢復穩定後它才回傳：

```ts import.meta.vitest name="replace: swap a plugin for a new version"
import { Array, Effect, Option, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const greeterV1 = Plugin.make({
	name: "app/greeterV1",
	apply: () => Effect.void,
})
const greeterV2 = Plugin.make({
	name: "app/greeterV2",
	apply: () => Effect.void,
})

const outcome = await Effect.runPromise(
	Effect.gen(function* () {
		const running = yield* Graft.plugin(greeterV1)
		yield* running.await
		const result = yield* Graft.replace([[greeterV1, greeterV2]])
		const later = yield* Graft.plugin(greeterV1)
		yield* later.await
		const tree = yield* Stream.runHead(Graft.forks)
		return [
			result._tag,
			Option.map(
				tree,
				Array.map((fork) => fork.name),
			),
		]
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

outcome // => ["Replaced", Option.some(["app/greeterV2", "app/greeterV2"])]
```

`Graft.replace`
會在更改別名或設定描述之前拒絕受管理 fork 及其祖先。`ManagedFork`
衝突和協調器結局見[執行轉換](../transitions/)。

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

## 回滾

如果執行替換外掛的某個 fork 啟動失敗，Graft 會回滾整批替換並恢復舊外掛。恢復穩定後，若計入的舊 fork 均未失敗，`replace`
回傳 `RolledBack`；否則回傳 `RecoveryFailed`。兩種結果的 `failures`
都記錄放棄替換的原因；`RecoveryFailed.recovery` 為每個恢復失敗的 fork 記錄一個
`Failed`，保留完整 `Cause`：

```ts import.meta.vitest name="replace: roll back a replacement that fails"
import { Array, Effect, Option, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

// The error bound admits the failures of later versions; see Type rules.
const greeterV1 = Plugin.make({
	name: "app/greeterV1",
	apply: (): Effect.Effect<void, string> => Effect.void,
})
const broken = Plugin.make({
	name: "app/greeterV2",
	apply: () => Effect.fail("no greeting"),
})

const outcome = await Effect.runPromise(
	Effect.gen(function* () {
		const running = yield* Graft.plugin(greeterV1)
		yield* running.await
		const result = yield* Graft.replace([[greeterV1, broken]])
		const failed =
			result._tag === "RolledBack"
				? Array.map(result.failures, (failure) => failure.plugin)
				: []
		const tree = yield* Stream.runHead(Graft.forks)
		return [
			failed,
			Option.map(
				tree,
				Array.map((fork) => fork.name),
			),
		]
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

outcome // => [["app/greeterV2"], Option.some(["app/greeterV1"])]
```

| 情形                                               | 結果                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| 執行替換外掛的每個 fork 都是 `Active` 或 `Pending` | `Replaced`。                                                      |
| 其中一個失敗，包括被替換的父外掛載入的子外掛       | 回滾，記錄 `Failed` 失敗及其完整 `Cause`。                        |
| 到 `timeout` 時仍有 fork 在啟動                    | 回滾，記錄 `TimedOut` 失敗。                                      |
| 計入的恢復 fork 都是 `Active` 或 `Pending`         | `RolledBack`，帶有替換的 `failures`。                             |
| 計入的恢復 fork 中有 `Failed`                      | `RecoveryFailed`，帶有替換的 `failures` 和恢復失敗的 `recovery`。 |
| 外掛設定了 `retry` 排程                            | 第一次失敗即作決定；Graft 不等待重試。                            |
| 某個 fork 在 `replace` 之前就已失敗                | 不影響是否回滾，但會一起回滾；恢復失敗會計入。                    |
| 某個 fork 在 `replace` 之前或期間直接請求目標外掛  | 不計入，回滾後仍留在目標外掛上。                                  |
| 之後的 `replace` 或 `restart` 接管了某個 fork      | 該 fork 及其子 fork 不再計入，它也不會回滾。                      |
| 呼叫端在 `replace` 等待時被中斷                    | 保留替換。                                                        |

恢復後的 fork 只有仍處於回滾恢復的外掛、且未被卸載時才計入。恢復也會等待恢復後的父外掛新建的後代，並計入它們的完整失敗 cause。後續取代或重新啟動會接管該 fork 及其子樹，它們不再計入。
`Pending` 表示等待相依項目，與取代前一樣算作已恢復。`timeout`
不限制恢復等待時間。

- `timeout`
  是一個選項：`Graft.replace(pairs, { timeout: "30 seconds" })`。不設定時，`replace`
  會一直等到 fork 啟動完成。[熱重載](../hot-reload/)預設等待 30 秒。
- 每個失敗都帶有 `fork` id 和 `plugin` 名稱。
- `Graft.resolve(plugin)` 回傳現在載入 `plugin` 時實際載入的外掛，因此在
  `replace` 等待期間被中斷的程式碼可以據此判斷取代是否保留。
- 使用被回滾外掛服務的外掛會重新啟動兩次：一次換成新版本，一次換回舊版本。它們本身的失敗不會引起回滾。

## 衝突

有些批次無法用執行階段的 alias 表達，會以 `Graft.ReplacementConflict` 失敗，其
`indices` 欄位列出衝突的配對。

| 衝突的批次                                   | 範例           |
| -------------------------------------------- | -------------- |
| 同一個來源對應不同目標                       | `P → Q, P → R` |
| 重疊的變更                                   | `P → Q, Q → R` |
| 會使現有 fork 停留在其他外掛上的過期來源身分 | —              |

失敗時，交易不會修改 alias 或 fork。以下兩種情況仍然支援：讓多個來源指向同一個未變更的目標，以及還原到舊版本。
