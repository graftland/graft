---
title: 在另一台机器上运行插件
description: 部署 runner，在上面安装插件包，再让宿主通过 wss + JWT 或 SSH 连接。
---

本指南介绍如何部署 runner 并让宿主连接它。前提是你已经像[快速上手](../getting-started/)那样，把插件拆成了契约和实现。主线使用
`wss` 加 JWT，这也是真实网络部署通常的样子；SSH 和 Unix 套接字放在最后介绍。

## Runner 是什么

**runner** 是用 `graft-remote serve`
启动、供宿主连接的长期运行进程。对每个连接，它会：

1. 确认宿主是谁（认证）。
2. 查找宿主指定的插件包。这个包必须事先安装在 runner 上，宿主从不发送代码。
3. 为它启动插件进程，并在宿主用完、宿主消失或有更新的副本替换它时停止该进程。

runner 启动的每个插件都属于一个**实例**：一个稳定的名字，默认就是宿主配置条目的
`id`。runner 在磁盘上维护一个小小的**状态目录**，记录每个实例被替换了多少次。这为什么重要，见[重启、替换与停止](../restarts/)。

## 1. 准备机器

runner 需要：

- Linux 或 macOS，Node.js 22.22 或更高版本。
- 一个**安装目录**，在它的 `node_modules` 中装好
  `@graftland/plugin-remote`、构建好的插件包及其依赖。runner 按包名在这里查找契约包。

由于 runner 按包名查找插件，契约要随一个包发布，并在包的 `exports` 中导出，例如
`my-plugin/contract`。宿主也要安装同一个包，因为宿主同样要导入契约。

