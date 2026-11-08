# @graftland/plugin-otlp

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

用一般 Graft exporter 外掛匯出一棵子樹的 span。宿主在獨立的 exporter
realm 中載入 `plugins`；內建的 `@graftland/plugin-otlp/http` 透過注入的
`HttpClient` 傳送 OTLP/HTTP。

```yaml
- id: traced
  name: "@graftland/plugin-otlp"
  config:
    url: !env OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    serviceName: shop
    headers:
      authorization: !env OTEL_AUTHORIZATION
    plugins:
      - id: server
        name: ./src/server.ts
```

| 欄位                      | 含義                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `url`                     | 必填的 OTLP/HTTP traces 端點。                                    |
| `serviceName`             | 必填的 `service.name` 資源屬性。                                  |
| `resource.serviceVersion` | 服務版本；預設為空字串（不加入版本屬性）。                        |
| `resource.attributes`     | 額外的 JSON 資源屬性；預設為 `{}`。                               |
| `headers`                 | 以 Redacted 儲存的 HTTP 標頭；預設為 `{}`。憑證透過 `!env` 傳入。 |
| `serialization`           | `json`（預設）或 `protobuf`。                                     |
| `compression`             | `none`（預設）或 `gzip`（Effect 壓縮至少 1 KB 的請求本文）。      |
| `exportInterval`          | 匯出間隔，單位毫秒；預設為 `5000`。                               |
| `maxBatchSize`            | 正整數；預設為 `1000`。                                           |
| `shutdownTimeout`         | 關閉時清空緩衝區所允許的毫秒數；預設為 `3000`。                   |
| `exporter`                | 第三方 exporter 的 `{ name, config }`，取代全部 HTTP 簡寫欄位。   |
| `plugins`                 | 要載入並追蹤的項目，寫法與 `graft.yml` 相同。                     |

數值選項也接受 `!env` 提供的字串。HTTP 簡寫欄位等同於
`exporter: { name: "@graftland/plugin-otlp/http", config: … }`。

## 自訂 exporter

```yaml
- id: traced
  name: "@graftland/plugin-otlp"
  config:
    exporter:
      name: graft-plugin-custom-traces
      config:
        destination: !env TRACE_DESTINATION
    plugins:
      - id: server
        name: ./src/server.ts
```

實作透過 `@graftland/plugin-otlp/Exporter` 發布穩定的 tracer 服務，其 key 為
`@graftland/plugin-otlp/Exporter`。用 `@graftland/plugin-otlp/Testing`
檢查服務發布、更新時的物件身分和關閉時的清空。內建與第三方實作使用相同的公開 API 和解析器。

| 修改                                       | 行為                                                                                                                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 設定或相容的 `exporter.config` 更新   | 子樹繼續執行。已開始的 HTTP span 留在舊 exporter；這些 span 結束後刷新並關閉舊 exporter。等待最長為舊設定的 `shutdownTimeout`；Effect 隨後為刷新單獨提供一個 `shutdownTimeout` 時限（總計最長為兩倍時限）。 |
| `plugins`                                  | 協調項目；未變更的項目保留 activation。                                                                                                                                                                     |
| Exporter 名稱，或將項目移入/移出 `plugins` | 重新啟動子樹或移動的項目，因為 provider、父層或 intercept 改變了。                                                                                                                                          |
| Exporter 失敗                              | 子樹等待 `Exporter` 服務；exporter 自身重試成功後，子樹恢復執行，無需修改設定。                                                                                                                             |
| 卸載                                       | 先停止子樹，再並行刷新並關閉所有剩餘 exporter。                                                                                                                                                             |

Effect 每棵子樹只有一個 tracer，沒有 fan-out 組合器；巢狀宿主會覆蓋外層追蹤。本套件只提供 HTTP
trace
exporter。其他傳輸、屬性擴充和廠商整合由第三方實作。本套件不提供日誌和指標匯出；第三方可以實作這些功能。

## 文件

- [日誌與追蹤](https://docs.graft.land/zh-tw/best-practices/observability/)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
