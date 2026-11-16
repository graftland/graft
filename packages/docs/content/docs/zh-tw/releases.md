---
title: 發佈
description: Graft 如何檢查、打包、發佈，以及如何部署文件網站。
---

每次變更都經過 CI：CI 建置唯一的套件，打包一次，把同一批檔案發佈到 GitHub
Packages 和 npm。文件網站則另行部署到 docs.graft.land。

## 檢查

所有命令都在專案的 devenv shell 中執行：

```sh
devenv shell -- pnpm install --frozen-lockfile
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm test:packages
```

進入 shell 時 treefmt 會格式化程式碼。CI 也這樣做，格式化改動任何檔案時 CI 失敗。

`pnpm test` 執行所有 vitest project。workspace
project 檢查每個匯出的簽章都能透過套件的公開匯出命名。如果失敗，就把實作型別從公開簽章中移除，或匯出一個屬於公開契約的型別。

文件檢查在文件套件裡執行：

```sh
devenv shell -- pnpm --filter @graftland/docs test
devenv shell -- pnpm --filter @graftland/docs build
```

測試會型別檢查每個程式碼區塊並執行其中的 doctest。建置會檢查所有本機連結和錨點。

## 一個套件

Graft 只發佈 `@graftland/graft`。

| 入口        | 內容                            |
| ----------- | ------------------------------- |
| `.`         | `Graft`、`Mount` 與 `Release`。 |
| `./rpc`     | 透過 `effect/rpc` 的遠端服務。  |
| `./node`    | 子行程與 worker 的 Protocol。   |
| `./testing` | 用於測試的記憶體內 Protocol。   |

`effect` 是 peer dependency，約束為 `4.1.*`。`@effect/platform-node`
是選用的peer，只有 `./node` 需要它。

## 打包

`pnpm packages:pack`
建置整個 workspace，給公開套件賦上參照所對應的版本，並打包到
`.release/`。`.release/release.json` 記錄該版本、提交以及每個打包檔案的 sha512
integrity。

只有公開（非 private）的套件會被包裝；在這個分支上只有 `@graftland/graft`。

| 事件                        | 版本                      | npm tag                 | 發佈到                 |
| --------------------------- | ------------------------- | ----------------------- | ---------------------- |
| 推送到 `main`               | `0.0.0-commit-<完整雜湊>` | `sha-<完整雜湊>`        | GitHub Packages        |
| 形如 `v1.2.3-beta.0` 的 tag | `1.2.3-beta.0`            | `alpha`、`beta` 或 `rc` | GitHub Packages 與 npm |
| 形如 `v1.2.3` 的 tag        | `1.2.3`                   | `latest`                | GitHub Packages 與 npm |

tag 必須與 Changesets 提交的版本一致。不一致時打包停止，並要求你先合併 **Version
Packages** pull request。

### 安裝預發佈版或快照

預發佈 tag 由頻道名 `alpha`、`beta` 或 `rc`
加一個序號組成。它的套件發佈在該頻道的 npm tag 下，永遠不會成為 `latest`，所以
`npm install @graftland/graft` 始終安裝最新的穩定版本。

| 你想要……          | 執行                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------- |
| 預發佈版          | `npm install @graftland/graft@beta`                                                          |
| `main` 的任一提交 | `npm install @graftland/graft@0.0.0-commit-<完整雜湊> --registry=https://npm.pkg.github.com` |

提交快照只發佈到 GitHub Packages。安裝快照時使用 workflow run 中的版本。GitHub
Packages 需要一個帶 `read:packages`
的憑證，公開套件也一樣。首次發佈到那裡的套件可能是私有的；在 GitHub 的套件設定裡設定一次可見性。

## 發佈保證

### 重試

你可以在同一個 registry 佇列下再次執行發佈。

| 情況                   | npm                                                                          | GitHub Packages                                   |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| 已存在同版本的相同內容 | 略過，不改動 tag。                                                           | 略過。只要不會把頻道 tag 後退，它可以修復該 tag。 |
| 已存在同版本但內容不同 | 腳本停止。                                                                   | 腳本停止。                                        |
| tag 缺失或被外部改動   | 由有 tag 權限的維護者按同樣的獨佔發佈規則單獨修復。再次執行 job 不會修復它。 | 同上修復。                                        |

npm 的 trusted publisher 只有發佈權限，所以重試從不呼叫 `npm dist-tag`。

### 頻道不會後退

由於發佈一次只執行一個，`latest`、`alpha`、`beta` 和 `rc` 不會退回較舊的版本。

