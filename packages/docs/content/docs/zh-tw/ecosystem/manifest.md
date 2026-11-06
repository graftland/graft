---
title: 外掛清單
description: 產生發布中繼資料並記錄套件來源。
---

**外掛清單**是 `package.json` 中帶版本的 `graft`
欄位，記錄公開入口、契約操作與執行環境需求。它不包含信任聲明或權限授予。

## 宣告入口

```json
{
	"name": "@acme/forecast",
	"version": "1.0.0",
	"type": "module",
	"exports": { ".": "./dist/index.js" },
	"engines": { "node": ">=22.19.0" },
	"peerDependencies": { "effect": "4.1.*", "@graftland/graft": "0.0.0" },
	"graft": {
		"version": 1,
		"entries": {
			".": {
				"implementation": "dist/index.js",
				"contracts": ["@acme/forecast-contract"],
				"requirements": {
					"placements": ["Worker", "Local"],
					"filesystem": false,
					"nativeModules": false
				},
				"probes": ["health"]
			}
		}
	}
}
```

| 欄位             | 作者的責任                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `entries`        | 使用公開匯出名稱 `.` 或 `./subpath`，匯出必須解析至選定的已建置實作。                                                         |
| `contracts`      | 已安裝的契約模組識別符。模組匯出 `contract` 或預設契約，並支援 Node 的預設匯出解析。                                          |
| `requirements`   | 支援的放置位置與所需宿主能力。這些是需求，不是授權。                                                                          |
| `probes`         | 服務期間透過 `Plugin.probe` 註冊的名稱。                                                                                      |
| 執行環境版本範圍 | 以 `engines.node` 及 `effect`、`@graftland/graft` 的 peer 相依套件為唯一來源。發布真正的 semver 範圍，不使用 workspace 範圍。 |

## 產生與驗證

啟用 [Remote 命令外掛](../../cli/#命令外掛)，建置實作後執行：

```sh
graft remote manifest ./release
graft remote manifest ./release --check
```

產生過程匯入已建置的宣告，不執行 `apply`
或探針。只對你打算匯入的程式碼執行此命令。模組作者必須確保匯入不執行 I/O。清單與程式碼不一致時，驗證以失敗結束。

| 產生欄位              | 來源                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `services.required`   | 透過契約描述符解析的必要 `Plugin.inject` 鍵。                               |
| `services.optional`   | `Plugin.optional` 鍵。                                                      |
| `services.implements` | `Plugin.provides`。                                                         |
| `operations`          | 精確的 `name@version`、契約套件名稱與版本，以及該套件的 Artifact 目錄摘要。 |

一般服務缺少契約描述符時，產生會失敗，不會將它從清單中省略。私有服務應封裝在套件內組合中。發布工具讀取操作身分，不檢查 schema。不透明 schema、串流與中介軟體不會阻止發布。[一致性測試工具](../conformance/)
有自己的支援範圍。

產生清單時使用獨立的契約套件。將套件自身的完整目錄摘要寫入其清單會改變該摘要，因此工具會在寫入前拒絕這種自我參照。

## 記錄來源

```sh
graft remote manifest ./release --check --provenance ./provenance.json
```

**來源記錄**包含套件名稱與版本、解析後套件目錄的版本化
[Artifact 身分](../../remote/artifacts/)，以及每個操作的契約套件身分與目錄摘要。記錄檔必須位於套件目錄之外。
`Publication.provenance` 也能記錄已擷取的目錄，不匯入其實作。

每個操作的 `artifact` 包含 `Artifact.directoryIdentity(contractDirectory)`
傳回的 `version`、`algorithm` 與
`digest`。它對套件的位元組計算摘要，不選擇入口，因此同一套件的所有匯出共用該身分。執行製品保留獨立的、包含入口的身分。兩種身分都不序列化 schema，也不證明操作的含義。

外部執行期相依套件不會被擷取或固定。來源不是相容性、發布者身分驗證、信任或權限決定。
[相容性檢查](../compatibility/)與[一致性測試](../conformance/)分別回答各自的問題。
