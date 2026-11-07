# 04 · Failures

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

一開始，用戶端無法連線。Graft 會記錄每次失敗並清理外掛，然後依排程重試。另一個外掛則始終保持執行。

你將學到：

- `apply` 失敗時，fork 會變成 `Failed`，Graft 會記錄錯誤日誌。
- `retry: Schedule.spaced("300 millis")` 告訴 Graft 在每次失敗 300
  ms 後重試。沒有 `retry` 時，失敗的外掛會一直等到它的設定改變。
- `Plugin.fork`
  執行背景任務，這裡的任務是心跳。這個任務屬於外掛，並隨外掛一起停止。
- 一個外掛失敗時，其他外掛不受影響。

所有程式碼都在 [`src/main.ts`](src/main.ts) 中。

## 執行

請在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-failures start
```

```text
Connecting, attempt 1
Plugin "@graftland/sample-failures/main/makeClient" failed
  ConnectionRefused: Connection refused on attempt 1
heartbeat: still running
heartbeat: still running
Connecting, attempt 2
Plugin "@graftland/sample-failures/main/makeClient" failed
  ConnectionRefused: Connection refused on attempt 2
heartbeat: still running
Connecting, attempt 3
Connected
The client is running; unloading everything.
```

## 試一試

- 把排程改成 `Schedule.exponential("100 millis")`。這樣等待時間會逐次增長：100
  ms，然後 200 ms。

下一個：[05 · Config file](../05-config-file)。