- 首次上傳和修復 GitHub tag 時，都對目標頻道的目前版本使用同一套
  [SemVer 優先順序](https://semver.org/#spec-item-11)比較。
- 預發佈識別碼中的數字按數字比較（`beta.10` 比 `beta.2`
  新）。major、minor 和 patch 排在預發佈序列之前。build
  metadata 不影響優先順序。
- 腳本用明確的 `@<頻道>` 選擇器讀取完整的 `dist-tags`
  物件，因此只有預發佈版的套件不需要 `latest` tag。
- 缺失的頻道（E404）可以新建。只有預發佈版的套件還沒有 `latest`；它的 tag 用
  `npm dist-tag ls` 列出，所以它的第一個穩定版本也會把 `latest`
  建起來。成功但內容為空或格式錯誤的回應會停止發佈。
- 再次執行頻道上已有的版本不會改動 tag。

### 遲到的上傳

如果新上傳的版本比頻道目前版本舊，Graft 仍然用回退 tag 發佈這個套件：

| 發佈類型 | 回退 tag                                           |
| -------- | -------------------------------------------------- |
| 穩定版   | `backport`                                         |
| 預發佈版 | `alpha-backport`、`beta-backport` 或 `rc-backport` |

這些 tag 標記遲到的上傳，不承諾跟隨最新版本。安裝舊版本時使用它的確切版本。再次執行一個已存在的舊版本不會移動它的頻道，也不會修復回退 tag。例如，如果你先發佈
`0.2.0-beta.2` 再發佈 `0.2.0-beta.1`，或者之後再次執行 `beta.1`，`beta` 仍停留在
`beta.2`。

:::note

直接並行執行發佈腳本沒有鎖，不提供頻道保證。你仍然需要 registry 佇列；僅靠版本比較無法讓 registry 的讀寫變成原子操作。

:::

## 發佈一個版本

1. **合併 Version Packages pull request**，讓新版本進入提交。Changesets
   workflow 會開啟或更新這個 pull request；它從不發佈。
2. **確認 `main` 通過 CI。**
3. **為提交打 tag 並推送**，例如 `v1.2.3`。Graft 處於 0.x 期間，發佈 `v0.3.0`
   這類一般版本即可：0.x 版本本身就表示 API 可能變動，不需要 `-beta` 後綴。像
   `v1.2.3-beta.0` 這樣的預發佈 tag 仍然可用：

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

4. **`npm` job 等待 `npm`
   environment**（如果需要審批）然後發佈。`github-packages`
   job 在自己的佇列下發佈同一批檔案。

### Trusted publishing

`npm` job 使用 npm 的
[trusted publishing](https://docs.npmjs.com/trusted-publishers)：npm 接受 workflow
run 的 OIDC 憑證而不是存取權杖，並為套件加上 provenance 宣告。儲存庫不保存任何密鑰。該套件信任
`graftland/graft` 中 `npm` environment 裡的 `ci.yml` workflow：

```sh
npm trust github @graftland/graft --file ci.yml --repo graftland/graft --env npm --allow-publish
npm trust list @graftland/graft
```

### 第一次 trusted 發佈之前

npm 只能信任已經存在的套件，而已發佈的 `@graftland/graft`
仍然是 0.6 版本。維護者用 CI 打包好的檔案先手動上傳新系列的第一個版本，之後設定 trusted
publishing：

```sh
gh run download <run id> --name packages-<commit hash> --dir .release
npm login
devenv shell -- pnpm packages:publish npm
```

上傳之後，按上面的方式設定 trusted publishing。

## GitHub Actions

workflow `.github/workflows/ci.yml` 在 pull request、推送到 `main`，以及
`v1.2.3` 或 `v1.2.3-beta.0` 這類 tag 時執行。

| Job               | 何時執行           | 做什麼                                                             |
| ----------------- | ------------------ | ------------------------------------------------------------------ |
| `check`           | 總是               | 檢查格式、建置、型別檢查、測試發佈腳本並打包。                     |
| `projects`        | 總是               | 列出 vitest project，新增的 project 不必改 workflow 就有測試 job。 |
| `test`            | 總是               | 用 matrix 執行每個 vitest project。                                |
| `github-packages` | 推送與 tag         | 把打包好的檔案發佈到 GitHub Packages。                             |
| `npm`             | tag                | 用 trusted publishing 把打包好的檔案發佈到 npm。                   |
| `github-release`  | tag，在 `npm` 之後 | 用該版本的 changeset 建立 GitHub Release。                         |

`github-packages` 和 `npm` job 需要 `check` 與 `test` 都通過。它們發佈的正是
`check` 打包並測試過的檔案，從不重新建置。

### 發佈佇列

每個 registry 有一個固定的 job 並行群組，`cancel-in-progress: false`，`queue: max`。

| Registry        | 並行群組                  |
| --------------- | ------------------------- |
| npm             | `publish-npm`             |
| GitHub Packages | `publish-github-packages` |

- **範圍。**
  並行群組涵蓋整個發佈 job：讀取 tag、選擇 tag、上傳套件以及處理重試。
- **獨立。** 兩個 registry 有各自的佇列，可以同時發佈。
- **順序。**
  佇列順序依 job 開始等待的時間，而不是版本順序，所以仍然需要版本比較。
- **容量。** GitHub 用 `queue: max`
  保留最多 100 個待執行 job。佇列滿時 GitHub 會取消多餘的 job，所以要查看被取消的發佈 job，並在佇列清空後重新執行。

:::caution

並行群組只協調本儲存庫的 CI
job。手動發佈或修改 tag 之前，等該 registry 的所有執行中和排隊中的 job 結束，並在手動操作完成前停止新的發佈 job。其他發佈本套件的工作流必須使用同一個並行群組。

:::

## 文件網站

workflow `.github/workflows/docs.yml` 在每次推送到 `main` 和每個 `v*` tag 時從
`packages/docs` 建置本站，並部署到 Cloudflare Worker 上的
[docs.graft.land](https://docs.graft.land/)。生產網站始終提供最新的穩定版本。

| Job          | 做什麼                                     |
| ------------ | ------------------------------------------ |
| `plan`       | 選擇要建置的提交。                         |
| `production` | 建置將成為生產網站的提交。                 |
| `build`      | 把其他保留的每個提交建置成各自的 preview。 |
| `list`       | 更新提交列表，並刪除不再保留的文件。       |
| `redirect`   | 寫出舊 GitHub Pages 位址的重新導向。       |

最新的 15 個發佈 tag 和 `main` 上最新的 30 個提交各自保留一個 Worker
Preview，位址為
`https://<雜湊前 12 個字元>.<網站主機>/`。`https://versions.<網站主機>/`
提供提交列表和版本選擇。舊位址 `graftland.github.io/graft` 和
`graft-docs-ekb.pages.dev` 重新導向到 `docs.graft.land`。

| 任務             | 怎麼做                                              |
| ---------------- | --------------------------------------------------- |
| Pages 來源       | 把儲存庫的 Pages 來源設定為 **GitHub Actions**。    |
| 本機開發文件網站 | `devenv shell -- pnpm --filter @graftland/docs dev` |

### 撰寫頁面

| 語言     | 目錄                               |
| -------- | ---------------------------------- |
| 英文     | `packages/docs/content/docs`       |
| 簡體中文 | `packages/docs/content/docs/zh-cn` |
| 繁體中文 | `packages/docs/content/docs/zh-tw` |

- 每個目錄使用相同的檔案名稱。
- 頁面之間用相對連結，例如 `../remote/`，這樣連結在網站的 base 路徑下也能運作。
- 每個英文 README 旁邊都有 `README.zh-CN.md` 和 `README.zh-TW.md`
  翻譯，依英文 README 撰寫。改動英文 README 或英文文件頁面時，在同一次改動中更新翻譯。
- 撰寫頁面前先讀 `packages/docs/STYLE.md`。
- 在 `packages/docs` 中執行 `node snippets.mjs check` 和
  `pnpm vitest run`，對範例做型別檢查並執行其中的 doctest。

## 舊套件

早期版本的 Graft 是一個分散在多個套件裡的外掛執行環境。這些套件已不再開發。下表列出每個套件在 npm 上發佈的最後一個版本。

| 套件                           | 最後一個版本 | 改用                               |
| ------------------------------ | ------------ | ---------------------------------- |
| `@graftland/loader`            | `0.6.0`      | 在你自己的程式裡用 `Graft.mount`。 |
| `@graftland/cli`               | `0.6.0`      | 無；不再有命令和設定檔。           |
| `@graftland/create`            | `0.6.0`      | 無。                               |
| `@graftland/package-manager`   | `0.6.0`      | 無。                               |
| `@graftland/plugin-remote`     | `0.6.0`      | `rpc` 入口。                       |
| `@graftland/hmr`               | `0.5.0`      | 無；Graft 不再重載模組。           |
| `@graftland/plugin-http`       | `0.5.0`      | 無。                               |
| `@graftland/plugin-http-api`   | `0.5.0`      | 無。                               |
| `@graftland/plugin-mcp-server` | `0.5.0`      | 無。                               |
| `@graftland/plugin-otlp`       | `0.5.0`      | 無。                               |
| `@graftland/plugin-release`    | 未發佈       | 無。                               |

`@graftland/plugin-release` 從未發佈，沒有對象可標記。

是否用 `npm deprecate`
標記舊套件，是選用的獨立決定，本頁不要求這樣做。它不會改變已發佈的版本。
