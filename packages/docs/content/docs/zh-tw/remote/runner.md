---
title: Runner
description: 部署 runner、讓宿主連線進來時看這一頁。
---

部署 runner、讓宿主連線進來時看這一頁。這裡介紹外掛安裝目錄、監聽設定、狀態目錄與 SSH 存取。

## 設定 runner

在 Linux 或 macOS 使用 Node.js
22.22 或更新版本。安裝 remote、已建置的外掛套件與依賴。runner 在 `root`
下解析契約套件名稱，宿主不會上傳程式碼；執行期間不要更動安裝目錄。建議由外部 supervisor 管理 runner 及所有後代行程，例如 systemd 的
`KillMode=control-group`。

```yaml title="runner.yml"
- id: runner
  name: remote/runner
  config:
    root: ./installation
    state: ./state
    lease: 15 seconds
    grace: 5 seconds
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth:
          mtls:
            ca: ./certs/ca.crt
      - unix: ./runner.sock
        auth:
          none:
            identity: billing
```

```sh
graft-remote serve --config runner.yml
```

`runner.yml` 中的路徑，包括 `root`、`state`
與憑證檔案，都相對於這個設定檔所在的目錄，不是行程工作目錄。

`serve` 只接受 `--config`。一個 runner
entry 管理一個 supervisor 與所有 listener，共用實例命名空間。所有 listener 就緒才算啟動成功；啟動失敗會關閉已開啟的資源，執行期間某個 listener 失敗則不會停止其他 listener 或 supervisor。一個 runner 只能設定一個 JWT 簽發者；宣告 issuer 的第三方驗證器也受此限制。bearer 的 token 檔案不算簽發者。

每個 entry 都有私有的能力提供者。同一種能力可在兩個 entry 使用不同設定。第三方外掛寫成
`transport: { name: "my-listener", config: {...} }` 或
`auth: { name: "my-authenticator", config: {...} }`。name 依應用程式的 loader 規則解析；內建簡寫也會展開成相同的引用。

`state`
必須放在本機檔案系統，同一時間只能由一個 supervisor 持有。跨重啟保留目錄，其中記錄了 generation 與未完成的執行。不要用空白狀態目錄重用仍在執行的部署身分。

憑證、驗證設定與 WARN 見[傳輸與驗證](../transport-auth/)；租約與 grace 的期限見[替換與停止](../lifecycle/)。

## Stdio 連線

stdio 只寫一個 `listen`
元素：`{ stdio: true, identity: billing }`，不可與其他 listener 共存。stdout 只寫協定位元組，日誌送到 stderr。EOF 後先停止執行單元、確認退出、釋放狀態鎖，再以 0 退出；清理失敗保留 cause 並以非零代碼退出。同一狀態目錄的並行呼叫會失敗。驗證交給 SSH
`authorized_keys` 強制命令等外部機制。SSH 退出本身不代表遠端執行單元已退出。

## 透過 SSH 連線

在 runner 上安裝外掛套件，為這個 SSH 身分使用獨立的狀態目錄。設定裡只放一個 stdio
listener：

```yaml title="stdio.yml"
- id: runner
  name: remote/runner
  config:
    root: /srv/graft/installation
    state: /srv/graft/state/billing
    listen:
      - stdio: true
        identity: billing
```

宿主使用 command 形式的 `connect`，YAML 也能寫相同的陣列：

```ts
Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		command: ["ssh", "-T", "billing@runner.example"],
		instance: "greeter",
	},
	config: { greeting: "Hello" },
})
```

在 runner 帳號的 `authorized_keys`
裡，把這個公鑰限定為固定命令。請換成實際部署的執行檔路徑與公鑰：

```text
restrict,command="/usr/local/bin/graft-remote serve --config /srv/graft/stdio.yml" ssh-ed25519 AAAA... billing-host
```

不要配置終端，也不要把歡迎訊息寫到 stdout，它只承載協定位元組。SSH 驗證宿主身分，`identity`
指定穩定的 runner 身分名稱。同一狀態目錄不允許第二個呼叫同時執行。SSH 退出不等於執行單元已停止。
