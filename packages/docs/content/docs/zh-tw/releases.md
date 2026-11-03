---
title: 發佈
description: 檢查 Graft、發佈到 npm 和 GitHub Packages，以及部署文件網站。
---

本頁面向需要檢查或發佈 Graft 的貢獻者。

## 檢查

請在專案的 devenv shell 中執行所有命令：

```sh
devenv shell -- pnpm install
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm test:packages
```

進入 shell 時會用 treefmt 格式化程式碼。`pnpm test:packages` 用來測試發佈腳本。

## GitHub Actions

工作流程 `.github/workflows/ci.yml` 會在 pull request、推送到 `main`，以及推送
`v1.2.3` 或 `v1.2.3-beta.0` 這類標籤時執行。

| 作業              | 執行時機         | 工作內容                                                     |
| ----------------- | ---------------- | ------------------------------------------------------------ |
| `check`           | 每次執行         | 檢查格式、建置、型別檢查、測試，並打包所有公開套件。         |
| `github-packages` | 推送分支和標籤時 | 將打包好的檔案發佈到 GitHub Packages。                       |
| `npm`             | 推送標籤時       | 透過可信發佈（trusted publishing）將打包好的檔案發佈到 npm。 |

發佈作業只會在 `check` 通過之後執行。它們發佈的，正是 `check`
打包並測試過的檔案，不會再次建置。

每個 registry 都有固定的作業並行群組（`publish-npm` 或
`publish-github-packages`），並設定 `cancel-in-progress: false` 和
`queue: max`。這個群組涵蓋整個發佈作業：讀取標籤、選擇標籤、上傳套件和處理重試。所以不同版本不會對同一個 registry 交錯進行這些操作。兩個 registry 各有獨立的佇列，可以同時發佈。

[GitHub 並行佇列](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)在
`queue: max`
下最多保留 100 個等待中的作業。佇列滿了之後，GitHub 會取消多出來的作業，你必須重新執行它們。不設定
`queue: max`
時，GitHub 只保留一個等待中的作業，第三個作業到來時會取代它，即使設定了
`cancel-in-progress: false`
也一樣。請檢查 Actions 中被取消的發佈作業，並在佇列清空後重新執行。佇列順序依作業開始等待的時間而定，不是依版本順序，所以仍然需要比較版本號。

並行群組只協調本儲存庫的 CI 作業。手動發佈或修改標籤之前，請等該 registry 所有執行中和排隊中的作業都結束。同時也要在手動作業完成之前，阻止新的發佈作業進入。其他發佈這些套件的工作流程，必須使用同一個群組。

## 版本

所有套件使用同一個版本號一起發佈。`pnpm packages:pack`
會替每個公開套件設定該版本，並把套件之間的相依關係固定到此版本。它會把套件打包到
`.release/`，並把每個檔案的雜湊值寫入 `.release/release.json`。

| 事件                          | 版本                       | npm 標籤                | 發佈目標               |
| ----------------------------- | -------------------------- | ----------------------- | ---------------------- |
| 推送到 `main`                 | `0.0.0-commit-<full hash>` | `sha-<full hash>`       | GitHub Packages        |
| 推送 `v1.2.3-beta.0` 這類標籤 | `1.2.3-beta.0`             | `alpha`、`beta` 或 `rc` | GitHub Packages 和 npm |
| 推送 `v1.2.3` 這類標籤        | `1.2.3`                    | `latest`                | GitHub Packages 和 npm |

預先發行標籤會寫明頻道（`alpha`、`beta` 或
`rc`）和一個編號。它的套件會發佈在該頻道同名的 npm 標籤下，永遠不會成為
`latest`。所以 `npm install @graftland/graft`
仍然安裝最近的穩定版。要安裝預先發行版，請使用它的頻道：

```sh
npm install @graftland/graft@beta
```

提交快照讓你可以試用 `main` 上的任何一次提交。要從 GitHub
Packages 安裝其中一個，請使用工作流程執行紀錄中的版本號：

```sh
npm install @graftland/graft@0.0.0-commit-<full hash> --registry=https://npm.pkg.github.com
```

即使是公開套件，GitHub Packages 也需要具備 `read:packages`
權限的權杖。第一次發佈到那裡的套件可能是私有的，請在 GitHub 的套件設定中調整一次可見性。

