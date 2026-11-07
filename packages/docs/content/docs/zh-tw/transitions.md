---
title: 執行轉換
description: 觀察協調器結局，並實作有作用域歸屬的執行驅動。
---

`Graft.transition` 協調一個受管理 fork 的執行單元替換。**受管理 fork**
註冊執行驅動，並在換代時保留契約服務物件。使用工件的 Remote 外掛支援直接 Worker 和子行程；一般模組部署與 runner 目標回傳
`Aborted(UnsupportedTarget)`。

## 啟動受管理 Remote 外掛

```ts
import { Schema } from "effect"

import * as Remote from "@graftland/plugin-remote"

declare const contract: Remote.Contract.Contract<typeof Schema.String>
declare const artifact: Remote.Artifact.Artifact

export const integration = Remote.plugin(contract, {
	instance: "forecasts",
	artifact,
	contractModule: "@acme/integration-contract",
	target: { _tag: "Worker" },
	maxInFlight: 16,
	policy: { probes: ["health"] },
})
```

將業務輸入傳給 `Graft.plugin(integration, input)`。子行程使用
`{ _tag: "Local" }`。宿主執行環境提供檔案系統、路徑、安全亂數和子行程服務。受管理 Remote 契約支援一元操作，僅允許注入可選的[主機能力代理](../trust/)。透過服務圖解析的宿主相依服務與外掛自動重試尚不支援。使用模組位置的
`Remote.plugin` 選項仍採用一般重新啟動行為。

Loader 將項目 id 綁定為實例名稱。嵌入式註冊必須提供
`instance`；空名稱、衝突或重複名稱會在啟動單元前失敗。`target`
接受該名稱或數字 fork id。名稱在整個執行環境中唯一。

## 請求轉換

```ts
import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

declare const deployment: Remote.CandidateOptions

export const request = Graft.transition({
	target: "forecasts",
	candidate: Remote.candidate(deployment),
	policy: {
		total: "5 minutes",
		drain: "5 seconds",
		terminate: "5 seconds",
		probes: ["health"],
	},
})
```

`Remote.candidate`
建構一個惰性的候選描述，包含已擷取的工件、契約模組、直接執行目標和輸入。它會複製並凍結部署資料，包括巢狀 JSON 輸入和目標選項，呼叫者後續修改不會改變保留的復原輸入。它既不驗證也不啟動工件。[擷取和驗證](../remote/artifacts/)
仍須明確執行；驅動在每次啟動單元前驗證擷取內容，復原時也會驗證。

| 入場規則                                                 | 結果                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| 已有轉換正在執行，包括試運行期                           | `Aborted(Busy)`；請求不會排隊。                                             |
| 目標 fork 正在關閉                                       | 分配單元前回傳 `Aborted(Closing)`。                                         |
| 目標沒有相符的已註冊驅動                                 | 分配單元前回傳 `Aborted(UnsupportedTarget)`。                               |
| 轉換後的截止時長不是有限正數，或總預算不足以預留復原時間 | `Aborted(InvalidPolicy)`；允許零試運行時長。                                |
| 之前的轉換尚未確認單元終止                               | 回傳 `Aborted(Stuck)`，直到執行環境被釋放。遲到的退出證據不會重新開放入場。 |
| 呼叫者在入場後取消等待                                   | fork 負責完成轉換和復原；取消等待不會取消轉換。                             |

## 結局和證據

