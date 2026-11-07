# 04 · Failures

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

一开始，客户端无法连接。Graft 会记录每次失败并清理插件，然后按计划重试。另一个插件则始终保持运行。

你将学到：

- `apply` 失败时，fork 会变成 `Failed`，Graft 会记录错误日志。
- `retry: Schedule.spaced("300 millis")` 告诉 Graft 在每次失败 300
  ms 后重试。没有 `retry` 时，失败的插件会一直等到它的配置改变。
- `Plugin.fork`
  运行后台任务，这里的任务是心跳。这个任务属于插件，并随插件一起停止。
- 一个插件失败时，其他插件不受影响。

所有代码都在 [`src/main.ts`](src/main.ts) 中。

## 运行

在仓库根目录运行：

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

## 试一试

- 把计划改成 `Schedule.exponential("100 millis")`。这样等待时间会逐次增长：100
  ms，然后 200 ms。

下一个：[05 · Config file](../05-config-file)。
