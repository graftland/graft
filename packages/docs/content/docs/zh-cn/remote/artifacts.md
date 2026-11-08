---
title: 制品快照
description: 在启动前捕获并验证已构建的实现。
---

**制品**由捕获的包目录和带版本的 SHA-256 标识组成。标识包含选定的实现入口、目录项、文件名和文件字节。捕获不会导入实现。

## 捕获构建产物

```ts
import { Effect } from "effect"

import { Artifact } from "@graftland/plugin-remote"

export const capture = Effect.gen(function* () {
	const artifact = yield* Artifact.capture({
		directory: "./built-integration",
		entry: "dist/index.js",
		store: "./artifacts",
	})
	yield* Artifact.verify(artifact)
	const implementation = yield* Artifact.implementation(artifact)
	return { artifact, implementation }
})
```

| 操作                      | 结果                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `Artifact.capture`        | 将构建好的包复制到内容寻址目录，返回位置和标识。                  |
| `Artifact.verify`         | 重新计算副本的摘要，返回标识；验证失败则返回 `ArtifactError`。    |
| `Artifact.implementation` | 验证副本，返回捕获入口的文件 URL，用于部署选项 `implementation`。 |

三种操作都需要显式执行。导入 `Artifact`
不会访问文件系统。捕获后的副本不受后续源码修改影响。捕获期间检测到源文件变化会中止操作。相同内容复用同一目录；已有副本损坏时会拒绝操作，不会覆盖它。

## 支持的目录

| 要求     | 规则                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| 包       | 目录中包含 `package.json` 和构建好的 `.js`、`.mjs` 或 `.cjs` 入口。                                                        |
| 入口     | 目录内规范化的相对路径。                                                                                                   |
| 文件     | 仅支持普通文件和目录。捕获路径上的符号链接（包括指向目录外的链接）都会被拒绝。不支持 socket、设备等特殊文件。              |
| 存储位置 | 位于捕获闭包之外，解析文件系统别名后也须满足。允许存储在显式排除的目录内。                                                 |
| 排除路径 | 规范化的包内相对路径。必须捕获所选入口和 package.json；不遍历被排除的路径。                                                |
| 依赖     | 捕获目录内的文件，包括真实的 `node_modules` 目录。目录外的导入不会被捕获或固定。请打包实现依赖，或保持外部运行时安装不变。 |
| 信任     | 这是内容标识，不是沙箱。存储目录和运行时安装须由运维人员控制。                                                             |

外部运行时依赖不会被捕获或固定版本，仍属于操作员管理的运行时安装。

不要修改捕获的目录。验证会检测内容变化，但不会修复它。从捕获闭包中排除符号链接依赖目录，或构建仅包含普通文件的目录。排除的外部依赖不会被捕获。此 API 不提供代码传输、依赖安装或自动过渡。

Loader 描述符将已声明的外部运行依赖标为未捕获。观察到的版本和位置不固定其字节；清单只覆盖声明，不覆盖未声明的动态导入。
