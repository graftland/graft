# Remote worker

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

宿主两次调用同一个 `Formatter` 服务：先用 `Remote.local()` 启动子进程，再用
`Remote.worker()` 启动 Node worker。两者都返回 `Worker: HELLO`。宿主只导入契约。

## 运行

使用 Linux 或 macOS、Node.js 22.22 或更高版本。在仓库根目录运行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-worker start
devenv shell -- pnpm --filter @graftland/sample-remote-worker test
```

local 结果的 PID 与宿主不同，thread 为 0；worker 与宿主共享 PID，threadId 为正数。每个 scope 关闭时都会 dispose 代理并等待退出。两者都不需要 runner 或凭证，generation 每次都是 1。

`src/host.ts` 显式加载 `host/local`、`host/worker`，再加载代理和消费者。
`src/contract.ts` 定义 RPC 映射，`src/worker.ts` 提供服务， `src/main.ts`
依次选择两个 target。测试验证两次返回值、进程与线程身份，以及子进程退出。先 build 再运行：worker
target 会启动已安装的 remote worker 可执行文件。

`WorkerUnavailable` 将连接失败保留为服务错误，调用不会重试。Node
worker 与宿主共享进程和权限，只隔离执行，不隔离文件或网络访问。子进程也拥有正常的操作系统权限。

wss/JWT runner、持久化 generation 和 SSH/stdio 用法见
[remote-runner](../remote-runner/README.zh-CN.md)。
