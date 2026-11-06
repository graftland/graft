---
title: Runner
description: 用 `graft start runner.yml` 在另一台機器上執行外掛。
---

**runner**
是宿主連線的長期執行行程。它驗證每個宿主，從已安裝的套件中找出宿主指名的外掛套件，再為它啟動外掛行程。宿主從不傳送程式碼。

## 架設 runner

1. **安裝**：在 Linux 或 macOS 上、Node.js 22.22 以上，把
   `@graftland/cli`、`@graftland/plugin-remote`、建置好的外掛套件及其相依安裝到某個安裝目錄的
   `node_modules`。透過套件的 `exports` 公開契約與實作，例如
   `my-plugin/contract` 和
   `my-plugin`。宿主需要契約套件，runner 需要這兩個套件。
2. **撰寫** `runner.yml`，其中只有一個 `remote/runner` 設定項目。
3. **啟動** runner：`graft start runner.yml`。
4. **指向** runner：讓宿主的 `remote` 設定項目指向它，再執行
   `graft start host.yml`。

```yaml title="runner.yml"
- id: runner
  name: remote/runner
  config:
    root: ./installation
    state: ./state
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth:
          jwt:
            issuer: https://issuer.example
            audience: [graft]
            algorithms: [ES256]
            keys:
              jwksUrl: https://issuer.example/.well-known/jwks.json
```

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    implementation: my-plugin
    connect:
      url: wss://runner.example:7443
      ca: ./certs/ca.crt
      auth:
        jwt:
          token: { file: ./runner-token.txt }
    config:
      greeting: Hello
