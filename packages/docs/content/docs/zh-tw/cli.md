---
title: 命令列
description: graft 命令及其子命令。
---

CLI 需要 Node.js 22.19 或更新版本，這與它的 Effect Node 轉接器的要求一致。

`@graftland/cli` 套件提供 `graft` 命令。

## graft start

首次匯入失敗後，觀察租約仍由設定項目持有，與立即關閉的候選資源 scope 分離。修正模組後，即使原生通知遺失，也能透過輪詢復原。重試會取代觀察代次，移除或停用設定項目則關閉觀察 scope。

```sh
graft start [config] [--watch] [--env-file <path>]
```

執行[設定檔](../config-file/)所描述的應用程式。`config` 預設為
`graft.yml`。外掛會依設定檔的描述載入。行程會持續執行，直到收到
<kbd>Ctrl</kbd>+<kbd>C</kbd> 或 `SIGTERM`，接著依序卸載所有外掛。

`--env-file` 指定供 [`!env`](../config-file/#環境變數) 標籤讀取的 `.env`
檔案。相對路徑以目前的目錄為基準。行程環境中已設定的變數優先於檔案，即使值是空字串也一樣。檔案不存在時，命令會停止。使用
`--watch`
時，儲存該檔案會重新讀取並讓載入器重試，所以值有變化的項目會被更新。如果檔案無法讀取，會沿用先前的值。這個檔案會提供給 Effect 的
`ConfigProvider`，`!env` 和外掛自行讀取的 `Config` 都會用到它。這個檔案不會修改
`process.env`，所以直接讀取 `process.env` 的函式庫看不到其中的變數。

監看模式也會每秒重新讀取請求路徑，每次都重新解析符號連結。因此，目標位於設定目錄外、連結改指向或原生通知遺失時，也能偵測變更。只有內容改變才讓載入器重試；讀取失敗會記錄錯誤並保留先前的值，輪詢繼續。原生監看失敗後會記錄錯誤並重新安裝；關閉時的清理失敗也會記錄完整 cause。

不使用 `--watch`
時，CLI 會回報無效的初始設定及其 cause，命令以非零狀態結束。使用 `--watch`
時，CLI 會記錄第一次的失敗，並等待有效的設定，不會重新啟動。在讀到第一份有效文件之前，載入器可用，但沒有任何項目。透過 API 編輯時，仍會驗證檔案，不能覆蓋無效的文件。

使用
`--watch`（`-w`）時，載入器會獨立監看 YAML 設定的變更。只有設定目錄（包括子目錄）下的
`.js`、`.mjs`、`.cjs`、`.ts`、`.mts` 和 `.cts`
檔案變更，才會啟動[模組重載](../hot-reload/)。`node_modules`
中的檔案會被忽略。編輯 YAML 不會重新匯入所有項目，也不會重新啟動每個由模組載入的外掛。移除或停用設定項目時，會釋放它的模組租約。所以不再有人使用的無效模組，不會阻擋其他項目的重載。等待中和失敗的項目會保留租約。輪詢也會跟隨這些租約：它會保留失敗的匯入嘗試以便重試，並在最後一個擁有者關閉後，移除項目及其獨占的相依套件。假設原本共用的外掛匯出現在不同了，或者取代身分彼此衝突、或與既有的 alias 衝突。這時 CLI 會回報受影響的模組並要求重新啟動，執行中的外掛維持原狀。

CLI 使用帶有模組檔案過濾器的
`hmr.watch`。原生事件會快速啟動重載；每秒一次的內容檢查，則為已載入的模組補回漏掉的通知。每次重載嘗試以
`Reloaded` 或 `Skipped` 結束後，CLI 都會呼叫
`loader.retry`，重試先前載入失敗的項目。重載和重試的失敗會記錄完整的 cause，監看會繼續。watcher 的 I/O 失敗也會被記錄，並在一秒後重新安裝 watcher。關閉時的失敗也會被觀察：中斷與錯誤或 defect 合併的 cause 會完整記錄，只有單純的中斷才算正常取消。HMR 也會記錄在要求取消之後才完成的原生匯入失敗，避免它們被中斷掩蓋。

日誌以易讀的格式輸出。外掛寫出的每一行日誌，都帶有外掛名稱和 fork
id。CLI 為項目的 `intercept` 設定登記了
`effect/References/CurrentLogAnnotations`（與外層註解合併的物件）和
`effect/References/MinimumLogLevel`（取代最低日誌層級）。它們對該項目及其子外掛生效。[設定檔參考](../config-file/#設定項目欄位)列出了可接受的值和範例。無效的值會讓該項目以
`InvalidIntercept` 失敗。CLI 不登記其他 Reference。

## graft create

```sh
graft create <directory> [--name <name>] [--install]
```

在空的或新的目錄中建立新專案。它會產生
`package.json`、`graft.yml`、一個範例外掛和一個
`.gitignore`。套件名稱預設為目錄名稱。專案相依的 Graft 版本，與建立它的命令版本相同。`graft.yml`
會指向該版本的 [schema](../config-file/#編輯器支援)。

使用 `--install` 時，Graft 會在建立後安裝專案的相依套件。

## graft add

```sh
graft add <package...>
```

為目前目錄中的專案新增相依套件並安裝。每個套件可以指定版本範圍，例如
`graft-plugin-review@^1.2.0`；沒有指定時，Graft 使用最新版本。

## graft remove

```sh
graft remove <package...>
```

從目前目錄中的專案移除相依套件。

## 套件管理器

`add`、`remove` 和 `create --install` 使用專案的套件管理器。Graft 從
`package.json` 的 `packageManager`
欄位判斷它。如果沒有這個欄位，就看鎖定檔，再看執行 `graft`
的命令。如果都無法判斷，Graft 使用 npm。支援 npm、pnpm 和 Yarn，不支援 Yarn
Plug'n'Play。

安裝從開始到結束（包括復原過程），都需要專案的獨占寫入權。執行 `add`、`remove`
或 `create --install`
期間，請不要編輯專案檔案，也不要執行其他安裝程式。同一個 PackageManager 的呼叫會依序執行。Graft 不會用鎖來防止其他管理工具、編輯器或行程寫入。

如果安裝失敗或被中斷，Graft 會逐位元組還原已備份的套件檔案，包括 `package.json`
和鎖定檔。它也會移除安裝前不存在的、受追蹤的檔案。還原會覆蓋安裝期間所做的修改，不會偵測衝突，也不會合併編輯。

如果專案原本有所選套件管理器的鎖定檔，Graft 也會嘗試修復
`node_modules`。復原錯誤會和原始失敗一起回報。Graft 不保證行程當機後的復原。

受管理的套件檔案必須是一般檔案，或者不存在。Graft 會在安裝寫入任何東西之前，拒絕符號連結（包括懸空連結）和其他檔案類型。Windows 依現狀（as
is）提供：行程樹清理和還原都未經驗證，Graft 不作保證。

### 監看模式下需要重新啟動的情況

在兩種情況下，CLI 會回報
`Restart required`，而不是回報重載成功。第一種是原生載入能力（`node:module`，包括
`createRequire` 和快取的
`require(esm)`）。第二種是本地項目的符號連結改指向新的目標。所有既有的外掛都會繼續執行。符號連結的目標檢查也屬於定期檢查的一部分，所以相同的來源位元組和遺失的原生通知，都無法掩蓋目標的變更。
