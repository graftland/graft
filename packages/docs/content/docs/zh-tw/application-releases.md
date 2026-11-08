---
title: 應用程式發布
description: 規劃、套用、觀察與回滾不可變的應用程式發布。
---

`@graftland/plugin-release`
建立**發布**：包含擷取的外掛與契約位元組、設定和套件中繼資料的不可變目錄。工作流程使用公開的[核心控制用戶端](../units/)與
[Change](../transitions/)。

| 操作       | 結果                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| `build`    | 以內容定址的發布 id，不啟用外掛                                         |
| `load`     | 驗證目標並保留環境參照，供規劃使用                                      |
| `plan`     | 純計算的 Change 操作，每個成員附有 `Added`、`Changed` 或 `Removed` 原因 |
| `apply`    | 一個 Change id 及其結局、階段和診斷                                     |
| `observe`  | 依 id 查詢 Change 狀態；未知時為 `None`                                 |
| `history`  | 結合日誌的套用紀錄和結局                                                |
| `rollback` | 透過新的 Change 套用上一個已接受的發布                                  |

## 規劃與套用

每個應用程式使用獨立的發布儲存目錄和日誌。為應用程式實例設定持久化的[發布記錄器](../recording/)，並在套用發布前透過控制用戶端授權目標。

```ts
import { Effect } from "effect"

import * as Release from "@graftland/plugin-release"
import type * as Control from "@graftland/plugin-remote/Control"

declare const client: Control.Client
declare const current: ReadonlyArray<Release.CurrentInstance>
const store = { releases: "./releases", journal: "./journal" }

const deploy = Effect.gen(function* () {
	const id = yield* Release.build(store.releases, {
		file: "./release.yml",
		references: [],
		revocations: [],
	})
	const release = yield* Release.load(store.releases, id)
	const preview = Release.plan(release, current)
	const result = yield* Release.apply(client, store, id, current)
	const status = yield* Release.observe(client, result.change)
	const releases = yield* Release.history(store)
	return { preview, result, status, releases }
})
```

| 規則     | 行為                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| 目前實例 | 提供此發布工作流程管理的所有實例及其目前目標，不包含記錄器等基礎設施。發布中不存在的實例會被移除。                     |
| 比較     | 程式碼、契約、放置、輸入或探針變化會部署該成員。相同擷取位元組的位置變化不會觸發部署。                                 |
| 請求身分 | 發布 id 決定 apply 的請求鍵。保留首次規劃和選項；重複已完成的 apply 回傳原始結果，包括失敗。需要再次部署時建立新發布。 |
| 參照     | `load` 保留輸入中的環境參照；`apply` 只透過實例策略的參照值提供解析結果，請求、狀態和歷史保留參照。目標權限保持不變。  |
| 空規劃   | 沒有更早的套用紀錄且目前目標已經符合時，`apply` 以 `ReleaseError` 的 `NoChanges` 代碼失敗。                            |
| 放置     | `Worker` 使用 Worker，`Local` 使用 Process 單元。不支援自訂命令和 Worker 引數。                                        |
| 舊製品   | 未擷取契約的發布必須重新建立。`metadataOnly` 只在建置時略過套件宣告檢查；套用時仍驗證套件中繼資料。                    |

儲存目錄的位置應保持穩定。擷取的套件仍可能匯入外部執行依賴，見[套件發布](../publishing/)。

## 觀察與查看歷史

`observe` 回傳公開的 Change 狀態，包括成員事實和結論。`apply`
如實回傳失敗結局；判斷失敗的套用是否維持原狀前，先檢查每個成員。

| 歷史欄位                   | 含義                                    |
| -------------------------- | --------------------------------------- |
| `release`、`change`、`run` | 發布 id、Change id 和可選的核心執行身分 |
| `outcome`                  | 已記錄或已儲存的結論；未知時為 `None`   |
| `recorded`                 | 日誌包含此執行與 Change 的確切結論      |
| `diagnostic`               | 日誌保留的診斷；無法取得時為空          |

`history`
無需執行核心，並驗證參照的發布位元組。將發布儲存中的套用收據與日誌一起保留。僅由套用用戶端儲存的結果為
`recorded: false`；核心的持久恢復需要記錄器。即使尚未儲存收據，`history`
也能從日誌中的請求鍵恢復套用紀錄。核心重啟後重試 `apply`
會從日誌恢復原始執行身分、Change
id 和結局，不會重複執行。中斷紀錄沒有已知結局時，回傳
`RecordedOutcomeUnknown`；可透過 `history`
查看事實。重複結果從日誌讀取診斷，收據不保留副本。取消等待不會取消已准入的 Change。

## 回滾

呼叫
`rollback(client, store, current)`，提供目前應用程式目標。它選擇最近一次已接受的套用之前、與其不同的已接受發布；失敗的套用不會成為回滾目標。少於兩個不同的已接受發布時，以
`ReleaseError` 的 `NoPreviousRelease` 代碼失敗。

回滾更新參照值，並透過正常准入提交新的 Change。它不修改目標權限，也不重用目標發布原來的 apply 結果。已撤銷的目標仍以
`Unauthorized` 拒絕；發布的 `revocations`
中繼資料不能授予權限。回傳的結局描述此次回滾嘗試，包括失敗或恢復。
