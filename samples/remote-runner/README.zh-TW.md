# 遠端 runner

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

發票匯出器要往帳本裡寫資料，而你想把匯出器放到另一台機器上。宿主重新啟動後，重啟前的匯出器不能還在和新的匯出器一起寫。網路延遲又是另一個問題：舊匯出器送出的寫入，可能在新匯出器啟動後才抵達。

本範例把匯出器放在 runner 上執行，宿主透過雙向 TLS 連線 runner。runner 確認舊匯出器已經退出，才會啟動新的；每次啟動都會得到更大的
_generation_。帳本記錄看過的最新 generation，拒絕來自更舊 generation 的寫入。

## 執行

使用 Linux 或 macOS、Node.js 22.22 或更新版本，並安裝
`openssl`。在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-runner start
devenv shell -- pnpm --filter @graftland/sample-remote-runner test
```

所有東西都在本機執行，由 `src/lab.ts`
扮演 runner 機器：它產生憑證，把建置好的套件安裝到
`.cache/lab/install`，並在 127.0.0.1 上啟動 `graft-remote serve`。程式輸出：

```text
Runner listening on port 52341
INV-1 exported by generation 1 (runner child 68017)
… Remote execution terminated … remote.generation: 1, remote.termination: Exited
INV-2 exported by generation 2 (runner child 68072)
A late write from generation 1 was rejected: the ledger has seen 2
… Remote execution terminated … remote.generation: 2, remote.termination: Exited
```

過程如下：

1. 宿主載入 `graft.yml`。`ledger` 條目在宿主上執行；`exporter`
   條目在 runner 上啟動 worker，以條目 id `exporter`
   作為實例名稱。宿主上的一個外掛呼叫
   `Exporter.export("INV-1")`，worker 再透過同一條連線呼叫宿主的
   `Ledger`，附上自己的 generation。
2. 宿主停止，並一直等到 runner 確認 worker 行程已經退出（`remote.termination: Exited`）。
3. 第二個全新的宿主載入同一個檔案。條目 id 相同，所以要求的是同一個實例。runner 在新行程裡以 generation
   2 啟動它。
4. 宿主接著送出一筆標著 generation
   1 的寫入，模擬在網路上被耽擱的請求。帳本已經看過 generation 2，於是以
   `StaleGeneration` 拒絕。

帳本把寫入儲存在 `.cache/lab/ledger.json`。runner 把 generation 儲存在
`.cache/lab/state`，只要這個目錄還在，generation 就會持續遞增。每次 `start`
都會重建
`.cache/lab`，所以每次輸出的 generation 相同。測試用真實 runner 跑同樣的流程，檢查 generation、行程退出和拒絕結果。

## 檔案

| 檔案                         | 用途                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| `graft.yml`                  | 兩個條目。匯出器的條目 id 就是它的實例名稱。               |
| `src/contract.ts`            | 兩邊共用：設定、`Ledger` 和 `Exporter`、RPC、錯誤。        |
| `src/worker.ts`              | 在 runner 上執行，注入 `Ledger`，提供 `Exporter`。         |
| `src/exporter.ts`            | 條目入口，從環境變數讀取 runner 位址和憑證路徑。           |
| `src/ledger.ts`              | 宿主外掛，代表一個外部系統，負責檢查 generation。          |
| `src/host.ts`                | 兩次在全新的宿主執行環境裡載入 `graft.yml`，走完整個流程。 |
| `src/lab.ts`                 | 扮演 runner 機器：憑證、安裝、`graft-remote serve`。       |
| `scripts/certificates.sh`    | 用 `openssl` 產生專用 CA，以及 runner 和宿主的憑證。       |
| `test/remote-runner.test.ts` | 用真實 runner 跑一遍流程。                                 |

runner 保證新行程啟動前舊行程已經退出。generation 用來處理這個保證涵蓋不到的情況：已經在路上的寫入，以及 Graft 之外的系統。這些系統必須自行檢查 generation，就像
`src/ledger.ts`
那樣。generation 不能撤銷已經接受的寫入，也不能讓呼叫恰好執行一次。

## 使用真正的 runner 機器

為 runner 的主機名稱產生憑證，宿主身分為 `graft://billing`：

```sh
sh scripts/certificates.sh certs runner.example billing
```

把 `ca.crt`、`server.crt` 和 `server.key` 複製到 runner；`ca.crt`、`client.crt`
和 `client.key` 留在宿主上。`ca.key` 兩邊都不要放，它能簽發新憑證。

在 runner 上建立一個帶有自己 `package.json` 的安裝目錄，把 `@graftland/remote`
和建置好的本範例套件連同依賴安裝進去，確保存在
`node_modules/@graftland/sample-remote-runner/package.json`。這些都是工作區套件，不以已發布到 registry 為前提。接著交給行程管理器啟動 runner，停止時涵蓋整個行程群組，重新啟動時保留狀態目錄：

```sh
graft-remote serve --host 0.0.0.0 --port 7443 \
  --root /srv/graft/install --state /var/lib/graft \
  --cert server.crt --key server.key --ca ca.crt
```

在宿主上，進入本目錄，設定 `src/exporter.ts` 和 `src/ledger.ts`
讀取的變數，然後啟動 `graft.yml`：

```sh
RUNNER_HOST=runner.example RUNNER_PORT=7443 RUNNER_SERVERNAME=runner.example \
RUNNER_CA=certs/ca.crt RUNNER_CERT=certs/client.crt RUNNER_KEY=certs/client.key \
LEDGER_FILE=ledger.json pnpm exec graft start
```

匯出器會在 runner 上啟動。按 <kbd>Ctrl</kbd>+<kbd>C</kbd>，宿主會記錄
`remote.termination: Exited`。再次啟動，日誌裡的 generation 會加一。這種方式下沒有外掛呼叫匯出器；要使用它，新增一個注入
`Exporter`
的宿主外掛。租約、停止結果以及 runner 信任哪些東西，見[遠端外掛指南](https://graftland.github.io/graft/zh-tw/remote/)。
