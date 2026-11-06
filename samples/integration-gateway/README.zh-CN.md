# 集成网关

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

替换独立打包的天气集成时，保留同一个 WebSocket 机器人会话。本地服务器模拟登录、心跳、会话 id 和消息，不需要机器人账号。

## 运行

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start
```

```sh
curl -X POST http://127.0.0.1:PORT/message/London
curl -X POST http://127.0.0.1:PORT/upgrade/v2
curl -X POST http://127.0.0.1:PORT/message/London
curl -X POST http://127.0.0.1:PORT/upgrade/broken-probe
```

把 `PORT` 换成输出的操作端口。第一条消息返回 v1 预报。升级返回
`Accepted`，下一条消息返回 v2。失败的 probe 返回携带 cause 的
`Aborted`，当前版本继续服务。按 Ctrl+C 停止。

要观察恢复，POST `/upgrade/broken-trial`，在它等待期间，从另一终端 POST
`/message/crash`。结果为
`Recovered`，之前固定的制品在新单元中启动。测试会故意损坏该旧制品，演示
`RecoveryFailed`。

端点监听 localhost，只接受示例中列出的版本。它用于本地演示，不是经过身份验证的部署服务。

## 包与资源归属

| 部分                             | 职责                                                    |
| -------------------------------- | ------------------------------------------------------- |
| `contract/`                      | 公开服务 key、RPC 操作标识和业务输入。                  |
| `v1/`、`v2/`                     | 独立打包的实现，声明 `provides` 和 `overlap`。          |
| `broken-probe/`、`broken-trial/` | probe 拒绝和试运行窗口内的失败。                        |
| `src/gateway.ts`                 | 宿主拥有的 WebSocket 协议适配器和注入服务的命令消费者。 |
| `src/app.ts`                     | 制品捕获、Loader 条目 `forecasts` 和操作端点。          |

启动器把 Graft 构建后的公开导出打包到仓库之外的临时项目，安装它们，编译并打包契约和实现，再安装这些 tarball。消费者编译不使用源码别名或私有导入。同一套安装后的代码用于 Worker 和子进程。

启动时在临时项目中创建 `config/graft.yml`。`forecasts` 条目指定
`@graftland/plugin-remote`、已安装的契约、相对的制品目录和直连部署方式。操作端点调用
`Graft.transition({ target: "forecasts", candidate })`，不重写文件。Loader 在持久化前拒绝托管树的编辑。

制品只固定包的字节内容。外部运行时依赖不会被捕获或固定版本。退出时删除临时项目及其制品。

## 验证

```sh
devenv shell -- pnpm --filter @graftland/sample-integration-gateway test
```

测试运行两种直连部署方式和真实的 `graft start` 命令，检查：

- 只登录一次，会话 id 不变，网关和消费者的激活次数不变。
- 正常升级和重复升级后响应更新，旧单元有退出证据。
- probe cause、试运行恢复和恢复失败期间，会话仍然保留。
- 已接纳的慢 v1 请求在切换后仍由 v1 完成。
- 被拒绝的 Loader 编辑不改变文件和已接受目标。

工作区测试套件运行同一套已安装消费者测试。

## 配置发布

`src/release-app.ts` 通过公开的发布插件运行同一个 WebSocket 网关。打包测试为
`release-forecast`
构建不可变发布，检查正常配置、拒绝解码错误、因探针失败中止、回滚，并检查撤销和显式覆盖。测试断言只登录一次、会话相同、消费者激活次数不变。第二个集成验证后续条目失败时的补偿；CLI 测试验证 Unix
socket。

使用同一个命令运行证明：

```sh
node scripts/packed-gateway.mjs test
```

发布源在各托管条目下使用 `package`、`entry`、`contract`、`target`、`config` 和
`probes`。`Releases.build` 保存编码后的输入；秘密使用 `!env` 或 `$env`
引用。外部依赖不会被捕获或固定。
