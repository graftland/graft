---
title: 插件一致性
description: 检查发布元数据、编解码器和领域示例。
---

**一致性工具**检查作者提供的协议示例，提供元数据与编解码检查以及领域会话测试。

## 运行检查

| 检查                    | 证据                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `Conformance.agreement` | 验证已安装的构建包与其清单是否一致。                                                   |
| `Conformance.roundTrip` | 检查可移植 JSON 编码及 Schema 等价性，包括非 JSON 值。                                 |
| `Conformance.run`       | 通过提供的会话检查示例、已声明探针和取消；每个已实现的服务与操作组合都需要用例或握手。 |

```ts
import { Schema } from "effect"

import { Conformance } from "@graftland/plugin-remote"

export const portableValue = Conformance.roundTrip(Schema.BigInt, 123n)
```

## 提供领域示例

每个请求指定 Context 服务键和确切的操作标识。会话提供调用、编解码比较、探针以及独立观察到的终止证据。操作标识相同的两个服务仍相互独立。失败保留 Cause。每阶段期限必须有限，默认为五秒。

## 证明取消

提供一个长调用、证明处理程序已开始的握手，以及证明所拥有清理已完成的握手。测试中断请求，在终止前检查清理。结果本身不是清理证据。终止后再次调用必须以 RpcClientError 失败。
