---
title: 相容性檢查
description: 在載入程式碼前檢查外掛需求是否符合宿主條件。
---

**相容性檢查**將已發布清單與明確的宿主描述進行比較，不匯入實作模組，也不安裝任何內容。在載入已安裝或已解包的外掛前執行它。

## 描述宿主

儲存預檢檔，例如 `graft.check.json`：

```json
{
	"host": {
		"node": "22.22.0",
		"effect": "4.1.2",
		"graft": "0.0.0",
		"placement": "Worker",
		"filesystem": true,
		"nativeModules": false,
		"operations": []
	},
	"entries": [
		{
			"id": "forecasts",
			"directory": "./node_modules/@acme/forecast",
			"entry": "."
		}
	],
	"catalog": []
}
```

| 欄位              | 含義                                                       |
| ----------------- | ---------------------------------------------------------- |
| `host`            | 選定部署宿主的實際執行環境版本與能力。                     |
| `host.operations` | 宿主提供的契約操作記錄，格式與清單中的 `operations` 相同。 |
| `entries`         | 一起啟用的項目，包含實例 id、套件目錄與公開入口。          |
| `catalog`         | 可供建議的其他套件。列在這裡不等於啟用。                   |
| 路徑              | 相對於此預檢檔，包括 catalog 中的路徑。                    |

## 執行檢查

```sh
graft --no-plugins check graft.check.json
```

`--no-plugins`
還會略過命令外掛探索。存在任何診斷時，命令以非零狀態結束。嵌入式應用程式可用
`Manifest.check` 執行同一個純檢查。檔案描述平面部署，不表示 Loader
realm 可見性或相依啟動順序。它不改寫 `graft.yml`，也不改變 `graft add` 與
`graft start`；在部署腳本中明確先執行預檢。

| 診斷                 | 操作                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- |
| `MissingEntry`       | 選擇套件清單中列出的公開入口。                                                         |
| `MissingOperation`   | 啟用提供精確 `name@version` 的套件。訊息指出需要它的項目，並從 catalog 中建議套件。    |
| `ProvenanceConflict` | 同一操作來自不同契約套件名稱或不同目錄摘要。診斷列出雙方來源；選擇同一套件的同一摘要。 |
| `Runtime`            | 使用滿足套件版本範圍的 Node、Effect 與 Graft，或選擇其他外掛版本。                     |
| `Placement`          | 選擇受支援且具備所需檔案系統或原生模組能力的位置。                                     |
| `InvalidManifest`    | 使用 `graft remote manifest` 重新產生缺失的操作定義。                                  |

同一契約套件名稱與同一目錄摘要永遠不會衝突，即使多個項目或匯出宣告同一操作。這是來源檢查，不比較 schema 定義。

必要操作必須由宿主或其他已選項目提供。選用操作不阻止啟動。不同操作版本不能替代請求的版本。套件版本用於執行環境需求與來源記錄，不能替代操作相容性。

檢查通過以中繼資料真實且宿主清單準確為前提，不證明探針、外部連線、任意業務語意或原生程式碼安全。發布前[驗證清單](../manifest/)並執行[一致性測試](../conformance/)。信任與授權仍由維運策略決定。
