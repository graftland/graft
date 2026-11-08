# Graft 效能基準

這是一個私有工作區套件，用來比較 Graft、cordis、avvio、原生 Effect、Node
EventEmitter 與 emittery。先檢查各實作完成的工作是否一致，再解讀速度差異。報告將不支援的操作列為 N/A，並說明原因。

## 執行

所有命令都從儲存庫根目錄執行。依賴與 pnpm 儲存空間保留在目前的工作樹中。基準命令先建置 Graft 與適配器。

CI 在推送到 `main` 與修改 `packages/`
的提取要求上執行快速套件，每週或透過 Benchmarks 工作流程的 **Run workflow**
按鈕執行完整套件。每次執行把報告寫入作業摘要，JSON 放進成品。CI 執行器是共用的，所以 CI 只回報數字，不因數字失敗；只在 CI 執行之間比較。

```sh
devenv shell -- pnpm install --frozen-lockfile --store-dir .cache/pnpm-store
devenv shell -- pnpm bench
devenv shell -- pnpm --filter @graftland/benchmarks bench --quick
devenv shell -- pnpm bench --scenario fanout,events --implementation graft,cordis
devenv shell -- pnpm bench --scenario memory-cycles --cycles 1000 --output .cache/long-churn
```

| 選項         | 行為                                                                |
| ------------ | ------------------------------------------------------------------- |
| `--quick`    | 保留原有規模矩陣並減少採樣；Remote 記憶體只測 N=1。僅用於冒煙檢查。 |
| `--scenario` | 用逗號分隔下表場景名稱的子字串。                                    |
| `--cycles`   | 覆寫同一根執行環境內的載入/卸載循環次數。                           |
| `--output`   | 相對於此套件的輸出路徑前綴；預設為 results/latest 或 .cache/quick。 |

每個案例完成後儲存 JSON 與 Markdown。錯誤保留在兩種輸出中，並使命令失敗。CI 透過根目錄
`pnpm test`
執行等價性測試與小型 runner 冒煙檢查，不執行完整效能套件，也不設定速度門檻。

## 場景

| 場景                                              | 每次取樣完成的工作                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| cold-load / cold-dispose                          | 啟用/卸載 N 個獨立外掛；N = 1、100、1000。空根執行環境的建置不計時。                              |
| fanout-load / fanout-withdraw / fanout-restore    | 一個提供者與 N 個消費者；載入至全部啟用，撤回至消費者停止，恢復至全部再次啟用。N = 1、100、1000。 |
| chain                                             | D 個外掛讀取前一個外掛的服務；D = 1、10、100，按拓撲順序註冊。                                    |
| service                                           | 從依賴外掛內執行 10000 次服務查找與同步方法呼叫，驗證累計值。                                     |
| events-emit / events-sequential / events-parallel | 向 H = 1、10、100 個處理器執行 100 次完整廣播。處理器主體同步執行。                               |
| events-bail / events-serial-bail                  | 執行 100 次分發；前面的處理器不傳回結果，第 H 個傳回 7。                                          |
| events-waterfall                                  | 執行 100 次中介軟體分發；每層將終端結果 0 加一。                                                  |
| config-update / config-restart                    | 將值從 0 改為 1，分別原地更新或卸載後重新啟用。                                                   |
| memory-cycles                                     | 在同一根執行環境內對 10 個外掛執行 100 次循環，測量堆積成長並記錄檢查點斜率。                     |
| memory-steady                                     | 1000 個存活外掛相對於空根執行環境的堆積增量，除以外掛數量。                                       |
| import                                            | 在新行程中匯入各函式庫，分別記錄匯入延遲與子行程總耗時。                                          |

## 方法

| 設定                          | 完整執行                                  | 快速執行 |
| ----------------------------- | ----------------------------------------- | -------- |
| 計時取樣                      | 至少 100 次，且累計計時工作不少於 2000 ms | 3 次     |
| 預熱                          | 至少 20 次，且累計計時工作不少於 1000 ms  | 1 次     |
| 每批服務呼叫/事件分發         | 10000 / 100                               | 100 / 2  |
| 堆積測量重複次數/循環次數     | 20 / 100                                  | 3 / 5    |
| 新行程匯入次數/捨棄的啟動取樣 | 400 / 3                                   | 3 / 1    |
| GC                            | `--expose-gc`，每個堆積檢查點請求三次 GC  | 相同     |

