---
title: 插件一致性测试
description: 使用与一方插件相同的公开测试工具验证已发布插件。
---

`@graftland/plugin-remote/Conformance`
中的**一致性测试工具**检查插件声明的协议行为。一方与第三方包使用相同的检查，包名不带来豁免。

编码检查让值通过 `Schema.toCodecJson`，验证运行时行为，不会将契约转换为文档。

## 运行测试工具

| 检查           | 公开调用与所需证据                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 清单与代码一致 | `Conformance.agreement(directory)` 在激活前验证已安装的构建包。                                                           |
| 放置位置       | `Conformance.direct(contract, options)` 打开一个已捕获的 Worker 或 Local 单元，不向应用发布服务。对两种受支持位置都运行。 |
| 可移植编码     | `Conformance.roundTrip(schema, value)` 使用 Remote 的可移植 JSON codec 和 schema 等价关系，包括非 JSON 值。               |
| 协议行为       | `Conformance.run(session, suite)` 运行领域样例、条目声明的探针和取消检查。每个实现操作都需要样例或握手。                  |
| 资源归属       | 在 Effect scope 内提供 Node 服务和安全随机数 layer。关闭 scope 时终止直接单元。                                           |

```ts
import { Schema } from "effect"

import { Conformance } from "@graftland/plugin-remote"

export const portableValue = Conformance.roundTrip(Schema.BigInt, 123n)
```

[插件作者夹具](https://github.com/graftland/graft/tree/main/samples/plugin-authors)
展示独立的契约包和实现包、清单生成、打包、已安装声明编译、兼容性检查和两种位置。其中有两个分别维护的作者夹具和一个一方夹具；这不是独立真人采用的证据。

## 提供领域样例

| 预期结果                | 断言                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `Success`               | 返回值符合 schema 等价关系，并能完成可移植往返编码。                              |
| `BusinessError`         | 声明的错误以类型化失败跨越边界，而非 `RpcClientError`；提供符合 schema 的预期值。 |
| `InfrastructureFailure` | 调用以 `RpcClientError` 失败，与业务错误分开。                                    |
| `Defect`                | 远端缺陷仍是缺陷 cause，与类型化失败分开。                                        |

当前没有公开的 `ContractFailure` 联合类型。工具检查现有 Effect
RPC 边界，不给失败重新贴标签。测试操作能够产生的失败。直接单元的启动期限为五秒；每阶段期限必须有限，默认五秒。失败保留其 cause。

成功值和业务错误的相等性比较也受每阶段截止时间约束。比较超时的诊断包含操作身份和比较阶段。

## 证明取消

提供三个请求：长时间运行的请求、等待其处理器启动的握手，以及等待请求 finalizer 完成的握手。工具中断已入场请求，再等待清理握手。响应本身不是清理证据。使用独立请求，才能在被取消的请求消失后观察清理。

清理后，工具终止单元、等待执行退出，并检查后续调用以 `RpcClientError`
失败。`Conformance.run` 完成后，此会话不能再处理样例。

直接测试宿主目前支持自包含的单次请求夹具，不支持 RPC 中间件或注入的契约服务。测试带依赖的插件时，把所需提供方组合进夹具包，并单独验证原插件的清单。通用流和中间件一致性测试尚未实现。样例验证行为，不能证明所有输入、原生模块安全或业务语义。