你可以在同一個 registry 佇列下重新執行發佈。如果某個版本已存在且內容相同，npm 發佈會略過它，不會變更標籤。GitHub
Packages 也能修復它的頻道標籤，前提是這不會讓標籤往回退。如果內容不同，腳本會停止。我們的 npm 可信發佈者只有發佈權限，所以重試永遠不會呼叫
`npm dist-tag`。如果 npm 標籤遺失，或被外部修改，具有標籤權限的維護者必須在同樣的獨占發佈約定下單獨修復它。重新執行作業並不會修復這個標籤。

因為發佈是依序進行的，`latest`、`alpha`、`beta` 和 `rc`
永遠不會退回到較舊的版本。首次上傳和 GitHub 標籤修復，都使用同一套
[SemVer 優先順序](https://semver.org/#spec-item-11)規則，與目標頻道目前指向的版本比較。腳本用明確的
`@<channel>` 選擇器讀取完整的 `dist-tags` 物件，所以只有預先發行版的套件，不需要
`latest`
標籤。頻道不存在（E404）與成功但為空或格式錯誤的回應不同，後者會中止發佈。預先發行編號會以數字比較（`beta.10`
比 `beta.2`
新）。主版本、次版本和修訂號，優先於預先發行的序列。建置中繼資料不影響順序。不存在的頻道可以初始化。重新執行頻道目前已指向的版本，標籤維持不變。

如果新上傳的版本比頻道目前的版本舊，Graft 仍會發佈該套件。穩定版使用
`backport`，預先發行版則使用 `alpha-backport`、`beta-backport` 或
`rc-backport`。這些備用標籤用來標記遲到的上傳，不保證指向最新的版本。需要較舊的版本時，請用完整版本號安裝。重新執行已存在的舊版本，不會移動它的頻道，也不會修復備用標籤。例如，先發佈
`0.2.0-beta.2` 再發佈 `0.2.0-beta.1`，或之後重新執行 `beta.1`，`beta` 都會維持在
`beta.2`。

直接並行執行發佈腳本時沒有鎖保護，也不提供上述的頻道保證。仍然必須使用 registry 佇列；單靠版本比較，無法讓 registry 的讀取和寫入成為原子操作。

## 發佈版本

1. 確認 `main` 通過 CI。
2. 為提交加上標籤並推送，穩定版如 `v1.2.3`，預先發行版如 `v1.2.3-beta.0`：

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

3. 如果 `npm` 環境需要核准，`npm` 作業會等待核准，然後發佈。

`npm`
作業使用 npm 的[可信發佈](https://docs.npmjs.com/trusted-publishers)。npm 接受工作流程執行的 OIDC 權杖，而不需要存取權杖，並為每個套件附上來源證明（provenance）。儲存庫中不保存任何機密。每個套件都信任
`graftland/graft` 的 `ci.yml` 工作流程在 `npm` 環境中的執行：

```sh
npm trust github @graftland/graft --file ci.yml --repo graftland/graft --env npm --allow-publish
npm trust list @graftland/graft
```

npm 只能信任已經存在的套件。所以新套件要先由維護者用 CI 打包好的檔案發佈一次，之後再建立信任：

```sh
gh run download <run id> --name packages-<commit hash> --dir .release
npm login
devenv shell -- pnpm packages:publish npm
```

## 文件網站

工作流程 `.github/workflows/docs.yml` 會在每次推送到 `main` 時，從
`packages/docs` 建置本網站，並部署到 GitHub
Pages：[graftland.github.io/graft](https://graftland.github.io/graft/)。你也可以從 Actions 頁面手動啟動。同一時間只會進行一次部署。

儲存庫的 Pages 來源必須設為 **GitHub
Actions**。要在你自己的電腦上開發網站，請執行：

```sh
devenv shell -- pnpm --filter @graftland/docs dev
```

英文頁面位於 `packages/docs/content/docs`，簡體中文頁面位於其中的 `zh-cn`
資料夾，繁體中文頁面位於其中的 `zh-tw`
資料夾，檔案名稱都與英文相同。頁面之間請使用 `../plugins/`
這樣的相對連結，這樣在網站設定了基礎路徑後，連結仍然有效。

每個 README 旁邊都有 `README.zh-CN.md` 和 `README.zh-TW.md`
兩個譯本，是根據英文 README 撰寫的。修改英文 README 或英文文件頁面時，必須在同一次變更中更新譯本。
