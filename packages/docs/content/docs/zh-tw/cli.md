---
title: 命令列
description: graft 命令及其子命令。
---

`@graftland/cli` 套件提供 `graft` 命令。它需要 Node.js
22.19 或更新版本，與其 Effect Node 轉接器的要求一致。

| 命令                        | 作用                               | 章節                          |
| --------------------------- | ---------------------------------- | ----------------------------- |
| `graft start [config]`      | 執行設定檔所描述的應用程式。       | [graft start](#graft-start)   |
| `graft create [directory]`  | 建立新專案。                       | [graft create](#graft-create) |
| `graft add <package...>`    | 新增相依套件並安裝。               | [graft add](#graft-add)       |
| `graft remove <package...>` | 移除相依套件。                     | [graft remove](#graft-remove) |
| `graft schema`              | 寫入 `graft.yml` 的編輯器 Schema。 | [graft schema](#graft-schema) |
| `graft check [file]`        | 檢查清單是否符合宿主要求。         | [graft check](#graft-check)   |

`graft start` 同時支援 [remote 宿主](../remote/hosts/)與
[runner](../remote/runners/)。命令外掛可以加入 `graft remote certificates`
這樣的子命令，只有明確啟用後才會載入。

## 命令外掛

```sh
graft add --plugin remote
graft remote certificates --out ./certs --server localhost
graft add --plugin remote --global
```

`add --plugin` 安裝外掛套件，並啟用它的 `/cli`
項目。短名稱會改寫成 registry 中存在的那一個：`@graftland/plugin-<name>` 或
`graft-plugin-<name>`；兩者都存在時，請寫完整名稱。`--global`
將套件與項目放進[使用者設定](../config-file/#命令外掛)。

已啟用的命令會出現在 `--help` 與 `--completions bash`
中。內建命令名稱與別名不能占用；重名會阻止啟動。每次呼叫（包含說明）只載入一次命令外掛。`--no-plugins`
跳過探索，方便修正有問題的宣告。探索命令時不會執行一般應用程式項目。

`start --watch`
遇到無效的專案設定時，暫不載入其中的命令外掛，記錄原因後由應用程式監看器等待有效檔案；要載入修正後的命令項目，請重新啟動 CLI。

## graft start

```sh
graft start [config] [--watch] [--env-file <path>] [--env-dir <path>] [--stdio]
```

執行[設定檔](../config-file/)所描述的應用程式。`config` 預設為
`graft.yml`。行程會一直執行，直到收到 <kbd>Ctrl</kbd>+<kbd>C</kbd> 或
`SIGTERM`，然後依序卸載所有外掛。

### 協定輸出

只有一個 stdio listener 的 runner 使用
`graft start runner.yml --stdio`，[MCP 伺服器](../mcp-server/overview/)使用
`graft start --stdio`。載入外掛、處理說明與版本參數之前，stdout 就已保留給協定位元組。日誌、Console 輸出（包括 worker 輸出）、說明、版本與錯誤都寫入 stderr；此模式不提供互動精靈與補全輸出。runner 會拒絕不相符的 listener 設定。stdin
EOF 後，runner 停止執行單元，確認結束後退出行程；啟動或清理失敗時回傳非零結束碼。

### 選項

| 選項                | 作用                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `--watch`, `-w`     | 監看設定檔和外掛模組。請參閱[監看模式](#監看模式)。                                        |
| `--env-file <path>` | 為 [`!env`](../config-file/#環境變數) 標籤讀取 `.env` 檔案。請參閱 [Env 檔案](#env-檔案)。 |
| `--env-dir <path>`  | 為 `!env` 標籤讀取每個檔案代表一個變數的目錄。請參閱 [Env 目錄](#env-目錄)。               |

### Env 檔案

| 行為           | 說明                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| 路徑           | 相對路徑相對於目前的目錄。                                                                                            |
| 優先順序       | 行程環境中設定的變數優先於檔案，即使它被設為空字串。                                                                  |
| 檔案不存在     | 命令停止。                                                                                                            |
| 搭配 `--watch` | 儲存檔案時會重新讀取並重試載入器，因此值有變更的項目會被更新。如果檔案無法讀取，先前的值仍然有效。                    |
| 範圍           | 該檔案提供給 Effect 的 `ConfigProvider`，因此 `!env` 和外掛讀取的任何 `Config` 都會使用它。它不會改變 `process.env`。 |

搭配 `--watch` 時，`.env` 檔案也會輪詢，並在監看器失敗後恢復：

| 項目            | 行為                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `.env` 路徑輪詢 | 每秒重新讀取要求的路徑，並重新解析符號連結。這能偵測到儲存在設定目錄之外的目標、連結重新指向，以及漏掉的通知。 |
| 內容變更        | 只有內容變更才會重試載入器。                                                                                   |
| 讀取失敗        | 保留最後的值並記錄；輪詢繼續。                                                                                 |
| 監看器失敗      | 記錄。監看器會在一秒後重新安裝。                                                                               |

### Env 目錄

`graft start --env-dir /run/secrets` 讀取以檔案形式掛載的機密，例如 Docker
secrets 或 Kubernetes Secret 卷冊。

| 行為           | 說明                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| 變數           | 每個一般檔案是一個變數，以檔名命名。指向檔案的符號連結也算；隱藏項目和子目錄會被略過。                     |
| 值             | 檔案內容，去掉結尾的換行。空檔案設定空值。                                                                 |
| 優先順序       | 排在行程環境和 `--env-file` 之後。                                                                         |
| 目錄不存在     | 命令停止。                                                                                                 |
| 搭配 `--watch` | 和 [Env 檔案](#env-檔案)一樣監看並每秒輪詢。只有值變更才會重試載入器。如果目錄無法讀取，先前的值仍然有效。 |
| 路徑與範圍     | 與 Env 檔案相同。                                                                                          |

### 第一份設定無效

| 模式             | 行為                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未使用 `--watch` | CLI 回報 cause 並以非零狀態碼結束。                                                                                                               |
| 使用 `--watch`   | CLI 記錄第一次失敗，並等待有效的設定，不會重新啟動。載入器在讀取到第一份有效文件之前沒有任何項目，而透過其 API 進行的編輯仍然不能覆寫無效的文件。 |

### 監看模式

使用 `--watch` 時，CLI 會監看兩種變更：

| 變更                                                                                          | 處理者                                                           |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| YAML 設定                                                                                     | 載入器。請參閱[執行期間的變更](../config-file/#執行期間的變更)。 |
| 設定檔所在目錄下的 `.js`、`.mjs`、`.cjs`、`.ts`、`.mts` 和 `.cts` 檔案（不含 `node_modules`） | 增量的[模組重載](../hot-reload/)。                               |

兩者的互動方式：

- 編輯 YAML 不會重新匯入所有項目，也不會重新啟動所有來自模組的外掛。未變更的健康項目及其環境變數值不受影響。
- 移除或停用項目會釋放它的模組租約，因此沒有人使用的無效模組不會阻擋其他項目的重載。等待中和失敗的項目保留它們的租約。
- 如果原本共用的外掛匯出現在不同，或取代的身分發生衝突，CLI 會回報受影響的模組並要求重新啟動。執行中的外掛保持不變。

CLI 驅動重載的方式：

1. 它以模組檔案過濾器呼叫 `hmr.watch`。
2. 每次嘗試以 `Reloaded`、`RolledBack`、`RecoveryFailed` 或 `Skipped`
   結束後，它會呼叫 `loader.retry`，以重試失敗的項目並重新整理 `!env`
   值。`RolledBack` 會為每個啟動失敗或逾時的外掛記錄一則警告，帶有 `graft.fork`
   和 `graft.plugin`；啟動失敗時還帶有其 `Cause`。 `RecoveryFailed`
   會將取代及恢復失敗都記錄為錯誤，帶有相同註記和完整 cause，並明確指出舊程式碼重新啟動失敗。
3. 重載和重試的失敗會連同完整的 `Cause` 一併記錄，監看繼續進行。

YAML 和模組監看器使用原生檔案系統通知，不做輪詢。YAML 監看器安裝後會重新讀取檔案，以捕捉安裝期間的變更。任一監看器的後端失敗時，只記錄錯誤，不會重新安裝該監看器。

關閉時的失敗會連同完整的 `Cause`
一併記錄。同時包含中斷與錯誤或 defect 的 cause 會完整記錄；單純的中斷屬於正常取消。

變更如何被偵測，請參閱[熱重載](../hot-reload/#變更偵測)。

### 需要重新啟動的情況

在兩種情況下，CLI 會回報
`Restart required`，而不是成功重載。所有現有外掛都會繼續執行。

| 情況                                                                            |
| ------------------------------------------------------------------------------- |
| 原生載入能力（`node:module`，包括 `createRequire` 和已快取的 `require(esm)`）。 |
| 本機的入口或輔助符號連結指向新的目標。                                          |

已知的原生載入需求即使沒有檔案事件也會回報，因此漏掉啟動時的通知不會讓這項限制被默默忽略。未變更的週期性回報會被抑制。符號連結目標的檢查屬於週期性檢查的一部分，所以相同的原始碼位元組和遺失的原生通知都無法掩蓋目標的變更。

### 日誌與 intercept

日誌以易讀的格式輸出。外掛寫出的每一行都帶有外掛的名稱和 fork
id。如需 JSON 輸出或匯出 span，請嵌入 Graft，見[在宿主中選擇輸出](../best-practices/observability/#在宿主中選擇輸出)。

CLI 為項目的 `intercept` 設定登記了兩個 Reference，對該項目及其子外掛生效：

| Reference                                 | 行為                   |
| ----------------------------------------- | ---------------------- |
| `effect/References/CurrentLogAnnotations` | 與外層註解合併的物件。 |
| `effect/References/MinimumLogLevel`       | 取代用的日誌層級。     |

可接受的值和範例列在[設定檔頁面](../config-file/#設定檔中的-intercept)。無效的值會讓該項目以
`InvalidIntercept` 失敗。CLI 不會登記其他 Reference。

共用 HTTP 監聽器使用一般的 `graft start` 載入 [HTTP 伺服器](../http/)，不需要
`--stdio`。

## graft create

```sh
npm create @graftland@latest [directory] [-- <options>]
graft create [directory] [options]
```

建立新專案。這兩個命令是同一個命令。在終端機中，它會問幾個問題，每個問題都有預設值，按
<kbd>Enter</kbd> 即可接受。使用
`--yes`，或 stdin、stdout 不是終端機時，它不提問，**每個問題都採用預設值**。

| 選項                                  | 問題                                   | 預設值                                               |
| ------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| `[directory]`                         | 專案建立在哪裡。                       | `graft-app`                                          |
| `--template`, `-t`                    | 使用哪個[範本](#範本)。                | `app`                                                |
| `--name <package>`                    | 只在 `plugin` 範本時詢問。             | 目錄名稱；`plugin` 範本為 `graft-plugin-<directory>` |
| `--plugin <package>`                  | 不詢問。重複使用可加入多個外掛。       | 無                                                   |
| `--package-manager <npm\|pnpm\|yarn>` | 不詢問。加上 `@<version>` 可記錄版本。 | 執行此命令的套件管理器，否則為 npm                   |
| `--install`, `--no-install`           | 是否安裝相依套件。                     | 是                                                   |
| `--git`, `--no-git`                   | 是否執行 `git init`。                  | 是                                                   |
| `--yes`, `-y`                         | 全部採用預設值。                       |                                                      |

| 規則                | 行為                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 目標目錄            | 必須是新目錄、空目錄，或只含 `.git` 和 `.DS_Store`，因此在剛複製的儲存庫中也能使用 `.`。否則它會要求換一個目錄；無法提問時以 `CreateError` 失敗。它從不刪除或取代檔案。                                                  |
| 先問完再寫入        | 所有問題都在寫入任何內容之前提出。按 <kbd>Ctrl</kbd>+<kbd>C</kbd> 會輸出 `Cancelled`，以非零狀態碼結束，磁碟上不留下任何東西。                                                                                           |
| `--plugin`          | 接受 `name` 或 `name@range`；短名稱的對應方式與 `graft add --plugin` 相同。套件加入 `dependencies`，並在 `graft.yml` 中得到一個 `- name:` 項目。未指定範圍時，Graft 自己的外掛使用 Graft 的版本，其他外掛使用 `latest`。 |
| `--package-manager` | 帶版本時（例如 `pnpm@9.15.9`），版本會寫入 `package.json` 的 `packageManager` 欄位。                                                                                                                                     |
| Git                 | 只執行 `git init`，不建立第一個 commit。專案位於儲存庫內或未安裝 git 時會略過，並說明原因。                                                                                                                              |
| Schema              | 安裝完成後，由專案自己的 `@graftland/cli` 執行 [`graft schema`](#graft-schema)。                                                                                                                                         |
| 完成之後            | 輸出接下來要執行的命令，例如 `cd my-app` 和 `pnpm dev`，包括被略過或失敗的安裝、`graft schema` 或 `git init`。任一步驟失敗時會保留專案，並以非零狀態碼結束。                                                             |

### 範本

| 範本      | 用途                                                                              | `package.json` 與 `graft.yml` 以外的檔案                                                                                           |
| --------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `app`     | 應用程式。`graft.yml` 載入範例外掛：`hello`，以及使用 `greeter` 服務的 `ticker`。 | `src/hello.ts`、`src/greeter.ts`、`src/ticker.ts`、`tsconfig.json`、`README.md`、`.vscode/extensions.json`、`.gitignore`           |
| `plugin`  | 要[發布](../plugins/#發布外掛)的外掛套件。                                        | `src/index.ts`、`test/index.test.ts`、`tsconfig.json`、`tsconfig.build.json`、`README.md`、`.vscode/extensions.json`、`.gitignore` |
| `minimal` | 只有設定檔，除了 `--plugin` 加入的項目之外沒有其他項目。                          | `.gitignore`                                                                                                                       |

| 指令碼      | `app`                 | `plugin`                                   | `minimal`             |
| ----------- | --------------------- | ------------------------------------------ | --------------------- |
| `dev`       | `graft start --watch` | `graft start --watch`，載入 `src/index.ts` | `graft start --watch` |
| `start`     | `graft start`         |                                            | `graft start`         |
| `test`      |                       | `vitest run`                               |                       |
| `typecheck` | `effect-tsgo tsc`     | `effect-tsgo tsc`                          |                       |
| `build`     |                       | 將 `src` 編譯到 `dist`                     |                       |

- 每個專案相依的 Graft 版本都與此命令相同，`graft.yml`
  也指向專案的[編輯器 Schema](../config-file/#編輯器支援)
  `./graft.schema.json`。
- Node 直接執行 `app` 的 TypeScript，因此沒有建置步驟。`plugin`
  套件需要建置，因為 Node 不會移除 `node_modules` 內檔案的型別。
- `.vscode/extensions.json` 推薦 YAML 擴充功能，它會依 Schema 補全
  `graft.yml`。TypeScript 專案還會在 `typecheck` 中回報 Effect 診斷。

## graft add

```sh
graft add <package...>
graft add --plugin <name> [--global]
```

將相依套件新增到目前目錄的專案並安裝。每個套件都可以附帶版本範圍，例如
`graft-plugin-review@^1.2.0`。沒有指定時，Graft 使用最新版本。

## graft remove

```sh
graft remove <package...>
```

從目前目錄的專案中移除相依套件。

## graft schema

```sh
graft schema [--output <file>]
```

為目前目錄的專案寫入 `graft.schema.json`，也就是 `graft.yml`
的[編輯器 Schema](../config-file/#編輯器支援)。除了隨版本發布的 Schema 檢查的內容，它還會檢查每個已安裝且登記了設定的外掛的
`config`。

| 情況             | 行為                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 哪些套件         | `dependencies`、`devDependencies` 與 `optionalDependencies` 中，把 `@graftland/graft` 列為相依或 peer，並匯出 [`./schema`](../best-practices/packaging/#編輯器自動補全) 的套件。 |
| 匯入什麼         | 只匯入它們的 `./schema` 模組，不載入任何外掛。                                                                                                                                   |
| 相依套件未安裝   | 輸出警告，其設定保持開放。                                                                                                                                                       |
| `./schema` 無效  | `SchemaRegistrationError` 指出是哪個套件，不寫入檔案。                                                                                                                           |
| 保持最新         | 專案已有 `graft.schema.json` 時，`graft add` 與 `graft remove` 會在安裝後重寫它，失敗則以非零狀態碼結束。`graft create` 會寫入它。                                               |
| `--output`、`-o` | 寫入的路徑，預設為 `graft.schema.json`。                                                                                                                                         |

直接用套件管理器安裝或升級套件後，請自行執行。

## 套件管理器

`add` 和 `remove` 使用專案的套件管理器。`create` 使用
`--package-manager`，否則使用執行它的套件管理器，再否則使用 npm。

`add` 和 `remove` 依下列順序偵測：

1. `package.json` 的 `packageManager` 欄位。
2. 鎖定檔。
3. 執行 `graft` 的命令。
4. 以上都無法判斷時，使用 npm。

支援 npm、pnpm 和 Yarn，不支援 Yarn Plug'n'Play。

### 安裝的所有權

安裝在完成之前（包括復原）需要獨佔專案的寫入權限。

- 在 `add`、`remove` 或 `create`
  安裝期間，請不要編輯專案檔案或執行其他安裝程式。
- 透過同一個 PackageManager 的呼叫會依序執行。Graft 不會對其他管理器、編輯器或行程使用鎖。

### 還原

| 情況                   | 行為                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| 安裝失敗或被中斷       | Graft 會逐位元組還原已備份的套件檔案（包括 `package.json` 和鎖定檔），並移除先前不存在、但被追蹤的檔案。 |
| 安裝期間進行的變更     | 還原會覆寫它們。不會偵測衝突，也不會合併編輯。                                                           |
| 專案有此管理器的鎖定檔 | Graft 也會嘗試修復 `node_modules`。                                                                      |
| 復原錯誤               | 與原始失敗一併回報。                                                                                     |
| 行程當機               | Graft 不保證能復原。                                                                                     |

受管理的套件檔案必須是一般檔案，或不存在。Graft 會在安裝寫入任何內容之前，拒絕符號連結（包括懸空連結）和其他檔案類型。

:::note

Windows 以現狀提供：行程樹清理和還原未經驗證，Graft 不作保證。

:::

## 受管理的升級

`graft start` 與嵌入式宿主使用相同的公開 Loader 和驅動 API，載入
[受管理的 Remote 項目](../config-file/#受管理的整合)。由應用程式提供操作端點，使用項目 id 呼叫
`Graft.transition`。CLI 沒有內建 transition 子命令。 `--watch`
不升級受管理的單元：HMR 跳過含受管理實例的執行環境，Loader 在改變目標前拒絕受管理樹的更新。

## graft check

```sh
graft --no-plugins check graft.check.json
```

載入前將已發布清單與明確宿主描述進行比較。路徑相對於預檢檔，預設檔名為
`graft.check.json`。
[相容性檢查](../ecosystem/compatibility/)說明檔案格式與診斷。檢查不安裝套件，也不改變應用程式設定。

## graft remote manifest

```sh
graft remote manifest ./release
graft remote manifest ./release --check --provenance ./provenance.json
```

由已啟用的 `remote/cli` 命令外掛提供。從已建置宣告產生或驗證 `graft`
欄位，並可記錄套件來源。發布流程見[外掛清單](../ecosystem/manifest/)。
