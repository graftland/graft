---
title: 生命週期
description: 載入外掛、觀察狀態，並在執行期間修改外掛。
---

## 載入外掛

`Graft.plugin` 載入外掛並回傳它的 fork：

```ts
const app = Plugin.make({
	name: "app",
	apply: () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(greeter, { greeting: "Hello" })
			yield* fork.await
		}),
})
```

fork 隸屬於目前的 `Scope`。這個 `Scope` 關閉時，fork 就會卸載。在 `apply`
內，目前的 `Scope`
屬於外掛自身，因此在其中載入的外掛就是它的子外掛。父外掛停止或重新啟動時，子外掛也會停止。和父外掛
`Scope`
中的其他內容一樣，它們依相反順序釋放：在父外掛開啟某個資源之後載入的子外掛，會在該資源關閉之前停止。子外掛如果透過
`inject`
使用父外掛的服務，則無論順序如何都會先停止，詳見[服務撤回流程](../services/#服務撤回流程)。

第二個引數是外掛的輸入，由外掛的設定 schema 解碼。不需要設定的外掛無須傳入輸入。第三個引數包含
[`isolate` 和 `intercept`](../isolation/) 選項。

## fork 狀態

fork 一律處於下列其中一個狀態：

| 狀態       | 含義                                         |
| ---------- | -------------------------------------------- |
| `Loading`  | 正在解碼設定或執行 `apply`。                 |
| `Pending`  | 等待必要的服務，`missing` 列出缺少的服務鍵。 |
| `Active`   | `apply` 已執行完畢，外掛正在執行。           |
| `Failed`   | 啟動或執行失敗，`cause` 包含完整的 `Cause`。 |
| `Disposed` | 已卸載，這是最終狀態。                       |

fork 會自動在這些狀態之間切換。`Pending`
狀態的 fork 在所需服務出現時啟動；`Active` 狀態的 fork 在所需服務消失時回到
`Pending`；`Failed` 狀態的 fork 在設定或相依項目變更時，或在 `retry`
排程觸發時重試。

retry
driver 的初始化和每一步執行都受同一個變更監督邊界管理。設定或相依項目變更會取消舊操作，並等待其清理完成後再開始下一次嘗試。設定和相依項目解析均未變更時，保留原有 Schedule 狀態與重試預算。排程失敗（包括變更引發的清理失敗）會合併進 activation 的
`Failed.cause`。卸載取消 retry 時新發生的失敗則進入
`CleanupError.cause`，不會重播先前已經發布的啟動失敗。

建構或執行 intercept 時的失敗同樣使 fork 進入
`Failed`。Graft 會保留完整的 Cause，並解除 `await`
的等待。retry 排程不會重試這類失敗；fork 會等待設定更新、外掛取代或明確呼叫
`restart`。失敗歸屬於 supervisor 當時正在處理的 spec，包括原地更新。已經處理過的更新不會觸發再次嘗試；清理期間送達的新請求仍保持待處理。

`Plugin.fork` 啟動的背景任務屬於 activation。除純中斷外的失敗，與 `apply`
中的失敗走相同的 `Failed`
和 retry 路徑。兄弟任務被取消並清理之後，完整的 Cause 仍會保留。

清理依下列順序進行：停止
`apply`，關閉發布並撤回服務，排空所有消費者，然後停止剩餘任務並關閉它們的 Scope。這之後才關閉 activation
Scope，並釋放外掛自身相依項目的 lease。排空期間，健康的任務繼續服務消費者的 finalizer，即使這次清理是由另一個任務的失敗觸發也一樣。排空期間發生的失敗同樣保留完整 Cause，並由 Graft 記錄日誌；如果清理由失敗觸發，這些失敗會併入最終的
`Failed` 狀態。單純的 `Effect.forkScoped` 不會把背景失敗交給這個 supervisor。

## fork 控制代碼

| 成員            | 作用                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `id`            | 用於在樹和日誌中識別 fork 的數字。                                                                     |
| `state`         | 先送出目前狀態，再送出每次變化的串流，以 `Disposed` 結束。                                             |
| `await`         | 等待 fork 離開 `Loading` 狀態。如果最終進入 `Failed`，則以外掛的錯誤失敗。                             |
| `stable`        | 等待目前的 fork 及其後代都離開 `Loading`。`Pending` 和 `Failed` 都視為已穩定，不會因子項目失敗而失敗。 |
| `update(input)` | 向 fork 傳入新輸入。外掛會[原地更新](../plugins/#原地更新)或重新啟動。                                 |
| `restart`       | 使用相同的輸入重新啟動外掛。                                                                           |
| `dispose`       | 卸載外掛及其載入的所有內容。                                                                           |

`update` 和 `restart`
在請求被處理、被後續請求取代或 fork 已卸載時回傳。fork 只保留最新請求的設定，並行更新可能完全跳過中間輸入；被取代的更新也會成功回傳，即使它的輸入從未套用、最新請求仍在等待。成功回傳不代表這一次設定已經交付。這些呼叫不會等待重新啟動完成。使用
`await` 或 `state` 觀察 fork 的目前狀態；它們不用於確認已經被取代的輸入。

並行及重複呼叫 `dispose` 會共用唯一一次關閉操作及其完整結果。其型別是
`Effect<void, Fork.CleanupError>`。`CleanupError.cause` 保存原始的 typed
failure、defect 和混合的中斷原因，它們來自 apply、被中斷的更新、受監督的背景任務、資源及 supervisor 清理。只有純中斷時，視為正常停止。每個清理階段仍會執行，包括釋放相依項目的 lease。`Failed.cause`
會合併清理失敗和原本的 activation 失敗。結果一旦發布為
`Failed`，之後卸載這個閒置的 fork 不會重播它；恢復後的 activation 使用新的清理結果。

父 Scope 會等待同一次清理，因此先開始卸載子外掛不會讓父資源提前釋放。取消等待者不會取消清理。公開的 dispose 在 fork 與父層解除掛接後完成。Scope 自動關閉時，`CleanupError`
會以 defect 回報，因為 Effect 的 finalizer 沒有 typed
error 通道；錯誤中仍保留完整的原始 Cause。處理函式請求卸載自己的 fork 時，它自身也會被這次卸載中斷。

`await` 把 `Pending`
視為已穩定的狀態，因為等待中的 fork 可能永遠等不到服務。若要等到 fork 真正執行起來，請觀察
`state`，等待 `Active`。

`fork.stable` 的型別是
`Effect<void>`，透過子樹計數器等待，不必建構或訂閱整棵 fork 樹。它只反映目前狀態，不等待尚未開始的設定請求。設定協調器仍須檢查請求版本和待處理的重新整理；載入器編輯應使用
[`loader.ready`](../config-file/#透過程式碼編輯設定項目)，它也會等待這些工作。失敗可透過
`state` 或 `await` 觀察。

卸載後才訂閱 `state`，仍會收到 `Disposed`，接著串流結束。

## 取代外掛

`Graft.replace`
將外掛取代為新版本。舊外掛的每個 fork 都會使用新版本重新啟動；之後再載入舊外掛，也會載入新版本：

```ts
const upgrade = Graft.replace([[greeterV1, greeterV2]])
```

TypeScript 會逐對獨立檢查。目標外掛的輸入型別必須與來源完全相同，錯誤型別必須是來源錯誤上界的子集。錯誤上界包含解碼失敗（`SchemaError`），因此既有的 fork 控制代碼在取代後仍然有效。定義的輸入與錯誤契約是不變的：無法透過把同一個物件指派給更寬的錯誤型別或更窄的輸入型別來繞過檢查。需要的錯誤聯集應在建立外掛時宣告，再載入外掛。

動態載入的模組使用參數為 `any` 的
`Plugin`。這個邊界刻意移除了靜態契約，HMR 和 loader 仍可使用；它不會在執行階段驗證取代的相容性。明確改成
`any` 或使用型別斷言，同樣可以繞過 TypeScript 的保證。

外掛的身分由定義物件的參照決定，不由名稱或欄位決定。重複使用同一個物件代表同一個外掛；`{ ...plugin }`
會建立不同的外掛，取代一個副本不會影響其他副本或原物件。載入、alias 查找和衝突檢查都遵循這個規則，凍結的物件和自訂了
`Equal` 或 `Hash` 的定義也不例外。Graft 不會修改呼叫端所擁有物件上的這些實作。

Graft 在一次交易中套用所有取代關係，任何 fork 都不會看到只完成一部分的取代。接著，每個受影響的 fork 依照正常的[服務撤回順序](../services/#服務撤回流程)停止並重新啟動。[熱重載](../hot-reload/)使用的就是
`replace`。

有些批次無法用執行階段的 alias 表達，會以 `Graft.ReplacementConflict`
失敗，`indices` 列出衝突的配對索引。這包括同一個來源對應不同目標，以及
`P → Q, Q → R`
這類重疊的變更，還包括會使現有 fork 仍停留在其他外掛上的過期來源身分。失敗時，交易不會修改 alias 或 fork。以下兩種情況仍然支援：讓多個來源指向同一個未變更的目標，以及還原到舊版本。

## 觀察應用程式

`Graft.forks` 是一個串流，在每次變化時送出完整的 fork 樹。每個節點包含 fork 的
`id`、`name`、`input`、`state` 和 `children`：

```ts
const inspector = Plugin.make({
	name: "inspector",
	apply: () =>
		Graft.forks.pipe(
			Stream.runForEach((trees) => Effect.log(trees)),
			Plugin.fork,
			Effect.asVoid,
		),
})
```

`Graft.logs` 收集使用 `Graft.layer`
的環境中的日誌，包括宿主應用程式的日誌。新的訂閱者會先收到最近的 1000 筆日誌。外掛執行時送出的日誌帶有
`graft.fork` 和 `graft.plugin`
註解；宿主日誌保留自己的註解，Graft 不會替它們捏造外掛身分。因此讀取日誌時，應允許這兩個註解缺少。
