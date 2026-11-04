---
title: Runner
description: 用 `graft start runner.yml` 在另一台机器上运行插件。
---

**runner**
是一个供宿主连接的长期运行的进程。它认证每个宿主，在已安装的包中找到宿主指定的插件包，再为它启动插件进程。宿主从不发送代码。

## 部署 runner

1. **安装**
   `@graftland/cli`、`@graftland/plugin-remote`、构建好的插件包及其依赖，放进某个安装目录的
   `node_modules`；系统为 Linux 或 macOS，Node.js 22.22 或更高。通过包的
   `exports` 暴露每个契约，例如 `my-plugin/contract`，并在宿主上也安装同一个包。
2. **编写**只含一个 `remote/runner` 条目的 `runner.yml`。
3. **启动** runner：`graft start runner.yml`。
4. **让**宿主的 `remote` 条目指向它，然后运行 `graft start host.yml`。

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

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      url: wss://runner.example:7443
      ca: ./certs/ca.crt
      auth:
        jwt:
          token: { file: ./runner-token.txt }
    config:
      greeting: Hello
```

| 字段     | 必填 | 默认值       | 含义                                                           |
| -------- | ---- | ------------ | -------------------------------------------------------------- |
| `root`   | 是   | —            | 安装目录。契约包从它的 `node_modules` 中解析。                 |
| `state`  | 是   | —            | 状态目录，不存在时自动创建。规则见下表。                       |
| `lease`  | 否   | `15 seconds` | 实例的默认[租约](../lifecycle/#租约与断网)。                   |
| `grace`  | 否   | `5 seconds`  | 从中断插件进程到杀掉它的时间。                                 |
| `listen` | 是   | —            | listener，每个地址一个。见 [`listen` 的形式](#listen-的形式)。 |

| 规则                  | 说明                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| **路径**              | 相对于 `runner.yml`，包括 `root`、`state` 和证书文件。                                                       |
| **安装目录**          | runner 运行期间保持不变。部署新版本时，先安装新包，再在宿主上重启该条目。                                    |
| **状态目录**          | 放在本地文件系统上，同一时间只给一个 runner 用，重启后保留。第二个 runner 会以 `StateDirectoryLocked` 失败。 |
| **全新状态**          | 身份仍在别处使用时，不要换一个空的状态目录：generation 会从头开始。                                          |
| **启动命令**          | `graft start runner.yml`，日志写到标准错误。只有单个 stdio listener 时才加 `--stdio`。                       |
| **启动**              | 所有 listener 都就绪才算启动完成。失败时关闭已打开的部分，以 原始错误 非零退出。                             |
| **listener 稍后失败** | runner 记录 `Remote listener failed`，其他 listener 和插件继续运行。                                         |
| **服务管理器**        | 在一个会停止 runner 所有后代进程的服务管理器下运行，例如设置了 `KillMode=control-group` 的 systemd。         |

## `listen` 的形式

| 形式                          | 字段                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `url: ws://host:port`         | 不写 `cert` 和 `key`。                                                          |
| `url: wss://host:port`        | `cert` 和 `key`：服务器证书和私钥。                                             |
| `unix: path`                  | 要创建的套接字文件。                                                            |
| `stdio: true`                 | `identity`，默认 `anonymous`。不接受 `auth`。见 [SSH 与 stdio](#ssh-与-stdio)。 |
| `transport: { name, config }` | [自定义 listener](../capabilities/)。                                           |

- 每个元素取一种传输形式，最多一个 `auth`，见[传输与认证](../transport-auth/)。
- WebSocket listener 只服务一个路径 `/graft`，子协议为 `graft-remote.v1`。`url`
  的路径必须为空或 `/graft`。没有其他 HTTP 端点，也没有健康检查。
- 所有 listener 共用一套实例，合计最多使用一个 JWT 签发方。

## 实例

**实例**是 runner 上一个插件位置的名字。它与认证得到的宿主**身份**一起，决定一个连接属于哪个插件进程。同一身份、同一实例的新连接会替换旧进程，这次启动拿到下一个
[generation](../lifecycle/#generation-与-fencing)。状态目录按身份和实例分别记录 generation。

| 情况                             | 怎么办                                                                    |
| -------------------------------- | ------------------------------------------------------------------------- |
| 默认名称                         | loader 条目的 `id`。保持它稳定；loader 会把生成的 id 保存在配置文件里。   |
| 两个宿主，身份和实例名都相同     | 它们会互相替换。给每个宿主独立的身份，或设置不同的 `connect.instance`。   |
| 从同一个条目 fork 出两个远程插件 | 子插件继承条目 id。给每个都设置 `connect.instance`。                      |
| 嵌入的分组                       | 分组 id 只在兄弟之间唯一。检查最终得到的名字。                            |
| 不经 loader 使用 `Remote.plugin` | 没有条目 id。设置 `connect.instance`，否则加载以 `MissingInstance` 失败。 |

`connect.expect` 在插件启动前锁定 runner 上安装的内容：

```yaml
connect:
  url: wss://runner.example:7443
  expect:
    version: 1.4.0
```

| 字段      | 比较对象                                                                                     |
| --------- | -------------------------------------------------------------------------------------------- |
| `version` | runner 上契约包 `package.json` 中的 `version`。                                              |
| `digest`  | 包内文件的 SHA-256 十六进制摘要，排除所有 `node_modules`，因此不涵盖依赖。只在设置时才计算。 |

不匹配时以 `PackageError` 失败，消息中同时显示两个值。

## SSH 与 stdio

`stdio`
runner 通过标准输入输出通信，宿主可以用 SSH 之类的命令连到它。认证和加密由 SSH 负责。

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

在 runner 账户的 `authorized_keys` 中把宿主的密钥限制为这条命令，再用 `command`
连接：

```text
restrict,command="/usr/local/bin/graft start /srv/graft/stdio.yml --stdio" ssh-ed25519 AAAA... billing-host
```

```yaml
connect:
  command: [ssh, -T, billing@runner.example]
```

| 规则              | 说明                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| **不写 `auth`**   | `command` 和 `stdio` 都不接受 `auth`，`none` 也不行。`identity` 只是给宿主起名。                            |
| **唯一 listener** | `stdio` listener 是它所在 runner 唯一的 listener。                                                          |
| **独立状态目录**  | 每个 SSH 身份用自己的状态目录。同一时间在同一目录上的第二个会话会被拒绝。                                   |
| **会话结束**      | 输入结束时，`graft start` 停止插件、确认它已退出、释放状态目录，然后以 0 退出；失败时以非零退出并给出原因。 |
| **干净的输出**    | 标准输出承载协议字节。使用 `-T`，不要打印 banner。                                                          |
| **退出证明**      | SSH 退出不能证明插件已经停止，只有 runner 的确认才能。                                                      |
