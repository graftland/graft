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

命令插件提供明確啟用的子命令。

## 命令外掛

```sh
graft add --plugin example
graft add --plugin example --global
```

`add --plugin` 安裝外掛套件，並啟用它的 `/cli`
項目。短名稱會改寫成 registry 中存在的那一個：`@graftland/plugin-<name>` 或
`graft-plugin-<name>`；兩者都存在時，請寫完整名稱。`--global`
將套件與項目放進[使用者設定](../config-file/#命令外掛)。

已啟用的命令會出現在 `--help` 與 `--completions bash`
中。內建命令名稱與別名不能占用；重名會阻止啟動。每次呼叫（包含說明）只載入一次命令外掛。`--no-plugins`
跳過探索，方便修正有問題的宣告。探索命令時不會執行一般應用程式項目。

## graft start

```sh
graft start [config] [--env-file <path>] [--env-dir <path>]
```

執行[設定檔](../config-file/)所描述的應用程式。`config` 預設為
`graft.yml`。行程會一直執行，直到收到 <kbd>Ctrl</kbd>+<kbd>C</kbd> 或
`SIGTERM`，然後停止所有單元，並等待其結束證據。

`graft start`
行程只執行核心，不匯入任何外掛、命令外掛或契約模組。Loader 單元讀取檔案的一個版本，在一次性單元中檢查每個項目，再把所有項目作為一個[變更](../transitions/)提交。每個項目在 Worker 單元中執行。

### 協定輸出

`graft start --stdio`
會被拒絕：外掛在單元中執行，沒有外掛擁有行程的標準輸入輸出。若要透過 stdio 執行
[MCP 伺服器](../mcp-server/overview/)，請在直接[嵌入](../embedding/)的應用程式中執行。

### 選項

| 選項                | 作用                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `--env-file <path>` | 為 [`!env`](../config-file/#環境變數) 標籤讀取 `.env` 檔案。請參閱 [Env 檔案](#env-檔案)。 |
| `--env-dir <path>`  | 為 `!env` 標籤讀取每個檔案代表一個變數的目錄。請參閱 [Env 目錄](#env-目錄)。               |

### Env 檔案

| 行為       | 說明                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| 路徑       | 相對路徑相對於目前的目錄。                                                                                            |
| 優先順序   | 行程環境中設定的變數優先於檔案，即使它被設為空字串。                                                                  |
| 檔案不存在 | 命令停止。                                                                                                            |
| 範圍       | 該檔案提供給 Effect 的 `ConfigProvider`，因此 `!env` 和外掛讀取的任何 `Config` 都會使用它。它不會改變 `process.env`。 |

### Env 目錄

`graft start --env-dir /run/secrets` 讀取以檔案形式掛載的機密，例如 Docker
secrets 或 Kubernetes Secret 卷冊。

| 行為       | 說明                                                                                   |
| ---------- | -------------------------------------------------------------------------------------- |
| 變數       | 每個一般檔案是一個變數，以檔名命名。指向檔案的符號連結也算；隱藏項目和子目錄會被略過。 |
| 值         | 檔案內容，去掉結尾的換行。空檔案設定空值。                                             |
| 優先順序   | 排在行程環境和 `--env-file` 之後。                                                     |
| 目錄不存在 | 命令停止。                                                                             |
| 路徑與範圍 | 與 Env 檔案相同。                                                                      |

### 第一份設定無效

CLI 回報 cause，並以非零狀態碼結束。

### 監看模式

不支援 `--watch` 和
`-w`。啟動時讀取一個設定版本。修改模組後重新建置並重新啟動行程，使變更生效。

### 需要重新啟動的情況

設定、環境來源或已安裝套件改變後需要重新啟動。直接嵌入的應用程式可使用協作式
[HMR API](../hmr-api/)，但它不提供核心隔離或依靠終止完成的資源回收。

### 日誌與 intercept

日誌以易讀的格式輸出。外掛寫出的每一行都帶有外掛名稱與 fork
id。需要 JSON 輸出或匯出 span 時請嵌入 Graft，見[在宿主中選擇輸出](../best-practices/observability/#在宿主中選擇輸出)。

使用 `isolate`、`inject` 或 `intercept` 的項目會在任何東西執行之前以
`DeploymentUnsupported` 拒絕。命令項目（`cli: true`）不參與部署。

若要共用 HTTP 監聽器，以一般的 `graft start` 載入 [HTTP 伺服器](../http/)。

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

| 範本      | 用途                                                                              | `package.json` 與 `graft.yml` 以外的檔案                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`     | 應用程式。`graft.yml` 載入範例外掛：`hello`，以及使用 `greeter` 服務的 `ticker`。 | `src/hello.ts`、`src/greeter.ts`、`src/ticker.ts`、`tsconfig.json`、`tsconfig.build.json`、`README.md`、`README.zh-CN.md`、`README.zh-TW.md`、`.vscode/extensions.json`、`.gitignore` |
| `plugin`  | 要[發布](../plugins/#發布外掛)的外掛套件。                                        | `src/index.ts`、`test/index.test.ts`、`tsconfig.json`、`tsconfig.build.json`、`README.md`、`.vscode/extensions.json`、`.gitignore`                                                    |
| `minimal` | 只有設定檔，除了 `--plugin` 加入的項目之外沒有其他項目。                          | `.gitignore`                                                                                                                                                                          |

| Script      | `app`                                       | `plugin`                                    | `minimal`     |
| ----------- | ------------------------------------------- | ------------------------------------------- | ------------- |
| `dev`       | `tsc -p tsconfig.build.json && graft start` | `tsc -p tsconfig.build.json && graft start` |               |
| `start`     | `graft start`                               |                                             | `graft start` |
| `test`      |                                             | `vitest run`                                |               |
| `typecheck` | `effect-tsgo tsc`                           | `effect-tsgo tsc`                           |               |
| `build`     | `tsc -p tsconfig.build.json`                | `tsc -p tsconfig.build.json`                |               |

- 每個專案相依的 Graft 版本都與此命令相同，`graft.yml`
  也指向專案的[編輯器 Schema](../config-file/#編輯器支援)
  `./graft.schema.json`。
- `app` 和 `plugin` 將 TypeScript 編譯到
  `dist`。設定選擇建置後的 JavaScript 檔案，擷取的產物可在原生單元中執行。
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
