# 聊天機器人

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

一個聊天機器人，它的命令、過濾器和整合都是外掛。維運人員可以在機器人持續回應的同時，載入、重新設定和卸載這些外掛。

## 問題

機器人的功能會越來越多：`/roll`、`/weather`、一個審核過濾器，下個月還會有新的整合。每個功能都要註冊處理器、持有連線，並相依於其他部分。如果手工實作，通常需要：

- 一個中央命令註冊表，以及在功能關閉時移除其處理器的程式碼（或者靠重新啟動來關閉功能）；
- 一段 `/help` 文字，必須與目前啟用的功能保持同步；
- `if (weatherClient)`
  檢查或啟動順序規則，確保命令不會先於它所需的用戶端執行，也不會比用戶端活得更久；
- 對設定錯誤的因應方案，因為一個功能的錯誤可能讓整個機器人無法啟動。

## Graft 的做法

- **處理器屬於註冊它的外掛。** 命令就是 `apply` 中的
  `Event.on(Command, ...)`。卸載外掛時，它的處理器隨之移除，沒有註冊表需要清理。`/help`
  用 `Event.parallel(Describe)` 收集各行內容，所以它列出的正是目前已載入的命令。
- **相依關係控制啟動與關閉。** `weather` 宣告了
  `inject: [Forecasts]`。沒有提供者時，它保持
  `Pending`，它的命令也不存在。`forecasts` 載入後，`weather`
  自動啟動。`forecasts` 卸載時，`weather` 會在天氣用戶端中斷連線_之前_先停止。
- **設定變更可以原地生效。** `moderation`
  回傳一個更新函式，所以新的詞表不必重新啟動過濾器就能生效。
- **失敗只影響局部。** 無效的設定只會讓對應的外掛失敗，並附帶完整的
  `SchemaError`。其他命令繼續回應。

## 執行

在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-chat-bot start
```

輸出中值得注意的內容：

- 第 2 步：`weather is Pending, waiting for .../Forecasts`，而且 `/weather`
  是未知命令。
- 第 3 步：`forecasts` 一載入，`/weather` 就出現在 `/help` 中。`weather`
  沒有被動到。
- 第 5 步：`Moderation now blocks 2 words`，在它之前沒有 `Moderation stopped`。
- 第 7 步：`/weather is gone` 的日誌先於
  `Disconnected from the weather service`。

`devenv shell -- pnpm --filter @graftland/sample-chat-bot test`
會檢查上述每一項說法。

## 檔案

| 檔案                        | 說明                                                |
| --------------------------- | --------------------------------------------------- |
| `src/Chat.ts`               | 外掛共用的事件、`command()` 和 `receive(message)`。 |
| `src/Forecasts.ts`          | `Forecasts` 服務鍵。                                |
| `src/plugins/help.ts`       | `/help`，根據目前已載入的命令產生。                 |
| `src/plugins/dice.ts`       | `/roll 2d6`。                                       |
| `src/plugins/forecasts.ts`  | 發布 `Forecasts`。用來代替天氣 API 用戶端。         |
| `src/plugins/weather.ts`    | `/weather <city>`，需要 `Forecasts`。               |
| `src/plugins/moderation.ts` | 移除含有違禁詞的訊息的中介層。                      |
| `src/main.ts`               | 腳本化的對話。                                      |
| `test/chat-bot.test.ts`     | 上述行為的測試。                                    |
