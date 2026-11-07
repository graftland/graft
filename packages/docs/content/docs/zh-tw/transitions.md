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
對齊。已結算觀察歷史保留 128 筆；請求鍵紀錄和未結算紀錄另行保留。

## 請求鍵

相同請求鍵和正規化內容在准入檢查前回傳原控制代碼，即使版本已變化或觀察歷史已淘汰。相同鍵下的實例、候選、預期版本、策略、預算或要求發生變化時，回傳
`KeyConflict`。請求鍵在執行時存活期間保留於記憶體。

## 准入

拒絕是沒有 Change id 的 `ChangeRejected` 錯誤。衝突請求不會排隊。

| 原因                | 含義                                         |
| ------------------- | -------------------------------------------- |
| `Busy`              | 衝突物件及擁有它們的 Change id。             |
| `Closing`           | 執行時或實例已關閉准入。                     |
| `UnsupportedTarget` | 沒有匹配的已註冊驅動。                       |
| `InvalidBudget`     | 期限無效，或未為試執行、清理和復原預留預算。 |
| `Stale`             | 預期實例版本已不匹配。                       |
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
預設為零。試執行是最短觀察期；前向與復原試執行都消耗總預算。

## 策略

Overlap 要求驅動在分配前提供已驗證的宣告；候選先啟動，舊代隨後退役。缺少驗證宣告的驅動拒絕明確指定的 Overlap。本實作步驟尚未提供 Restart 和暫停期間的門面呼叫佇列。

## 啟動受管理 Remote 外掛

基於工件的 Remote 部署透過 `Remote.plugin`
註冊驅動。Loader 綁定項目 id；嵌入使用時明確提供實例名。見[工件](../remote/artifacts/)。

## 驅動擴充點

`Transition.registerDriver`
只發布一次穩定門面。每代擁有自己的執行、解析和 lease。驅動分配不得啟動執行；執行從
`Unit.start` 開始。停止確認、傳輸斷線和 Scope 關閉都不能代替退出證據。

## 遠端排空

RPC 結果和用戶端取消都不證明遠端請求 Scope 已完成，包括一般一元呼叫。通用遠端請求 Scope 排空仍不支援，等待階段 2 的完成紀錄。

## 繞過保護

`Fork.update`、`Fork.restart`、Loader 修改和替換操作仍透過 `ManagedFork`
拒絕修改受管理樹。明確銷毀仍可用。
