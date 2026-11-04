# 远程 worker

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

宿主请子进程转换文本 `hello`。子进程发布 `Formatter`，宿主注入服务后得到
`Worker: HELLO` 和子进程 PID。宿主只导入契约，不导入 worker 实现。

## 运行

使用 Linux 或 macOS，以及 Node.js 22.22 或更高版本。在仓库根目录执行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-worker start
devenv shell -- pnpm --filter @graftland/sample-remote-worker test
```

程序输出
`Worker: HELLO (child ..., host ...)`，两个 PID 不同；随后关闭作用域，等待子进程退出。不需要证书或网络服务。测试验证结果、独立 PID 和退出确认；它构建自己的子进程可执行文件，可以和包测试并行运行。

## 文件

| 文件                         | 作用                                 |
| ---------------------------- | ------------------------------------ |
| `src/contract.ts`            | 配置、服务 key、RPC 映射和实现位置。 |
| `src/worker.ts`              | 在子进程发布文本转换服务。           |
| `src/host.ts`                | 加载代理、注入服务并调用。           |
| `src/main.ts`                | 提供 Node 服务、运行宿主并输出结果。 |
| `test/remote-worker.test.ts` | 用真实子进程验证调用和清理。         |

`WorkerUnavailable`
把连接失败保留在服务的类型化错误通道里。调用不会重试。子进程拥有普通操作系统权限，独立进程不等于安全沙箱。

## 放到另一台机器运行

[remote-runner](../remote-runner)
示例通过双向 TLS 在真实 runner 上运行插件，并从 `graft.yml`
加载。它的 README 讲了证书、在 runner 上安装包以及启动
`graft-remote serve`。要让本示例连接runner，在 `src/main.ts` 里把 `target` 换成
`Remote.runner(...)`，并设置
`contractModule: "@graftland/sample-remote-worker/contract"`。本示例的测试只运行本机 target。