runner 运行期间不要改动安装目录。部署新版本时，先安装，再重启用到它的插件（见[重新部署插件](../restarts/#重新部署插件)）。

## 2. 准备服务器证书

使用 `wss`
时，宿主会校验 runner 的 TLS 证书，所以 runner 需要一张名称与宿主连接地址相符的证书。任何证书工具都可以；`graft-remote certificates`
可以替你生成一个小型私有 CA 和服务器证书：

```sh
graft-remote certificates --out certs --server runner.example
```

这会写出 `certs/ca.crt`、`certs/ca.key`、`certs/server.crt` 和
`certs/server.key`。`ca.key` 由管理员保管，`server.crt` 与 `server.key`
放到 runner 上，`ca.crt` 交给每个宿主，让它们信任这个 runner。

## 3. 编写 `runner.yml`

runner 用一个 Graft 配置文件配置，其中包含一个 `remote/runner` 条目：

```yaml title="runner.yml"
- id: runner
  name: remote/runner
  config:
    root: ./installation
    state: ./state
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth:
          jwt:
            issuer: https://issuer.example
            audience: [graft]
            algorithms: [ES256]
            keys:
              jwksUrl: https://issuer.example/.well-known/jwks.json
```

| 字段     | 含义                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| `root`   | 第 1 步的安装目录。                                                                   |
| `state`  | runner 存放记录的地方，不存在时会自动创建。                                           |
| `listen` | 宿主从哪里连接、如何认证。每个地址一项。                                              |
| `auth`   | 这里是来自你的签发方的 JWT，用它公布的公钥校验。宿主的身份取自 token 的 `sub` claim。 |

所有路径，包括 `root`、`state` 和证书文件，都相对于
`runner.yml`，而不是启动 runner 时所在的目录。[选择传输与认证](../transport-auth/)介绍其他
`auth` 选项，[参考](../reference/#runner-条目)列出全部字段及默认值。

照看好状态目录：

- 它必须位于本地文件系统。
- 同一时间只能有一个 runner 使用它。第二个 runner 使用同一目录时会以
  `StateDirectoryLocked` 启动失败。
- 重启时要保留它。它记录了替换次数，以及仍在运行的插件进程。
- 如果某个部署的身份仍在别处使用，不要给它换上全新的空状态目录，否则计数会从头开始。

## 4. 启动 runner

```sh
graft-remote serve --config runner.yml
```

`serve` 只接受 `--config`。runner 只在启动时读取一次
`runner.yml`，修改后要重启才会生效。

- 只有所有 listener 都就绪后，runner 才算启动完成。启动期间任一 listener 失败，runner 会关闭已经打开的资源，并带着原因退出。
- 启动之后某个 listener 失败时，runner 记录
  `Remote listener failed`，其他 listener 和正在运行的插件照常工作。

请让服务管理器在 runner 停止时一并停止它的所有后代进程，例如 systemd 的
`KillMode=control-group`。插件进程是 runner 的后代，而 runner 自身的检查有其局限（见[租约](../restarts/#租约)）。

## 5. 连接宿主

在宿主上，让 `remote` 条目指向 runner：

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      url: !env RUNNER_URL
      ca: ./certs/ca.crt
      auth:
        jwt:
          token: { file: ./runner-token.txt }
    config:
      greeting: Hello
```

把 `RUNNER_URL` 设为 `wss://runner.example:7443`，然后启动宿主：

```sh
graft start host.yml
```

- `contract` 现在是包名。宿主从自己的安装中导入它，runner 在自己的 `root`
  下解析同一个名字。
- `ca`
  是第 2 步生成的 CA。如果 runner 的证书由宿主本来就信任的 CA 签发，可以省略。
- `token: { file: ... }`
  在宿主每次连接时读取文件，因此轮换 token 不必重启。文件的全部内容原样作为 token：末尾的换行符也会成为 token 的一部分，所以写文件时不要带换行。`token: "..."`
  则直接以值的形式给出 token。
- 路径相对于 `host.yml`。

条目的 `id`，也就是
`greeter`，就是 runner 上的实例名。请保持它稳定：loader 会把生成的 id 保存到配置文件里，重启后仍然有效。

### 实例名

实例名决定一个连接属于哪个正在运行的插件。同一实例的新连接会替换旧的插件进程。注意以下情况：

- **两个宿主，身份相同、实例名相同。**
  它们在 runner 上共用一个位置，会不停地互相替换。请给每个宿主独立的身份，或者设置不同的
  `connect.instance`。
- **同一个条目派生出两个远程插件。**
  子插件继承条目的 id，因而会冲突。请分别显式设置 `connect.instance`。
- **嵌入的分组。** 分组 id 只在同级之间唯一。请确认最终的名字不重复。
- **不经过 loader 加载。** 直接加载的 `Remote.plugin` 没有条目 id。请设置
  `connect.instance`，否则加载会以 `MissingInstance` 失败。

### 检查已安装的版本

宿主可以要求 runner 在插件启动前装有指定版本：

```yaml
connect:
  url: !env RUNNER_URL
  expect:
    version: 1.4.0
```

`version` 与契约包 `package.json` 中的版本比较。`digest`
则比较包内文件的SHA-256，不含
`node_modules`，因此不覆盖依赖。只有要求 digest 时 runner 才会计算它。不匹配时以
`PackageError` 失败，错误消息中会同时给出期望值和实际值。

### 在代码中提供凭证

使用 `Remote.plugin` 时，凭证也可以是一个 Effect，每次连接运行一次：

```ts
import * as Remote from "@graftland/plugin-remote"
import { Config } from "effect"
import { contract } from "my-plugin/contract"

export default Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		url: "wss://runner.example:7443",
		instance: "greeter",
		auth: { jwt: { token: Config.Redacted("RUNNER_TOKEN") } },
	},
	config: { greeting: "Hello" },
})
```

- token 的 Effect 返回 `Redacted<string>`。mTLS 的 Effect 返回 PEM 格式的
  `{ cert, key }`，其中 key 经过 redact。
- 如果凭证需要某个服务，就用 `{ inject: [Vault], read: ... }`
  代替单纯的 Effect。Remote 会在一个注入这些服务的子插件中运行它；其中任何服务被撤回，远程插件都会停止，直到服务恢复。

## 改用 SSH 连接

如果宿主本来就能通过 SSH 访问 runner 所在的机器，可以不用网络 listener。宿主把
`ssh` 当作命令运行，通过它的标准输入输出与 `graft-remote serve`
通信，认证和加密由 SSH 负责。

在 runner 上写一份只有一个 `stdio`
listener 的配置，并给每个 SSH 身份单独的状态目录：

```yaml title="/srv/graft/stdio.yml"
- id: runner
  name: remote/runner
  config:
    root: /srv/graft/installation
    state: /srv/graft/state/billing
    listen:
      - stdio: true
        identity: billing
```

在 runner 账户的 `authorized_keys` 中，把宿主的密钥限制为只能执行这条命令：

```text
restrict,command="/usr/local/bin/graft-remote serve --config /srv/graft/stdio.yml" ssh-ed25519 AAAA... billing-host
```

在宿主上使用 `connect` 的 `command` 形式：

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      command: [ssh, -T, billing@runner.example]
    config:
      greeting: Hello
```

它的行为如下：

- SSH 负责认证宿主。`identity` 只是给宿主在 runner 上一个稳定的名字，默认是
  `anonymous`。不要给 `command` 连接或 `stdio` listener 写 `auth`，`none`
  也不行。
- 每个 SSH 会话运行各自的
  `serve`。连接结束时，它会停止插件、确认插件已退出、释放状态目录，然后以状态码 0 退出。出错时以非零状态码退出并报告原因。
- 同一状态目录上同时出现的第二个会话会被拒绝。
- 标准输出承载协议字节，日志写到标准错误。不要分配终端（用
  `-T`），也不要向标准输出打印 banner。
- `stdio` listener 必须是所在 runner 的唯一 listener。
- SSH 退出并不能证明插件进程已经停止，只有 runner 自己的确认才算数。

`command` 还接受可选的 `cwd` 和 `env` 字段，作用于它运行的命令。

## 通过 Unix 套接字连接

在同一台机器上，Unix 套接字可以完全绕开网络，访问权限由套接字文件的权限控制：

```yaml title="runner.yml"
listen:
  - unix: ./runner.sock
    auth:
      none:
        identity: billing
```

```yaml title="host.yml"
connect:
  unix: /srv/graft/runner.sock
```

`none` 不做任何检查，直接给每个连接上来的宿主 `billing`
这个身份。只有当文件权限已经决定了谁能连接时，这样做才合理。Unix 套接字上也可以使用 bearer 或 JWT 认证。

## 多个 listener

一个 `remote/runner` 条目可以有多个 `listen` 元素，例如给远程宿主用
`wss`，给本机宿主用 Unix 套接字。它们共享同一组实例：无论宿主从哪个 listener 进来，相同的身份和实例名都指向同一个插件。一个 runner 的所有 listener 合起来最多只能使用一个 JWT 签发方。

## 接下来

- [选择传输与认证](../transport-auth/)：在 mTLS、bearer 与 JWT 之间选择，并理解各种警告。
- [重启、替换与停止](../restarts/)：重新部署或断网时会发生什么。
