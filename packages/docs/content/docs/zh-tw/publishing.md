---
title: 發版
description: 新增 changeset、審核版本更新，並發佈 Graft 套件與發佈說明。
---

Graft 使用 **Changesets**
記錄使用者可見的變更，準備套件版本與變更日誌。維護者推送相符的版本標籤後，CI 發佈已通過檢查的套件。

## 檢查

從版本庫根目錄透過專案的 devenv shell 執行命令：

```sh
devenv shell -- pnpm install --frozen-lockfile
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm vitest run --project <package>
devenv shell -- pnpm test:packages
```

進入 shell 時 treefmt 會格式化檔案。執行所改套件的測試；`pnpm test:packages`
檢查打包、發佈與發佈說明。

## 新增 changeset

修改公開套件的 pull request 應附上 changeset：

```sh
devenv shell -- pnpm changeset
```

| 選項       | 規則                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| 套件       | 選取受影響的公開套件。所有公開的 `@graftland/*` 套件屬於同一固定群組，使用相同版本。                 |
| 版本增量   | 修正用 `patch`，功能用 `minor`；破壞性變更需註明並提供遷移步驟。0.x 階段的破壞性變更使用次版本增量。 |
| 摘要       | 描述使用者可見的行為。將 **Breaking** 變更放在最前面，說明如何遷移。                                 |
| 私有工作區 | 範例、文件和基準測試既不更新版本，也不建立標籤。                                                     |
| 無公開變更 | 只修改文件或測試的 pull request 不需要 changeset。                                                   |

將產生的 `.changeset/*.md` 與變更一起提交。用
`devenv shell -- pnpm changeset status` 檢查待發佈的版本。

## Version Packages pull request

推送到 `graftland/graft` 的 `main` 後，`.github/workflows/release.yml`
會建立或更新 **Version
Packages**。它消耗待發佈的 changeset，更新套件版本並產生各公開套件的
`CHANGELOG.md`。先審核並合併該 pull
request，再建立標籤。此工作流程不發佈套件、不建立 GitHub
Release，也不在 fork 中執行。

在版本庫的 Actions 設定中啟用 **Allow GitHub Actions to create and approve pull
requests**。工作流程使用 `GITHUB_TOKEN`；有寫入權限的維護者需在產生的 pull
request 上選取 **Approve workflows to run**，在合併前啟動檢查。

## GitHub Actions

`.github/workflows/ci.yml` 在 pull request、推送到 `main` 和
`v1.2.3`、`v1.2.3-beta.0` 等版本標籤時執行。

| 工作              | 時機                                 | 作用                                                        |
| ----------------- | ------------------------------------ | ----------------------------------------------------------- |
| `check`           | 一律                                 | 檢查格式、建置、型別檢查、測試發佈腳本並打包公開套件。      |
| `test`            | 一律                                 | 測試所有套件和範例。                                        |
| `github-packages` | 推送和標籤，`check` 與 `test` 通過後 | 將已檢查的檔案發佈到 GitHub Packages。                      |
| `npm`             | 標籤，`check` 與 `test` 通過後       | 透過受信任發佈將已檢查的檔案發佈到 npm。                    |
| `github-release`  | 標籤，`npm` 成功後                   | 彙整所有公開套件的該版本變更日誌，建立一個 GitHub Release。 |

發佈直接使用 `check`
打包的檔案，不再建置。發佈說明會合併相同條目，並標明所屬套件。預發佈標籤建立預發佈 GitHub
Release。重新執行時保留已有的 GitHub Release。

### 發佈佇列

每個 registry 都有固定的工作並行群組，設定為 `cancel-in-progress: false` 和
`queue: max`。

| Registry        | 群組                      |
| --------------- | ------------------------- |
| npm             | `publish-npm`             |
| GitHub Packages | `publish-github-packages` |

- **範圍。**
  群組涵蓋整個發佈工作：讀取標籤、選擇標籤、上傳套件和處理重試。不同版本不能在同一個 registry 上混用這些操作。
