---
title: 插件清单
description: 生成发布元数据并记录包的来源。
---

**插件清单**是 `package.json` 中带版本的 `graft`
字段，记录公开入口、契约操作和运行时需求。它不包含信任声明或权限授予。

## 声明入口

```json
{
	"name": "@acme/forecast",
	"version": "1.0.0",
	"type": "module",
	"exports": { ".": "./dist/index.js" },
	"engines": { "node": ">=22.19.0" },
	"peerDependencies": { "effect": "4.1.*", "@graftland/graft": "0.0.0" },
	"graft": {
		"version": 1,
		"entries": {
			".": {
				"implementation": "dist/index.js",
				"contracts": ["@acme/forecast-contract"],
				"requirements": {
					"placements": ["Worker", "Local"],
					"filesystem": false,
					"nativeModules": false
				},
				"probes": ["health"]
			}
		}
	}
}
```

| 字段           | 作者的责任                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `entries`      | 使用公开导出名 `.` 或 `./subpath`，导出必须解析到所选的已构建实现。                                                       |
| `contracts`    | 已安装的契约模块标识符。模块导出 `contract` 或默认契约，并支持 Node 的默认导出解析。                                      |
| `requirements` | 支持的放置位置与所需宿主能力。这些是需求，不是授权。                                                                      |
| `probes`       | 服务期间通过 `Plugin.probe` 注册的名称。                                                                                  |
| 运行时版本范围 | 以 `engines.node` 及 `effect`、`@graftland/graft` 的 peer 依赖为唯一来源。发布真实的 semver 范围，不使用 workspace 范围。 |

## 生成与验证

启用 [Remote 命令插件](../../cli/#命令插件)，构建实现后运行：

```sh
graft remote manifest ./release
graft remote manifest ./release --check
```

生成过程导入已构建的声明，不运行 `apply`
或探针。只对你打算导入的代码运行此命令。模块作者必须保证导入不执行 I/O。每次入口检查使用新的临时 Worker，包括它导入的所有依赖。在同一调用进程中重复生成或验证也会读取模块变更。清单与代码不一致时，验证以失败退出。`Publication.inspectEntry`
返回元数据，不返回运行中的插件对象。

| 生成字段              | 来源                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `services.required`   | 通过契约描述符解析的必需 `Plugin.inject` 键。                         |
| `services.optional`   | `Plugin.optional` 键。                                                |
| `services.implements` | `Plugin.provides`。                                                   |
| `operations`          | 精确的 `name@version`、契约包名与版本，以及该包的 Artifact 目录摘要。 |

每个服务集合包含 `{ "key": "service/key", "operations": ["read@1"] }`
分组，由 Context 键和操作声明派生。操作字符串相同不代表不同服务键可以互换。

普通服务缺少契约描述符时，生成会失败，不会将它从清单中省略。私有服务应封装在包内组合中。发布工具读取操作身份，不检查 schema。不透明 schema、流和中间件不会阻止发布。[一致性测试工具](../conformance/)
有自己的支持范围。

生成清单时使用独立的契约包。将包自身的完整目录摘要写入其清单会改变该摘要，因此工具会在写入前拒绝这种自引用。

## 记录来源

```sh
graft remote manifest ./release --check --provenance ./provenance.json
```

**来源记录**包含包名与版本、解析后包目录的版本化
[Artifact 身份](../../remote/artifacts/)，以及每个操作的契约包身份与目录摘要。记录文件必须位于包目录之外。
`Publication.provenance` 也能记录已捕获的目录，不导入其实现。

每个操作的 `artifact` 包含 `Artifact.directoryIdentity(contractDirectory)`
返回的 `version`、`algorithm` 和
`digest`。它对包的字节计算摘要，不选择入口，因此同一包的所有导出共享该身份。执行制品保留独立的、包含入口的身份。两种身份都不序列化 schema，也不证明操作的含义。

外部运行时依赖不会被捕获或固定。来源不是兼容性、发布者身份验证、信任或权限决定。
[兼容性检查](../compatibility/)与[一致性测试](../conformance/)分别回答各自的问题。
