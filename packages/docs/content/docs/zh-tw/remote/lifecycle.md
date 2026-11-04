---
title: 替換、租約與停止
description: 安排實例替換與關閉流程時看這一頁。
---

安排實例替換與關閉流程時看這一頁。這裡說明 generation、租約與退出確認的保證，以及宿主如何收到失敗。

對同一驗證身分與 instance，runner
**確認舊行程退出後**才接受新實例。generation 會持久保存並遞增，runner 復原後也成立。無法確認退出就拒絕替換。外掛從
`Remote.Instance` 讀取
`{ id, generation }`；外部系統可以拒絕舊 generation 的寫入，也就是 fencing，但必須自行檢查。它不會撤銷已完成的寫入，不保證呼叫恰好一次，也不協調不同 runner。local/worker 每次都是新 id、generation
1。

宿主持續續租；停止續租後執行單元到期退出，runner 消失也會觸發退出。整台機器暫停會暫停期限執行，因此不是硬即時保證；行程身分檢查還有很窄的 PID 重用窗口。後代行程仍由外部 supervisor 負責。

停止先執行優雅 Dispose。`shutdownTimeout` 預設五秒，只限制這一步。之後：

- 本機子行程再有一秒自然退出；逾時後強制終止，spawner 再過一秒升級為 SIGKILL 並確認退出。
- worker 同樣等一秒，接著 `worker.terminate()`
  並等待執行緒確實退出。即使終止成功，逾時仍記入清理錯誤。
- runner 連線最多等待租約加宿主 `margin`。runner 的 `grace`
  預設五秒，是從中斷到強制終止的窗口；`margin` 只是宿主額外等待確認的時間。

| 結果                           | 意義                                                                       |
| ------------------------------ | -------------------------------------------------------------------------- |
| `Exited`                       | 正常停止，已確認行程退出。                                                 |
| `Killed`                       | 已確認強制終止，finalizer 可能未完成。                                     |
| `RemoteTerminationUnconfirmed` | 退出未確認，可能已斷線，也可能仍連線但 runner 無法確認。逾時不是退出證明。 |

前兩種寫入附有 instance、generation 的 `remote.termination`
日誌，第三種是清理錯誤。正常斷線不記 ERROR，異常連線記錄帶有 cause 和身分的 Warning。執行壽命由 Dispose 與租約決定，不只取決於連線。負載過高可能遺失日誌，宿主會回報數量。

TS 代理暴露已宣告的錯誤、`Contract.UndeclaredFailure`、`RemoteWithdrawn`、含 cause 的
`RemoteError` 與 `MissingInstance`。dispose 回傳
`Fork.CleanupError`，可在其 cause 尋找
`RemoteTerminationUnconfirmed`。defect 仍是 defect。YAML 錯誤也會標示 entry 與失敗欄位。
