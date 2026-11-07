---
title: 變更
description: 提交、等待及觀察核心變更。
---

**變更**替換一個固定的核心實例。核心負責試行、復原及收尾。嵌入式 `Graft.plugin`
組合提供協作式生命週期，不安裝核心服務。

## 提交與等待

核心層與嵌入式執行環境分別建立。請求只包含部署資料，不能傳入閉包或 Context。中斷等待的 fiber 不會取消變更；使用
`handle.cancel` 請求取消。

```ts
import { Effect } from "effect"

import { Change } from "@graftland/graft"

declare const target: Change.Target
export const upgrade = Effect.gen(function* () {
	const handle = yield* Change.submit({
		key: "forecasts-v2",
		instance: "forecasts",
		target,
	})
	const conclusion = yield* handle.await
	const current = yield* Change.get(handle.id)
	return { conclusion, current }
})
```

## 觀察

`Change.get` 回傳目前事實。`Change.changes` 發佈帶序號的快照。發現序號缺口時透過
`get`
核對；慢訂閱者不會阻塞協調。即使無鍵歷史紀錄到期，控制代碼仍保留不可變結局。

檢查、容量及原生退出證據見[執行單元](../units/)。

## 結局

| Outcome          | Meaning                                    |
| ---------------- | ------------------------------------------ |
| `Accepted`       | 目標通過試行，且必要的舊執行退役證據齊全。 |
| `Aborted`        | 失敗後，舊代仍健康、獲授權且未變。         |
| `Recovered`      | 全新獨占復原通過完整試行。                 |
| `RecoveryFailed` | 復原失敗，且所有必要退出均已確認。         |
| `Stuck`          | 缺少必要執行證據；所有權仍可觀察。         |

## 限制

預算以毫秒計，涵蓋整個提交。請求鍵的身分在執行環境生命週期內保留；相同鍵下的不同正規化請求會遭拒。強制退出後的未知清理不代表終結器成功。缺少退出證據時保留容量及預留。在容量允許時，無關實例可以繼續。

## 嵌入式生命週期

嵌入模式的程式碼變更需要重新啟動行程。嵌入式重新啟動、替換及 HMR 不提供核心變更結局或原生終止保證。
