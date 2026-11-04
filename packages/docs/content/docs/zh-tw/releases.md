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
- 頻道不存在（E404）時可以建立。成功但內容為空或格式錯誤的回應會讓發佈停止。
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

工作流程 `.github/workflows/docs.yml` 在每次推送到 `main` 時，從 `packages/docs`
建置本網站，並部署到 GitHub
Pages：[graftland.github.io/graft](https://graftland.github.io/graft/)。你也可以從 Actions 分頁手動啟動它。同一時間只會有一個部署在執行。

| 任務           | 做法                                                |
| -------------- | --------------------------------------------------- |
| Pages 來源     | 將版本庫的 Pages 來源設為 **GitHub Actions**。      |
| 在本機處理網站 | `devenv shell -- pnpm --filter @graftland/docs dev` |

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