- **獨立性。** 兩個 registry 有各自獨立的佇列，可以同時發佈。
- **順序。**
  佇列順序依工作開始等待的時間，而不是版本順序，所以仍然需要版本比較。
- **容量。** 使用 `queue: max`
  時，[GitHub 並行佇列](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)最多保留 100 個等待中的工作。佇列已滿時，GitHub 會取消多出來的工作，所以請檢查 Actions 的執行紀錄中是否有被取消的發佈工作，並在佇列清空後重新執行。沒有
  `queue: max` 時，GitHub 只保留一個等待中的工作，第三個工作會取代它。

:::caution

並行群組只協調本版本庫的 CI 工作。手動發佈或變更標籤之前，請等該 registry 所有執行中和排隊中的工作都結束，並在手動作業完成之前，停止新的發佈工作。其他發佈這些套件的工作流程必須使用同一個群組。

:::

## 版本

所有公開套件共用一個已提交的版本。打包發佈標籤時，每個公開套件的 `package.json`
版本都必須與標籤一致；不一致時在打包前停止。快照版本由 commit 衍生。`pnpm packages:pack`
將公開套件之間的相依項目固定到打包版本，把檔案及其完整性雜湊寫入 `.release/`。

| 事件                   | 版本                       | npm 標籤                | 發佈到                 |
| ---------------------- | -------------------------- | ----------------------- | ---------------------- |
| 推送到 `main`          | `0.0.0-commit-<full hash>` | `sha-<full hash>`       | GitHub Packages        |
| `v1.2.3-beta.0` 類標籤 | `1.2.3-beta.0`             | `alpha`、`beta` 或 `rc` | GitHub Packages 和 npm |
| `v1.2.3` 類標籤        | `1.2.3`                    | `latest`                | GitHub Packages 和 npm |

### 安裝預發佈版本或快照

預發佈標籤會指明它的頻道：`alpha`、`beta` 或
`rc`，後面接一個數字。它的套件放在該頻道的 npm 標籤之下，絕不會成為
`latest`，所以 `npm install @graftland/graft` 仍然安裝最後一個穩定版本。

| 你想要…                | 執行                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| 預發佈版本             | `npm install @graftland/graft@beta`                                                           |
| `main` 的任一個 commit | `npm install @graftland/graft@0.0.0-commit-<full hash> --registry=https://npm.pkg.github.com` |

commit 快照請使用工作流程執行時的版本。即使是公開套件，GitHub
Packages 也需要具有 `read:packages`
的 token。首次發佈到那裡的套件可能是私有的；請在 GitHub 的套件設定中設定一次可見性。

## 發佈保證

### 重試

你可以在同一個 registry 佇列下重新執行發佈。

| 情況                 | npm                                                                          | GitHub Packages                                  |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| 版本已存在且內容相同 | 略過。標籤不會變更。                                                         | 略過。如果不會讓標籤倒退，它可以修復其頻道標籤。 |
| 版本已存在但內容不同 | 腳本停止。                                                                   | 腳本停止。                                       |
| 標籤遺失或被外部變更 | 具有標籤權限的維護者在相同的獨佔發佈規則下另行修復。重新執行工作不會修復它。 | 如上所述修復。                                   |

npm 受信任的發佈者只有發佈權限，所以重試絕不會呼叫 `npm dist-tag`。

### 頻道不會倒退

因為發佈一次只執行一個，`latest`、`alpha`、`beta` 和 `rc` 絕不會退回較舊的版本。

