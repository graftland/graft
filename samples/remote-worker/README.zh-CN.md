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

在 runner 机器上构建并安装本示例及其运行依赖。安装目录下必须有
`node_modules/@graftland/sample-remote-worker/package.json` 和构建后的 `dist`
文件。包导出了 `@graftland/sample-remote-worker/contract`。同时安装
`@graftland/remote`。这些都是工作区包，不以已发布到 registry 为前提。宿主和 runner 使用相匹配的契约版本。

准备专用 CA 签发的服务端和客户端证书。服务端证书必须匹配主机名，客户端证书恰好包含一个 SAN
URI，例如 `graft://demo`。然后运行已安装的可执行文件：

```sh
graft-remote serve --host 0.0.0.0 --port 7443 \
  --root /srv/graft/install --state /var/lib/graft \
  --cert /run/secrets/server.crt --key /run/secrets/server.key \
  --ca /run/secrets/clients-ca.crt --lease "15 seconds" --grace "5 seconds"
```

等待
`Listening`。建议交给外部进程管理器运行，停止时覆盖整个进程组或容器。重启时保留状态目录，运行期间不要修改已安装的包。

把 `src/main.ts` 中本机的 `formatInChild(...)` 调用换成：

```ts
formatInChild({
	contractModule: "@graftland/sample-remote-worker/contract",
	target: Remote.runner({
		instance: "formatter-demo",
		host: "runner.example",
		port: 7443,
		tls: { servername: "runner.example", ca, cert, key: Redacted.make(key) },
	}),
})
```

从 `@graftland/remote` 导入 `Remote`，从 `effect` 导入 `Redacted`。这里的
`ca`、`cert` 和 `key` 是激活时从宿主文件读取的 PEM 内容；将 `runner.example`
换成服务端主机名。[远程插件指南](https://graftland.github.io/graft/zh-cn/remote/)
给出了完整的 Effect Config 入口，用环境变量提供这些路径。重新构建，再执行
`start`；此时返回的 PID 属于 runner 机器。

直接调用时要提供 `instance`。通过 `graft.yml`
加载则可以省略，使用保存的条目 id。替换网络实例会先等待旧进程退出，再增加 generation。租约、停止结果及保证的边界见指南。本示例测试只运行本机 target。
