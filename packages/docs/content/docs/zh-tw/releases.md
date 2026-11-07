---
title: 發佈
description: Graft 如何檢查、發佈到 npm 和 GitHub Packages，以及文件如何部署。
---

本頁寫給檢查或發佈 Graft 的貢獻者。

## 檢查

在專案的 devenv shell 中執行每一個命令：

```sh
devenv shell -- pnpm install
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm test:packages
```

進入該 shell 時會用 treefmt 格式化程式碼。`pnpm test:packages` 測試發佈腳本。

CLI 的建置也會寫出
`packages/cli/schema.json`，也就是[設定檔的 JSON Schema](../config-file/#編輯器支援)，由載入器的項目欄位和 CLI 登記的 intercept 產生。它不會提交到版本庫；每次發佈都會打包建置時產生的那一份。

`pnpm test`
會檢查所有發布入口是否引用了無法從公開入口存取的型別，並為不寫型別註記的使用範例產生宣告檔。檢查失敗時，應從公開簽名中移除實作細節，或補上公開契約型別的匯出；不要替範例加上註記來避開問題。

## GitHub Actions

工作流程 `.github/workflows/ci.yml` 會在 pull request、推送到 `main`，以及
`v1.2.3` 或 `v1.2.3-beta.0` 這類標籤時執行。

| 工作              | 執行時機   | 作用                                                 |
| ----------------- | ---------- | ---------------------------------------------------- |
| `check`           | 一律       | 檢查格式、建置、型別檢查、測試，並打包每個公開套件。 |
| `github-packages` | 推送和標籤 | 將打包好的檔案發佈到 GitHub Packages。               |
| `npm`             | 標籤       | 透過受信任的發佈，將打包好的檔案發佈到 npm。         |

發佈工作只會在 `check` 通過後執行。它們發佈的正是 `check`
打包並測試過的檔案，絕不會再次建置。

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

所有套件以同一個版本一起發佈。`pnpm packages:pack`
會在每個公開套件中設定該版本，將它們之間的相依項目固定到該版本，把套件打包到
`.release/`，並將每個檔案的雜湊寫入 `.release/release.json`。

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

1. 確認 `main` 通過 CI。
2. 為該 commit 加上標籤並推送，例如
   `v1.2.3`。Graft 還在 0.x 階段時直接發佈一般版本，例如
   `v0.3.0`：0.x 版本號本身就表示 API 可能變動，不需要再加 `-beta` 後綴。
   `v1.2.3-beta.0` 這類預發佈標籤仍可使用：

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

3. `npm` 工作會等待 `npm` 環境（如果它需要核准），然後發佈。

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
建置本站，並部署到Cloudflare
Worker：[docs.graft.land](https://docs.graft.land/)。最新的 15 個發佈 tag 和
`main` 上最新的 30 個 commit 還會各自保留當時的文件，每份文件是一個 **Worker
Preview**。

| 位址                                             | 內容                                          |
| ------------------------------------------------ | --------------------------------------------- |
| `https://docs.graft.land/`                       | **預設版本**：最新的穩定 tag，例如 `v1.2.3`。 |
| `https://<hash 前 12 位>.docs.graft.land/`       | 該 commit，在保留期間可用。                   |
| `https://versions.docs.graft.land/versions.json` | 所有保留的 commit，及其日期、標題和 tag。     |
| `https://graftland.github.io/graft/<path>`       | 重新導向到預設版本的 `<path>`。               |
| `https://graft-docs-ekb.pages.dev/<path>`        | 重新導向到預設版本的 `<path>`。               |

### 每次執行做什麼

| 觸發方式                        | 建置                                        | 之後                                                  |
| ------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| 推送到 `main`                   | 推送的 commit，以及保留範圍內還沒有文件的。 | 更新清單，並刪除不再保留的 commit 的文件。            |
| 推送 `v1.2.3` 這樣的 tag        | tag 指向的 commit，僅當它還沒有文件時。     | 為該 commit 標上 tag。更新的穩定 tag 會成為預設版本。 |
| 在 Actions 頁面手動執行         | 保留範圍內還沒有文件的 commit。             | 與推送相同。                                          |
| 在 Actions 頁面填寫 **rebuild** | 另外建置填寫的 commit，即使它們已有文件。   | 取代它們的文件並更新清單。                            |

- **保留範圍。** 最新 15 個發佈 tag（包括預發佈）指向的 commit、`main`
  上最新的 30 個 commit，以及預設版本。一個 commit 可以同時屬於兩者。其他 commit 的文件會被刪除，並移出清單。
- **每個 commit 只建置一次。**
  使用該 commit 自己的 lockfile 和工具鏈建置。新的預設版本會再建置一次，部署為正式網站。Cloudflare 只上傳它還沒有的檔案。
- **預設版本。** 與 npm 一樣，`v1.2.3-beta.0`
  這樣的預發佈版本不會成為預設版本。最後一次發佈之後 `main`
  上的 commit 會出現在清單中，但不是預設版本。只有發佈版本建置成功後，正式網站才會切換。
- **順序。** 各次執行逐一更新清單。
- **失敗。**
  無法建置的 commit 會被略過，其他 commit 照常部署；只要它還在保留範圍內，下次執行會再試。讀取線上清單失敗時，執行會停止，而不是新建一份清單。
- **搜尋引擎。** 只有正式網站會被收錄；每個 commit 的位址都帶有
  `X-Robots-Tag: noindex`。

### 切換版本

每個已部署的頁面都從版本位址載入下拉選單。

- **下拉選單。**
  在主題選擇器旁邊。依從新到舊列出所有保留的 commit，顯示 tag 或短 hash，並標出預設版本。選取後開啟同一頁面在該版本中的位址；當時還不存在的頁面會顯示該版本的 404 頁。
- **提示。** 其他 commit 的頁面頂端會說明這一點，並連結到預設版本中的同一頁面。

### 設定

| 工作                 | 方法                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 網域                 | `DOCS_URL` 所在網域的 zone 位於同一個 Cloudflare 帳號。首次執行會建立 `DOCS_WORKER` 指定的 Worker、該網域及其萬用字元憑證。                                      |
| `docs` 環境的 secret | `CLOUDFLARE_ACCOUNT_ID`，以及 `CLOUDFLARE_API_TOKEN`：帳號層級的 **Workers Scripts: Edit** 和 **Cloudflare Pages: Edit**，zone 層級的 **Workers Routes: Edit**。 |
| 舊位址               | 將儲存庫的 Pages 發佈來源設為 **GitHub Actions**。`DOCS_PAGES_PROJECT` 指定的 Cloudflare Pages 專案只保留重新導向。                                              |
| 本機開發文件網站     | `devenv shell -- pnpm --filter @graftland/docs dev`；下拉選單只出現在已部署的頁面上。                                                                            |

### 撰寫頁面

| 語言     | 資料夾                             |
| -------- | ---------------------------------- |
| 英文     | `packages/docs/content/docs`       |
| 簡體中文 | `packages/docs/content/docs/zh-cn` |
| 繁體中文 | `packages/docs/content/docs/zh-tw` |

- 每個資料夾使用相同的檔名。
- 頁面之間使用相對連結，例如 `../plugins/`，這樣連結才能在網站的 base
  path 下正常運作。
- 優先使用表格、編號步驟和簡短清單，而不是冗長的段落。頁面開頭先說明涵蓋的內容，結尾指出接下來可以去哪裡。
- 每個 README 旁邊都有 `README.zh-CN.md` 和 `README.zh-TW.md`
  翻譯，依英文 README 撰寫。如果你修改英文 README 或英文文件頁面，請在同一次變更中更新翻譯。
