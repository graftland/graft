---
title: Runner
description: 部署 runner、让宿主连接进来时看这一页。
---

部署 runner、让宿主连接进来时看这一页。这里介绍插件安装目录、监听配置、状态目录和 SSH 接入。

## 配置 runner

在 Linux 或 macOS 上使用 Node.js
22.22 或更新版本。安装 remote、构建后的插件包及其依赖。runner 在 `root`
下解析契约包名，宿主不会上传代码；运行时不要修改安装目录。建议由外部 supervisor 管理 runner 及全部后代进程，例如 systemd 的
`KillMode=control-group`。

```yaml title="runner.yml"
- id: runner
  name: remote/runner
  config:
    root: ./installation
    state: ./state
    lease: 15 seconds
    grace: 5 seconds
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth:
          mtls:
            ca: ./certs/ca.crt
      - unix: ./runner.sock
        auth:
          none:
            identity: billing
```

```sh
graft-remote serve --config runner.yml
```

`runner.yml` 中的路径，包括 `root`、`state`
和证书文件，都相对于这个配置文件所在的目录，不是进程工作目录。

`serve` 只接受 `--config`。一个 runner
entry 管理一个 supervisor 和全部 listener，它们共享实例命名空间。所有 listener 就绪才算启动成功；启动失败会关闭已打开的资源，运行期间一个 listener 失败则不会停止其他 listener 或 supervisor。一个 runner 只能配置一个 JWT 签发者；声明 issuer 的第三方认证器也受此约束。bearer 的 token 文件不算签发者。

每个 entry 都有私有的能力提供者。同一种能力可以在两个 entry 中用不同配置。第三方插件写成
`transport: { name: "my-listener", config: {...} }` 或
`auth: { name: "my-authenticator", config: {...} }`；name 按应用的 loader 规则解析，内置简写也展开成同样的引用。

`state`
必须放在本地文件系统上，同一时间只能由一个 supervisor 持有。跨重启保留它，其中记录了 generation 和未完成的执行。不要用空状态目录复用仍在运行的部署身份。

证书、认证配置和 WARN 见[传输与认证](../transport-auth/)；租约与 grace 的期限见[替换与停止](../lifecycle/)。

## Stdio 会话

stdio 只写一个 `listen`
元素：`{ stdio: true, identity: billing }`，不能与其他 listener 共存。stdout 只写协议字节，日志去 stderr。EOF 后先停止执行单元、确认退出、释放状态锁，再以 0 退出；清理失败保留 cause 并非零退出。同一状态目录的并发调用会失败。认证交给 SSH
`authorized_keys` 强制命令等外部机制。SSH 退出本身不代表远端执行单元已经退出。

## 通过 SSH 连接

在 runner 上安装插件包，为这个 SSH 身份使用独立的状态目录。配置里只放一个 stdio
listener：

```yaml title="stdio.yml"
- id: runner
  name: remote/runner
  config:
    root: /srv/graft/installation
    state: /srv/graft/state/billing
    listen:
      - stdio: true
        identity: billing
```

宿主使用 command 形式的 `connect`，YAML 也可以写同样的数组：

```ts
Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		command: ["ssh", "-T", "billing@runner.example"],
		instance: "greeter",
	},
	config: { greeting: "Hello" },
})
```

在 runner 账户的 `authorized_keys`
里，把这个公钥限定为固定命令。请换成实际部署的可执行文件路径和公钥：

```text
restrict,command="/usr/local/bin/graft-remote serve --config /srv/graft/stdio.yml" ssh-ed25519 AAAA... billing-host
```

不要分配终端，也不要把欢迎消息写到 stdout，它只承载协议字节。SSH 验证宿主身份，`identity`
指定稳定的 runner 身份名。同一状态目录不允许第二个调用并发运行。SSH 退出不等于执行单元已经停止。
