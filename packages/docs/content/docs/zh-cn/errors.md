---
title: 错误
description: Graft 中所有具名的错误和失败状态，以及应对方法。
---

Graft 会保留每次失败的完整 `Cause`
并记录日志。本页按来源分组，列出你可能遇到的错误。若要从 fork 的状态或症状而非错误名称入手，见[故障排查](../best-practices/troubleshooting/)。

## Fork 失败

| 名称                | 触发时机                                         | 应对方法                                                             |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| `SchemaError`       | 插件的配置解码失败。                             | 修正输入。在配置变化之前，fork 保持 `Failed`。                       |
| `Fork.CleanupError` | `dispose` 或 Scope 自动关闭时出现清理失败。      | 读取 `cause`：它保留原始的失败、defect 和混合中断原因。              |
| 任务失败            | `Plugin.fork` 任务以未处理的错误或 defect 失败。 | 在任务**内部**捕获可恢复的错误。参见[插件](../plugins/#任务失败时)。 |

## 服务

`ServiceConflict` 由 `Graft.provide` 抛出，`reason` 说明原因：

| `reason`          | 含义                                     |
| ----------------- | ---------------------------------------- |
| （无）            | 同一领域内已有另一个 fork 发布了这个键。 |
| `SelfDependency`  | 这次发布会直接导致其提供者自身重启。     |
| `DependencyCycle` | 同上，但是通过一串其他 fork 间接导致。   |
| `Invalidated`     | 依赖变化已经使该提供者失效。             |

错误还携带发布者的 `fork` ID 和服务的
`realm`。参见[发布导致的依赖环](../services/#发布导致的依赖环)。

## Intercept

| 名称                    | 触发时机                                          |
| ----------------------- | ------------------------------------------------- |
| `UnregisteredReference` | 配置文件中的 `intercept` 键未注册。               |
| `InvalidIntercept`      | 值未通过已注册的 schema。`cause` 是 schema 错误。 |

两种情况下，该条目的插件都不会启动。参见[配置文件中的 intercept](../intercepts/#配置文件中的-intercept)。

## 加载器与配置文件

| 名称               | 触发时机                                             |
| ------------------ | ---------------------------------------------------- |
| `CyclicConfig`     | 某个条目的配置或 intercept 包含环。只有该条目失败。  |
| `InvalidOperation` | 条目/分组结构本身包含环。                            |
| `StoreError`       | 保存编辑时解析、序列化或冲突检查失败。文件保持不变。 |
| `LoaderClosed`     | 加载器关闭之后才提交编辑。                           |

参见 [Loader API](../loader-api/)。

## Remote

单元契约通过编码通道保留已声明的业务错误。在契约的 fromClient 映射中处理 RpcClientError 传输失败。

[调用完成](../calls/)和[原生退出证据](../units/)独立于业务结果。公开 Change 状态和结果保留 Cause。
