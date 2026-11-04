# Remote runner

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

發票匯出外掛透過 **wss + JWT**
在 runner 上執行，呼叫宿主的帳本服務。宿主重新啟動後，runner 先確認舊匯出行程退出，再啟動新行程。新實例的 generation 更大，帳本據此拒絕舊實例延遲抵達的寫入。

## 執行

使用 Linux 或 macOS、Node.js 22.22 或更新版本。在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-runner start
devenv shell -- pnpm --filter @graftland/sample-remote-runner test
```

所有部分都在本機執行。`src/lab.ts` 用 `graft-remote certificates`
產生伺服器憑證，產生 ES256 金鑰與
`sub: billing`、有效期限十分鐘的 JWT，將編譯後的套件安裝到
`.cache/lab/install`，然後在 127.0.0.1 啟動 runner。

宿主兩次載入 `graft.yml`，明確載入 `host/websocket` 和 `host/auth/jwt`。
`ledger` 在宿主執行，`exporter` 在 runner 執行；儲存的項目 id `exporter`
就是實例名稱。預期輸出：

```text
Runner listening on port 52341
INV-1 exported by generation 1 (runner child 68017)
… remote.generation: 1, remote.termination: Exited
INV-2 exported by generation 2 (runner child 68072)
A late write from generation 1 was rejected: the ledger has seen 2
… remote.generation: 2, remote.termination: Exited
```

每次停止都會等待行程退出確認。第二個宿主使用同一實例名稱，因此 generation 遞增。帳本以
`StaleGeneration` 拒絕刻意延遲的 generation
1 寫入。測試驗證兩次呼叫、退出與 fencing。每次示範會重建
`.cache/lab`；實際部署須保留狀態目錄，讓 generation 持續遞增。

`src/contract.ts` 定義 `Ledger` 與 `Exporter`。`src/worker.ts`
是 runner 上的實作， `src/exporter.ts` 在啟用時讀取宿主設定，`src/host.ts`
示範重新啟動的過程。 `src/credentials.ts` 簽發示範 token，`src/issue-token.ts`
提供可獨立執行的指令稿。

generation 檢查由外部系統負責，能拒絕過期寫入，不能撤銷已接受的寫入，也不保證呼叫恰好執行一次。

## 使用真實 runner 機器

建置完成後，在本範例目錄產生示範 token 與伺服器憑證：

```sh
CREDENTIALS_DIR=.cache/credentials node dist/issue-token.js
pnpm exec graft-remote certificates --out certs --server runner.example
```

指令稿寫出 `jwt-public.pem` 和
`token`，不儲存簽名私鑰。token 十分鐘後過期。重新執行會產生新金鑰，因此也須替換 runner 的公鑰並重新啟動它。這只是示範指令稿，不是簽發服務；實際部署使用自己的簽發者及其公鑰或 JWKS
URL。JWT 過期不會關閉已通過驗證的工作階段。遭竊 token 在有效期限內可被重播，應使用 wss 與短有效期限。

把 `server.crt`/`server.key` 和 `jwt-public.pem` 複製到 runner，宿主保留
`ca.crt` 和 `token`，`ca.key` 由維運人員保管。不使用用戶端 TLS 憑證。
`certificates` 會重用既有 CA，`--force` 替換所要求的終端憑證。

在擁有獨立 `package.json` 的 `/srv/graft/install` 下安裝
`@graftland/remote`、本範例編譯後的套件及依賴。這些是工作區套件，不假定已發布至 registry。用外部行程管理器涵蓋整個行程群組，保留
`/var/lib/graft`：

```sh
graft-remote serve --listen wss://0.0.0.0:7443 --auth jwt \
  --cert server.crt --key server.key \
  --jwt-issuer https://issuer.example --jwt-audience graft \
  --jwt-algorithm ES256 --jwt-public-key jwt-public.pem \
  --root /srv/graft/install --state /var/lib/graft
```

在宿主的本範例目錄：

```sh
RUNNER_HOST=runner.example RUNNER_PORT=7443 RUNNER_SERVERNAME=runner.example \
RUNNER_CA=certs/ca.crt RUNNER_TOKEN="$(cat .cache/credentials/token)" \
LEDGER_FILE=ledger.json pnpm exec graft start
```

按 Ctrl+C，等待
`remote.termination: Exited`；再用同一 YAML 啟動，generation 會遞增。這個手動模式只載入匯出服務；需要呼叫時，加入一個注入
`Exporter` 的宿主外掛。

## 透過 SSH 連線

將宿主 YAML 中的 `host/websocket`、`host/auth/jwt` 替換為
`@graftland/remote/host/command`，target 改成：

```ts
Remote.runner({
	transport: Remote.command([
		"ssh",
		"-T",
		"graft@runner.example",
		"graft-remote",
		"serve",
		"--stdio",
		"--identity",
		"billing",
		"--root",
		"/srv/graft/install",
		"--state",
		"/var/lib/graft-ssh",
	]),
	// The loader entry id supplies instance; do not add auth.
})
```

若要將一把 SSH 金鑰限制為只執行這個命令，在遠端帳號的 `~/.ssh/authorized_keys`
中寫入以下這一行，替換公鑰預留文字與執行檔路徑：

```text
restrict,command="/srv/graft/install/node_modules/.bin/graft-remote serve --stdio --identity billing --root /srv/graft/install --state /var/lib/graft-ssh" ssh-ed25519 AAAA... billing-host
```

SSH 驗證呼叫者，強制命令固定 runner 身分。不要配置 TTY，也不要在 stdout 輸出提示文字：stdout 承載協定，日誌走 stderr。stdio 每個行程只服務一個工作階段，直到執行單元退出才釋放狀態目錄鎖定。並行呼叫不能共用該目錄；依序呼叫保留遞增的 generation。SSH 退出本身不代表遠端已終止。這段 SSH 用法僅供說明，自動化範例測試涵蓋的是 wss/JWT。

租約、三種停止結果、設定檔與信任邊界見
[遠端外掛指南](https://graftland.github.io/graft/zh-tw/remote/)。
