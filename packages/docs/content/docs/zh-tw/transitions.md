---
title: 變更
description: 提交、等待並觀察彼此獨立的執行態變更。
---

**Change**
是一次已准入、具有穩定 id 的執行態替換。執行時擁有它，直到試執行、復原和結算結束。某個 Change 等待或 Stuck 時，無關實例仍可變更。

## 提交與等待

```ts
import { Effect } from "effect"

import { Change } from "@graftland/graft"

declare const candidate: Change.Candidate

export const replacement = Effect.gen(function* () {
	const handle = yield* Change.submit({
		key: "forecasts-v2",
		instance: "forecasts",
		candidate,
		strategy: "Overlap",
		requirements: { probes: ["health"], trial: "2 seconds" },
	})
	return yield* handle.await
})
```

`Change.run` 合併提交與等待。取消等待不會取消 Change；`handle.cancel`
明確請求取消，重複呼叫沒有額外影響。重複等待同一個控制代碼得到相同結局。

## 觀察

`Change.get(id)` 回傳目前狀態；未知或已被歷史淘汰的 id 回傳
`None`。`Change.changes`
傳送有界通知，每個 Change 帶獨立序號。慢觀察者不會阻塞執行，遺漏通知後用 `get`
對齊。狀態包含 Change
id、可用的 trace 關聯、成員事實與結算證據；診斷攜帶相同關聯。已結算觀察歷史保留 128 筆；請求鍵紀錄和未結算紀錄另行保留。

成員的實際事實反映目前路由、版本和可用性，包括試執行與復原期間。已記錄結局中的成員仍是不可變快照。

## 請求鍵

相同請求鍵和正規化內容在准入檢查前回傳原控制代碼，即使版本已變化或觀察歷史已淘汰。相同鍵下的實例、候選、預期版本、策略、預算或要求發生變化時，回傳
`KeyConflict`。請求鍵在執行時存活期間保留於記憶體。

並行重試回傳原 handle，不等待多餘中繼資料清理；遲到的清理失敗會記錄完整 cause。

## 准入

拒絕是沒有 Change id 的 `ChangeRejected` 錯誤。衝突請求不會排隊。

| 原因                | 含義                                         |
| ------------------- | -------------------------------------------- |
| `Busy`              | 衝突物件及擁有它們的 Change id。             |
| `Closing`           | 執行時或實例已關閉准入。                     |
| `UnsupportedTarget` | 沒有匹配的已註冊驅動。                       |
| `InvalidBudget`     | 期限無效，或未為試執行、清理和復原預留預算。 |
| `Stale`             | 呼叫方版本或內部準備前提已不匹配。           |
| `KeyConflict`       | 請求鍵已用於不同的正規化輸入。               |
| `Capacity`          | 單元容量不足以涵蓋策略和復原。               |
| `Unsupported`       | 不支援請求的策略或成員閉包。                 |

## 結局

| 結局             | 含義                                 |
| ---------------- | ------------------------------------ |
| `Accepted`       | 候選已提供服務，必要結算已完成。     |
| `Aborted`        | 舊代未停止、未被切走路由，且仍可用。 |
| `Recovered`      | 新的復原代滿足 Serving 要求。        |
| `RecoveryFailed` | 復原未能重建服務。                   |
| `Stuck`          | 必要結算證據仍未確定。               |

結局保留 Change
id、階段、成員和完整 cause。關閉操作如實回報可用性。Stuck 結論不會改變；遲到證據更新目前結算事實。預留只涉及受影響物件，直到結算或安全隔離後才釋放。

## 預算與呼叫

`budget`
限制總時間以及每次啟動、探針、排空、停止和終止操作。預設總預算五分鐘，啟動三十秒，其他操作五秒。`requirements.probes`
預設為空，`requirements.trial`
預設為零。試執行是最短觀察期；前向與復原試執行都消耗總預算。初始驅動註冊使用相同的預算驗證。

## 策略

Overlap 要求驅動在分配前提供已驗證的宣告；候選先啟動，舊代隨後退役。缺少驗證宣告的驅動拒絕明確指定的 Overlap。Restart 暫停新的門面呼叫，排空並停止舊代，等待退出和必要的宿主清理，再啟動候選。排隊呼叫僅在新路由開放時選擇代。

`Registration.queue`
預設最多 256 個等待者、等待五秒。溢位、過期、關閉和復原失敗會在選擇代之前拒絕呼叫。取消和過期只移除一次等待者。

舊代尚未可能改變時，取消可以保留舊代服務並回傳
`Aborted`。跨過邊界後，復原會重新解析上一個期望目標，並完成探針和完整試執行。退出或宿主清理尚未確認時可回傳
`Stuck`；遲到結算不會恢復執行該 Change。復原先建立新的中繼資料和 scoped policy
binding，再為該目標取得授權前提；執行前再次核對核准，並保留 Change 的物件版本和預留。

`Graft.Options.maxUnits`
預設為 256。初始註冊、預留分配、提供服務、排空中和尚無退出證據的單元均計入限制。Restart 可在確認舊單元退出後重用容量；其他 Change 不能占用復原預留。

## 啟動受管理 Remote 外掛

基於工件的 Remote 部署透過 `Remote.plugin`
註冊驅動。Loader 綁定項目 id；嵌入使用時明確提供實例名。見[工件](../remote/artifacts/)。

## 驅動擴充點

`Transition.registerDriver`
只發布一次穩定門面。維持門面綁定的 Change 共用讀取前提，因此提供者與使用相容門面的消費者可以並行變更。階段 1 不改變門面的發布或所有權。每代擁有自己的執行、解析和 lease。驅動分配不得啟動執行；執行從
`Unit.start` 開始。`Registration.resolve`
在每次分配前接收未解析的期望候選，包括初始啟動和復原。每次分配獲得遞增的新任期，以及 Change、代和路由版本權杖；單元確認必須回傳該權杖。停止確認、傳輸斷線和 Scope 關閉都不能代替退出證據。

`Transition.Driver.prepare`
在准入前驗證部署中繼資料，不執行外掛。路由提交再次核對授權版本；移除後重建不能隱藏過期前提。中繼資料清理保留原始完成紀錄，也可能使 Change 保持 Stuck。准入前取消提交會啟動清理；緩慢清理仍由執行時擁有。startup 期限限制中繼資料等待時間，也適用於不可中斷的準備；資源在準備執行結束後清理。即使提交已回傳，清理失敗仍會記錄完整 cause 和請求關聯。

分配期限限制等待；資源和容量在分配執行器實際結束前保持所有權。terminate 等待結束後執行器仍在執行時，Change 回傳 Stuck；遲到結算保留原始結局。

每個受管理執行代各自持有擷取的 provider
lease 和服務 slot。確認單元退出後，執行態 lease 獨立於宿主清理釋放。註冊 Scope 結束時關閉門面准入；代的退出尚未確認時，實例名稱保持隔離，直到遲到結算完成。已結束註冊的執行、清理和已准入 Change 全部結算後，執行時釋放其所有權。執行時關閉時，即使單元退出尚未確認，也會清理待關閉的宿主資源，並單獨回報未結算的執行。

## 遠端排空

RPC 結果和用戶端取消都不證明遠端請求 Scope 已完成，包括一般一元呼叫。通用遠端請求 Scope 排空仍不支援，等待階段 2 的完成紀錄。

## 繞過保護

`Fork.update`、`Fork.restart`、Loader 修改和替換操作仍透過 `ManagedFork`
拒絕修改受管理樹。明確銷毀仍可用。
