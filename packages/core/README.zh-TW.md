# @graftland/graft

[English](https://github.com/graftland/graft/blob/main/packages/core/README.md)
|
[简体中文](https://github.com/graftland/graft/blob/main/packages/core/README.zh-CN.md)
| 繁體中文

以 Effect 打造的外掛框架：外掛、fork、服務、隔離、事件和日誌。

支援的 Node.js 最低版本是 22.19。

```sh
npm install @graftland/graft effect
```

用 `Plugin` 定義外掛，用 `Graft` 執行外掛，用服務和 `Event` 把它們連接起來。

用 `Plugin.fork(effect)` 執行由外掛持有的背景任務。

- 如果 worker 失敗或出現 defect 且無人處理，activation 就會失敗。失敗會攜帶完整的 Cause。之後 activation 依其重試計畫重試。
- worker 主體的純中斷不會使 activation 失敗。
- 外掛被撤回後，健康的 worker 繼續為既有的消費者服務。只有這些消費者釋放 lease 之後，worker 才會停止。這發生在 activation 資源關閉之前。
- worker 的錯誤型別透過 `Plugin.Tasks<E>` 成為外掛合約的一部分。
- 請在 fork 之前，在 worker 內部處理可復原的錯誤。
- 單獨使用 `Effect.forkScoped` 只管理生命週期，不會把失敗傳給 Graft。

`fork.dispose` 的型別是 `Effect<void, Fork.CleanupError>`。

- 並行呼叫和重複呼叫共用同一個清理結果。
- `CleanupError.cause`
  保留所有原始失敗原因。框架管理的 Scope 若在釋放時發生純中斷，會以
  `ReleaseInterrupted` defect 回報，原始中斷保存在它的 `cause`
  中。這樣，釋放失敗經過巢狀事件或背景工作仍能傳到呼叫端；正常取消仍按中斷處理。
- 即使某個 finalizer 失敗，清理仍會繼續完成資源釋放和相依 lease 的釋放。
- activation 失敗時，`Failed.cause` 也包含清理失敗。
- 父 Scope 自動關閉時，Graft 把清理錯誤當作 defect 回報。該 defect 保留原始 Cause。

以下規則適用於 `inject` 中宣告的相依：

- 消費者所在領域（realm）中的 provision，優先於建構 `Graft.layer` 時的環境。
- 必選和可選消費者在該 provision 出現或被撤回時都會重新啟動。環境中有值時，它們回落到環境值。
- provision 從不從父外掛繼承。每個子外掛各自解析自己的相依。
- 環境服務（ambient services）在各個領域中始終可用。
- 注入的 `Context.Reference`
  鍵同樣會回落到繼承的值和 intercept，或回落到預設值。它們不會因為沒有值而停留在
  `Pending`。provision 仍然優先。

領域標籤和服務鍵是身分中相互獨立的兩個部分。即使其中一個包含 NUL 字元，也是如此。共用標籤永遠不會指向私有領域或預設的根領域。

一次發布可能經由相依變化或後代 scope 重新啟動它自己的發布者。Graft 會以
`ServiceConflict` 原子地拒絕這樣的發布。

- 必選的 `Pending` 相依正在等待啟動，不算作重新啟動的 watcher。
- 被拒絕的發布者會一直等待，直到它的設定、相依或造成阻塞的相依圖發生變化。

請參閱[服務文件](https://graftland.github.io/graft/zh-tw/services/)。

外掛的身分就是物件參考的身分。

- 重複使用同一個定義，指的是同一個外掛。
- `{ ...plugin }` 會建立一個不同的外掛，即使欄位完全相同。
- 載入、取代和衝突檢查都使用這條規則，與定義自身的 `Equal` 或 `Hash` 行為無關。

`Graft.replace` 會拒絕其全域別名無法表示的對應。它用有型別的
`ReplacementConflict` 拒絕，其中包含衝突的配對索引。

- 驗證和發布共用一個交易。存在衝突的批次不會改變別名和 fork。
- 形如 `P → Q, Q → R` 的重疊取代必須拆分成具有不同身分的版本。
- 一次還原到舊版本的操作仍然受支援。

有型別的取代保持相同的輸入型別。它們只能收窄原有的錯誤上界，包括解碼錯誤。定義會在別名之間保持這一合約。動態載入的
`Plugin<any>` 值會明確抹去這一合約。

## 資源釋放

需要讓 finalizer 自身的中斷在外層取消後仍可見時，使用
`Release.scoped`。既有 Scope 可用 `Release.close`
關閉。釋放過程自行產生的中斷會成為帶有原始 cause 的 `ReleaseInterrupted`
defect；預期的外部取消仍是 Interrupt。

## 文件

- [外掛](https://graftland.github.io/graft/zh-tw/plugins/)
- [服務](https://graftland.github.io/graft/zh-tw/services/)
- [生命週期](https://graftland.github.io/graft/zh-tw/lifecycle/)

屬於 [Graft](https://github.com/graftland/graft)。採用
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE) 授權。
