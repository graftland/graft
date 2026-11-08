# 网关集成

替换注入的集成单元时，网关保持同一条上游连接。

## 运行

```sh
devenv shell -- pnpm install --frozen-lockfile
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start Worker Overlap
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start Process Restart
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start Runner Restart
```

命令启动独立内核进程，捕获已构建的 JavaScript，保持一个旧代一元调用，升级到版本 2，并按 Change
id 重连控制通道。

## 观察

报告显示 Accepted、版本 1 与 2、一个网关单元和上游会话、ExplicitTarget 选择原因、当前代码健康状态、旧单元原生退出、零剩余 Change 租约与未确认单元、剩余预算和原始 cause。

## 边界

Worker 是故障边界。本示例不隔离不可信代码，不保证网关或内核死亡后的会话延续，也不以强制退出证明 finalizer 成功。