- 首次上傳和 GitHub 標籤修復，使用同一種
  [SemVer 優先順序](https://semver.org/#spec-item-11)，與目標頻道目前的版本比較。
- 數字型的預發佈識別符以數字比較（`beta.10` 比 `beta.2`
  新）。主版本、次版本和修補版本先於預發佈序列。建置中繼資料不影響優先順序。
- 腳本以明確的 `@<channel>` 選擇器讀取完整的 `dist-tags`
  物件，因此只有預發佈版本的套件不需要 `latest` 標籤。
- 頻道不存在（E404）時可以建立。只有預發佈版本的套件還沒有 `latest`，這時改用
  `npm dist-tag ls` 讀取它的標籤，第一個正式版本同樣會建立
  `latest`。成功但內容為空或格式錯誤的回應會讓發佈停止。
- 再次執行頻道上已有的版本，標籤保持不變。

### 較晚的上傳

如果新上傳的版本比該頻道目前的版本舊，Graft 仍會用後備標籤發佈該套件：

| 發佈類型 | 後備標籤                                           |
| -------- | -------------------------------------------------- |
| 穩定版   | `backport`                                         |
| 預發佈版 | `alpha-backport`、`beta-backport` 或 `rc-backport` |

這些標籤標示較晚的上傳，不保證會跟隨最新版本。要安裝較舊的版本，請使用確切的版本號。再次執行較舊的既有版本，不會移動它的頻道，也不會修復後備標籤。例如，如果你在
`0.2.0-beta.1` 之前發佈 `0.2.0-beta.2`，或之後再次執行 `beta.1`，`beta` 仍停留在
`beta.2`。

:::note

直接並行執行發佈腳本沒有鎖，也不提供頻道保證。你仍然需要 registry 佇列；單靠版本比較無法讓 registry 的讀寫成為原子操作。

:::

## 發佈版本

1. **合併** Version Packages pull request，等待 `main` 通過 CI。
2. **標記** 該 commit，標籤版本與已提交的套件版本相同，然後推送標籤：

   ```sh
   git tag v0.6.0
   git push origin v0.6.0
   ```

3. **檢查** 標籤的 CI 執行。如果 `npm` 環境需要核准，`npm`
   工作會先等待；npm 成功後，`github-release` 建立合併的 GitHub Release。

Graft 在 0.x 階段使用 `v0.6.0` 這類一般版本。準備 `alpha`、`beta` 或 `rc`
預發佈時，使用 Changesets 的預發佈模式，讓清單和變更日誌先包含正確的預發佈版本：

```sh
devenv shell -- pnpm changeset pre enter beta
devenv shell -- pnpm changeset-version
```

審核並合併這些變更後再建立 `v0.6.0-beta.0` 標籤。該系列可以發佈穩定版時，執行
`devenv shell -- pnpm changeset pre exit`，讓 Version
Packages 準備穩定版本。不要與自動 pull request 同時手動更新套件版本。

### 受信任的發佈

`npm`
工作使用 npm 的[受信任發佈](https://docs.npmjs.com/trusted-publishers)：npm 接受工作流程執行的 OIDC
token，而不是存取 token，並為每個套件加上來源證明。版本庫不保存任何機密。每個套件都信任
`npm` 環境中 `graftland/graft` 的 `ci.yml` 工作流程：

```sh
npm trust github @graftland/graft --file ci.yml --repo graftland/graft --env npm --allow-publish
npm trust list @graftland/graft
```

### 發佈新套件

npm 只能信任已經存在的套件。維護者要先用 CI 打包的檔案發佈一次新套件，之後再設定信任：

```sh
gh run download <run id> --name packages-<commit hash> --dir .release
npm login
devenv shell -- pnpm packages:publish npm
```

## 文件網站

工作流程 `.github/workflows/docs.yml` 從 `packages/docs`
建置本網站，並部署到Cloudflare
Pages：[graft-docs-ekb.pages.dev](https://graft-docs-ekb.pages.dev/)。`main`
上的每個 commit 和每個發佈 tag 都會保留當時的文件。

| 位址                                                      | 內容                                                |
| --------------------------------------------------------- | --------------------------------------------------- |
| `https://graft-docs-ekb.pages.dev/`                       | **預設版本**：有文件的最新穩定 tag，例如 `v1.2.3`。 |
| `https://<hash 前 12 碼>.graft-docs-ekb.pages.dev/`       | 該 commit，永久保留。                               |
| `https://versions.graft-docs-ekb.pages.dev/versions.json` | 所有已部署的 commit，及其日期、標題和 tag。         |
| `https://graftland.github.io/graft/<path>`                | 重新導向到預設版本的 `<path>`。                     |

### 每次執行做什麼

| 觸發方式                         | 建置                                                                | 之後                                                  |
| -------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| 推送到 `main`                    | 推送的 commit。                                                     | 加入清單。                                            |
| 推送 `v1.2.3` 這類 tag           | tag 指向的 commit，僅在它還沒有文件時。                             | 為該 commit 標上 tag。較新的穩定 tag 會成為預設版本。 |
| 在 Actions 分頁勾選 **backfill** | 文件網站出現以來 `main` 上的每個 commit 和每個 tag 中還沒有文件的。 | 加入清單。                                            |
| 在 Actions 分頁填寫 **rebuild**  | 填寫的 commit，即使它們已有文件。                                   | 取代它們的部署並更新清單。                            |

- **每個 commit 只建置一次。**
  使用該 commit 自己的 lockfile 與工具鏈建置，上傳後不再取代。正式位址直接提供預設版本自己的部署，所以切換預設版本不會上傳任何建置。
- **預設版本。** 與 npm 相同，`v1.2.3-beta.0`
  這類預發佈版本不會成為預設版本。最後一次發佈之後 `main`
  上的 commit 會出現在清單中，但不是預設版本。
- **順序。**
  各次執行逐一更新清單。預設版本一律是有文件的最高穩定版本，較晚完成的執行不會讓它倒退。
- **失敗。**
  已經無法建置的 commit 會被略過，其他 commit 照常部署。讀取線上清單失敗時，執行會停止，而不是建立新的清單。
- **上限。** 一次 backfill 最多建置 256 個 commit，其餘的再執行一次。

### 切換版本

每個已部署的頁面都從版本位址載入下拉選單，所以在它出現之前建置的版本也有。

- **下拉選單。**
  在主題選單旁邊。由新到舊列出所有已部署的 commit，顯示 tag 或短 hash，並標出預設版本。選取後開啟同一頁面在該版本中的位址；當時還不存在的頁面會顯示該版本的 404 頁。
- **提示。** 其他 commit 的頁面頂端會說明這一點，並連結到預設版本中的同一頁面。

### 設定

| 任務                 | 做法                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare 專案      | 執行一次 `npx wrangler pages project create graft-docs --production-branch main`，再把 Cloudflare 分配的 `*.pages.dev` 名稱填入工作流程的 `DOCS_PAGES_HOST` 和 `DOCS_URL`。 |
| `docs` 環境的 secret | `CLOUDFLARE_API_TOKEN`（需要 **Cloudflare Pages: Edit** 權限）和 `CLOUDFLARE_ACCOUNT_ID`。                                                                                  |
| 舊位址               | 將版本庫的 Pages 來源設為 **GitHub Actions**。                                                                                                                              |
| 補齊以前的文件       | 在 Actions 分頁對 `main` 手動執行該工作流程，並勾選 **backfill**。                                                                                                          |
| 在本機處理網站       | `devenv shell -- pnpm --filter @graftland/docs dev`；下拉選單只出現在已部署的頁面上。                                                                                       |

### 撰寫頁面

| 語言     | 資料夾                             |
| -------- | ---------------------------------- |
| 英文     | `packages/docs/content/docs`       |
| 簡體中文 | `packages/docs/content/docs/zh-cn` |
| 繁體中文 | `packages/docs/content/docs/zh-tw` |

- 每個資料夾使用相同的檔名。
- 頁面之間使用相對連結，例如 `../plugins/`，這樣連結才能在網站的 base
  path 下正常運作。
- 優先使用表格、編號步驟和簡短清單，而不是冗長的段落。每個事實只寫一次，內容結束即結束。
- 每個 README 旁邊都有 `README.zh-CN.md` 和 `README.zh-TW.md`
  翻譯，依英文 README 撰寫。如果你修改英文 README 或英文文件頁面，請在同一次變更中更新翻譯。