| 結局             | 含義                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Accepted`       | 候選已服務，並已觀察到舊單元退出。                                                                                      |
| `Aborted`        | 入場失敗，或候選在切換前失敗且已確認終止。拒絕候選後保留舊路由；釋放取消回傳 `Aborted(Closing)` 並關閉路由。            |
| `Recovered`      | 確認候選和舊單元均已終止，再以舊工件啟動新的服務嘗試並就緒。也適用於拒絕候選時舊嘗試已經失敗的情況。                    |
| `RecoveryFailed` | 復原失敗，或內部協調器缺陷以 `CoordinatorDefect` 原因結束轉換；所有需要清理的單元均已確認終止。呼叫回傳 `Unavailable`。 |
| `Stuck`          | 無法確認必要的終止。呼叫回傳 `Unavailable`，後續轉換被阻止。                                                            |

`Transition.Outcome` 提供帶標籤的建構函式和
`$match`。結局附帶階段和證據，包括完整失敗 cause、截止情況和觀察到的退出。終止命令、傳輸中斷或作用域關閉都不算退出證據。停止或排空逾時後，只要確認終止，仍可回傳
`Accepted`；這些失敗會保留在證據中。

直接單元證據區分 `Exited` 和
`NotStarted`：後者證明啟動已被阻止或已結束，且從未產生執行單元。傳輸中斷或終止命令收到回應都不能代替退出證據。

釋放會先關閉入場，再取消已入場的轉換。結局保留被中斷的階段、嘗試和已有證據。確認清理後回傳
`Aborted(Closing)`；只有缺少必要退出證據才回傳
`Stuck`。協調器缺陷保留 cause，不會被歸類為終止失敗。確認執行單元退出不會掩蓋宿主清理失敗：`Fork.dispose`
獨立等待宿主釋放，並將失敗合併到
`CleanupError`，即使取消恰好發生在執行單元退出之後。重複終止會等待同一次宿主釋放；確認退出不會跳過它。

## 策略和呼叫

策略時長接受 `Duration.Input`，例如 `"5 seconds"`、`Duration.seconds(5)`
或毫秒數。轉換後的截止時長須為有限正數；試運行可為零。

| 欄位                         | 限制                                       | 預設值  |
| ---------------------------- | ------------------------------------------ | ------- |
| `total`                      | 整個轉換，包括終止和復原                   | 5 分鐘  |
| `startup`                    | 每次分配、啟動、描述、服務和就緒操作       | 30 秒   |
| `probe`                      | 每個請求的探測                             | 5 秒    |
| `trial`                      | 切換後觀察候選                             | 零      |
| `drain`、`stop`、`terminate` | 呼叫、正常停止，以及每次退出或宿主釋放等待 | 各 5 秒 |
| `probes`                     | 切換前和復原期間請求的探測名稱             | 空      |

每個階段的等待都受剩餘總預算限制。準備和試運行預留
`5 × startup + probes.length × probe + drain + stop + 6 × terminate`
給清理和復原。清理保留 `5 × startup + probes.length × probe + 2 × terminate`
的復原預算。復原在成功或需要清理之前保留兩次終止等待。總預算必須大於初始預留，否則入場回傳
`Aborted(InvalidPolicy)`。切換前，驅動須宣告可安全重疊執行，並提供所有需要的
`name@version`。

門面在呼叫的 Effect 執行時選擇服務嘗試，即使該 Effect 是之前建構的。選擇和入場與切換保持原子性。已入場的呼叫固定在該嘗試上。新呼叫進入新嘗試；舊呼叫完成、被取消，或在排空預算耗盡、舊單元退出後結束。單元終止提供清理證據；僅收到 RPC 回應無法證明伺服端請求作用域已清理。

`maxInFlight`
限制每個嘗試的已入場呼叫數。核心註冊預設為 256；Remote 預設為 16，接受 1–16。超額呼叫在入場前以
`AdmissionRejected` 拒絕，不排隊。Remote 透過 `RpcClientError`
回報協調器呼叫失敗，原始錯誤保留在 reason 的 cause 中。取消呼叫會釋放入場名額。

`Fork.generations`
觀察啟動、服務、排空、已終止和卡住的單元代。保留活動和卡住的單元代，以及最近 32 個已終止摘要；摘要包含候選身分，不含部署酬載。未受管理的 fork 回傳空清單。`Fork.generationEvents`
向目前訂閱者發布包含部署資料的完整代變更，不提供重播。緩衝區保留 64 個事件；慢訂閱者可能錯過較早的事件。需要持久稽核歷史時，應在 fork 外保存事件。復原會從固定的舊工件和輸入分配新的單元和服務嘗試，不重用失敗的嘗試。直接單元在停止後嘗試正常退出；停止逾時則強制終止。外部執行環境相依套件不會被擷取或固定版本。

## 驅動擴充點

```ts
import { Plugin, Transition } from "@graftland/graft"

declare const driver: Transition.Driver
declare const registration: Transition.Registration

export const integration = Plugin.make({
	name: "example/integration",
	apply: () => Transition.registerDriver(driver, registration),
})
```

註冊歸屬於目前 fork 的作用域。門面的 provision 和服務物件屬於該 fork，不屬於任何單元的服務作用域。
`Transition.facade`
只建構一次服務物件，並為其方法提供呼叫函式。協調器負責就緒、探測、切換、排空和復原。驅動只提供生命週期操作、私有服務上下文以及可獨立觀察的退出，不能更改路由。

自訂驅動必須在註冊或轉換入場前建構不可變候選快照，包含復原所需的每個巢狀部署值。核心保留該快照，無法複製任意驅動資源。

分配必須是惰性的：外部執行只能在 `Unit.start`
中開始。終止已分配的單元必須阻止後續啟動並回報
`NotStarted`。終止與啟動競爭時，必須等待明確的產生或退出證據。驅動操作必須支援安全取消；無回應的操作仍歸屬於 fork，直到 fork 釋放。提供獨立且可重複觀察的
`failure` 和 `exited`。描述實作自身的操作身分，以一般外掛 `apply`
作為服務主體。受管理註冊暫不支援透過服務圖解析的宿主依賴和外掛自動重試；允許使用執行環境服務。狀態轉移、通用準備、串流門面、runner 轉換和多 fork 轉換尚未實作。

## 繞過保護

| 路徑                          | 受管理時的行為                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `Fork.update`、`Fork.restart` | 更改 fork 或其受管理後代之前，以 `ManagedFork` 失敗。                             |
| `Graft.replace`               | 更改別名或設定描述之前，以 `ReplacementConflict` 失敗，原因為 `ManagedFork`。     |
| Loader                        | 樹中存在受管理 fork 時，在呼叫儲存修改之前拒絕編輯、重新整理和重試。              |
| HMR                           | 執行環境存在受管理 fork 時，在準備重載之前回傳 `Skipped`，原因為 `managed-fork`。 |

擴充工具可用 `Transition.withUnmanaged`
在外部寫入期間持有繞過入場權。寫入期間，驅動註冊會失敗。`Transition.assertUnmanaged`
只是唯讀預檢，不會在後續工作期間持有入場權。仍可明確釋放 fork。