```

| 欄位     | 必填 | 預設值       | 意義                                                           |
| -------- | ---- | ------------ | -------------------------------------------------------------- |
| `root`   | 是   | —            | 安裝目錄。契約與實作套件從它的 `node_modules` 解析。           |
| `state`  | 是   | —            | 狀態目錄，不存在時會建立。規則見下表。                         |
| `lease`  | 否   | `15 seconds` | 實例的預設[租約](../lifecycle/#租約與網路中斷)。               |
| `grace`  | 否   | `5 seconds`  | 從中斷外掛行程到強制結束它之間的時間。                         |
| `listen` | 是   | —            | listener，每個位址一個。見 [`listen` 的形式](#listen-的形式)。 |

| 規則                  | 說明                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **路徑**              | 相對於 `runner.yml`，包括 `root`、`state` 與憑證檔案。                                                             |
| **安裝目錄**          | runner 執行期間保持不變。部署時先安裝新套件，再在宿主上重新啟動該設定項目。                                        |
| **狀態目錄**          | 放在本機檔案系統上，同一時間只給一個 runner 使用，重新啟動後保留。第二個 runner 會以 `StateDirectoryLocked` 失敗。 |
| **全新狀態**          | 若某些身分仍在別處使用，不要改用空的狀態目錄：generation 會從頭開始。                                              |
| **啟動命令**          | `graft start runner.yml`，日誌寫到標準錯誤。只有單一 stdio listener 時才加 `--stdio`。                             |
| **啟動**              | 所有 listener 就緒才算啟動完成。失敗時會關閉已開啟的部分，以 原始錯誤 用非零狀態退出。                             |
| **listener 之後失敗** | runner 記錄 `Remote listener failed`，其他 listener 與外掛繼續執行。                                               |
| **服務管理器**        | 用會停止所有後代行程的服務管理器執行 runner，例如設定 `KillMode=control-group` 的 systemd。                        |

## `listen` 的形式

| 形式                          | 欄位                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `url: ws://host:port`         | 不能有 `cert` 或 `key`。                                                        |
| `url: wss://host:port`        | `cert` 與 `key`：伺服器憑證與金鑰。                                             |
| `unix: path`                  | 要建立的 socket 檔案。                                                          |
| `stdio: true`                 | `identity`，預設 `anonymous`。不能有 `auth`。見 [SSH 與 stdio](#ssh-與-stdio)。 |
| `transport: { name, config }` | [自訂 listener](../capabilities/)。                                             |

- 每個元素取一種傳輸形式，最多一種 `auth`，見[傳輸與驗證](../transport-auth/)。
- WebSocket listener 只服務一個路徑 `/graft`，子協定為 `graft-remote.v1`。`url`
  的路徑必須為空或 `/graft`。沒有其他 HTTP 端點，也沒有健康檢查。
- 所有 listener 共用同一組實例，加起來最多只能用一個 JWT issuer。

## 實例

**實例**是 runner 上某個外掛位置的名稱。它與驗證得到的宿主**身分**一起決定一條連線屬於哪個外掛行程。同一身分、同一實例的新連線會替換舊行程，這次啟動會得到下一個
[generation](../lifecycle/#generation-與-fencing)。狀態目錄按身分與實例保存 generation。

| 情況                               | 怎麼做                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| 預設名稱                           | loader 設定項目的 `id`。保持穩定；loader 會把產生的 id 存回設定檔。           |
| 兩個宿主，身分與實例都相同         | 它們會互相替換。讓每個宿主有自己的身分，或設定不同的 `connect.instance`。     |
| 從同一設定項目 fork 出兩個遠端外掛 | 子外掛繼承設定項目 id。為每個設定 `connect.instance`。                        |
| 內嵌群組                           | 群組 id 只在兄弟之間唯一。請檢查最終名稱。                                    |
| 不經 loader 使用 `Remote.plugin`   | 沒有設定項目 id。設定 `connect.instance`，否則載入以 `MissingInstance` 失敗。 |

`connect.expect` 在外掛啟動前確認 runner 安裝的版本：

```yaml
connect:
  url: wss://runner.example:7443
  expect:
    version: 1.4.0
```

| 欄位      | 比對對象                                                                                     |
| --------- | -------------------------------------------------------------------------------------------- |
| `version` | runner 上實作套件 `package.json` 中的 `version`。                                            |
| `digest`  | 套件檔案的 SHA-256 十六進位摘要，排除所有 `node_modules`，因此不涵蓋相依。只有設定時才計算。 |

不符時以 `PackageError` 失敗，訊息會同時顯示兩個值。

## SSH 與 stdio

`stdio`
runner 透過標準輸入輸出溝通，所以宿主可以用 SSH 這類命令連到它，由 SSH 負責驗證與加密。

```yaml title="/srv/graft/stdio.yml"
- id: runner
  name: remote/runner
  config:
    root: /srv/graft/installation
    state: /srv/graft/state/billing
    listen:
      - stdio: true
        identity: billing
```

在 runner 帳號的 `authorized_keys` 中把宿主的金鑰限制為這個命令，再用 `command`
連線：

```text
restrict,command="/usr/local/bin/graft start /srv/graft/stdio.yml --stdio" ssh-ed25519 AAAA... billing-host
```

```yaml
connect:
  command: [ssh, -T, billing@runner.example]
```

| 規則               | 說明                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| **沒有 `auth`**    | `command` 與 `stdio` 都不接受 `auth`，`none` 也不行。`identity` 只是替宿主命名。                            |
| **唯一 listener**  | `stdio` listener 必須是其 runner 唯一的 listener。                                                          |
| **各自的狀態目錄** | 每個 SSH 身分用自己的狀態目錄。同一時間對同一目錄的第二個工作階段會被拒絕。                                 |
| **工作階段結束**   | 輸入結束時，`graft start` 停止外掛、確認它已退出、釋放狀態目錄並以 0 退出；失敗時以非零狀態退出並回報原因。 |
| **乾淨的輸出**     | 標準輸出承載協定位元組。使用 `-T`，不要印出 banner。                                                        |
| **退出證明**       | SSH 退出不能證明外掛已停止，只有 runner 的確認可以。                                                        |