Tinybench
6.2.3 提供可等待的迭代掛鉤與原始計時樣本，沒有間接依賴。statistics.mjs 合併全部批次，使用保守的 Student-t 誤差範圍與插值分位數。每個場景、規模與實作各用一個依序執行的 Node 工作行程。該行程內的計時取樣共享 JIT 狀態；每次匯入取樣都啟動新行程。所有計時操作都包含相同的 Effect.runPromise 橋接。準備、計數驗證與清理不計時，但卸載場景本身的清理計時。

報告提供平均值、p50、p99、ops/s、95% 相對誤差範圍，以及 Graft 平均值與對手平均值的比值。熱路徑批次的 ops/s 按單次服務呼叫或分發計算。RME 超過 5% 的列保留並標示為雜訊較大，不移除離群值。堆積增量保留 GC 導致的負值，不計算速度比。不控制 CPU 親和性、頻率、檔案系統快取與其他機器負載。僅憑檢查點成長不能斷言存在洩漏。

原有函式庫的計時情境在同一工作行程中按 2 秒批次繼續取樣，直到合併 RME 不超過 4%、累計計時工作達到 24 秒，或工作行程牆鐘時間達到 480 秒。保留全部樣本。重複檢查停止條件後，標稱 95% 區間只作描述，不保證序貫信賴涵蓋率。達到上限的高雜訊結果仍明確標示。僅預熱一次，後續批次保留 JIT 狀態。Remote 的固定取樣預算不變。

## 結果

唯一的完整執行包含 295 項測量與 136 個 N/A，沒有失敗。原有函式庫的 154 項計時測量 RME 全部低於 5%。runner 牆鐘時間為 4772.3 秒；稽核驗證 3164 次原生結束，遺留行程為零。仍有 98 項 Remote 測量與三項帶正負號的堆積增量 RME 超過 5%。

當 H=100 時，完整執行的 100 次分派批次在 Graft 中耗時 52.85
ms，在 cordis 中耗時 2.63 ms：每次處理函式呼叫分別為 5.29 µs 與 0.263
µs，相差 20.1 倍。

[完整報告](results/latest.md)
包含每種規模、比較比值、N/A 原因與語義解釋。[JSON](results/latest.json)
記錄環境、精確版本、程式碼雜湊、樣本數、批次歷史與原生結束稽核。無損原始樣本連結至被忽略的
`.cache/samples/`。快速模式預設輸出

從唯一的完整執行結果更新三種語言的表格：

```sh
devenv shell -- node packages/benchmarks/update-readmes.mjs results/latest.json
devenv shell -- treefmt
```

表格選取各情境的最大規模。數值為每批次平均值；memory-steady 使用位元組/外掛。`*`
表示 RME 超過 5% 或未定義。三種語言保留相同的情境與欄位識別字。

<!-- results:start -->

| Scenario           | Size | Unit     |   Graft | cordis | avvio |  Effect |  Node | emittery |
| ------------------ | ---: | -------- | ------: | -----: | ----: | ------: | ----: | -------: |
| cold-load          | 1000 | ms       | 212.037 | 86.267 | 6.512 |   3.617 |   N/A |      N/A |
| cold-dispose       | 1000 | ms       | 129.024 | 36.605 | 0.175 |   1.230 |   N/A |      N/A |
| fanout-load        | 1000 | ms       | 229.280 | 98.477 | 6.568 |  10.931 |   N/A |      N/A |
| fanout-withdraw    | 1000 | ms       | 154.158 | 43.024 |   N/A |   2.737 |   N/A |      N/A |
| fanout-restore     | 1000 | ms       | 185.885 | 61.085 |   N/A |  11.549 |   N/A |      N/A |
| chain              |  100 | ms       |  45.806 | 25.256 | 0.695 |   1.330 |   N/A |      N/A |
| service            |    1 | ms       |   1.735 | 54.431 | 0.093 |   1.585 |   N/A |      N/A |
| events-emit        |  100 | ms       |  52.854 |  2.632 | 0.067 |   1.306 | 0.067 |    0.777 |
| events-sequential  |  100 | ms       |  54.776 |  3.719 |   N/A |   1.559 |   N/A |    0.770 |
| events-parallel    |  100 | ms       |  78.686 |  5.008 |   N/A |  16.697 |   N/A |    2.143 |
| events-bail        |  100 | ms       |  52.720 |  2.593 |   N/A |   1.472 |   N/A |      N/A |
| events-serial-bail |  100 | ms       |  53.139 |  3.497 |   N/A |   1.387 |   N/A |      N/A |
| events-waterfall   |  100 | ms       |  95.097 | 11.016 |   N/A |  12.778 |   N/A |      N/A |
| config-update      |    1 | ms       |   0.120 |  0.040 |   N/A |   0.002 |   N/A |      N/A |
| config-restart     |    1 | ms       |   0.237 |  0.109 |   N/A |   0.006 |   N/A |      N/A |
| memory-cycles      |   10 | B/batch  |  31828* | 23860* |   N/A |   7649* |   N/A |      N/A |
| memory-steady      | 1000 | B/plugin |   33908 |  10264 |   821 |    2089 |   N/A |      N/A |
| import             |    1 | ms       | 242.159 |  4.409 | 6.126 | 230.756 | 0.173 |    1.988 |

<!-- results:end -->

## 語義邊界

| 函式庫          | 比較邊界                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Graft           | 等待 Active，而非僅完成註冊。設定場景解碼 Schema.Int；事件呼叫恢復上下文，並擁有各自的作用域。                                                |
| cordis          | 固定為 4.0.0-rc.12；等待 inertia 並檢查狀態。serial 可以提早傳回；emit/bail 同步執行。                                                        |
| avvio           | 依序啟動並執行關閉掛鉤。執行期間卸載與重新啟動為 N/A。整個載入器關閉與手動服務連接明確標示為替代測量。events-emit 使用其繼承的 EventEmitter。 |
| Effect          | 明確連接 Layer/Scope，手動停止及重建消費者；平行廣播使用 PubSub，其他模式使用手寫迴圈。不聲稱具有自動回應依賴變化的圖。                       |
| Node / emittery | 僅比較分發。Node emit 執行完同步主體後傳回；emittery 延後並等待監聽器。兩者都不提供 bail 或中介軟體。                                         |

設定比較啟用 Graft 驗證，不為 cordis 安裝選用 schema。waterfall 僅比較輸出包裝：兩者傳遞 next 輸入與重複呼叫 next 的行為不同。所有處理器主體同步執行，因此事件表不衡量非同步 I/O 吞吐量。各場景報告標示替代測量，並提供可驗證的其他解釋。

## 來源與檢查

根目錄測試命令與工作行程池維持不變。Remote 連線見證在同一協調行程中依序執行，使用獨立根作用域並驗證原生結束。目前 runner 行程歸屬稽核與短 Unix 路徑介接以 Linux 為目標。

根目錄的 `devenv.nix`
將龐大的產生結果 JSON 排除在格式化之外。來源檔案與 Markdown 仍執行格式化。

[SOURCES.md](SOURCES.md) 列出來源檔案路徑、行號、常數、完成條件與 N/A 證據。
[等價性測試](test/equivalence.test.ts)
在清理前後檢查啟用、終結器、處理器、服務呼叫的次數，以及設定更新與傳回結果，並檢查重複卸載循環。
[執行器測試](test/runner.test.ts)
檢查新行程匯入與模組入口不主動執行工作。實作檢查與效能解讀分開記錄。

```sh
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm build
devenv shell -- treefmt
```

根目錄改動註冊 bench 命令與型別檢查專案，並將產生的結果 JSON 排除在格式化之外。現有套件發現、測試矩陣與發布發現邏輯已支援此私有套件。未修改 core、loader 或其他現有套件的原始碼。

只對計時操作進行剖析，排除根環境準備、觀察斷言與釋放。原始 CPU 剖析檔案保留在被忽略的快取中。取樣會擾動計時；剖析用於解釋執行路徑，不能取代基準估計。

```sh
devenv shell -- node packages/benchmarks/profile.mjs --scenario events-emit --implementation graft --size 100 --calls 100
devenv shell -- node packages/benchmarks/profile.mjs --scenario cold-load --implementation cordis --size 1000 --calls 1
```
