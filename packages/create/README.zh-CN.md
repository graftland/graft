# @graftland/create

[English](https://github.com/graftland/graft/blob/main/packages/create/README.md)
| 简体中文 |
[繁體中文](https://github.com/graftland/graft/blob/main/packages/create/README.zh-TW.md)

生成新的 Graft 项目。支持的 Node.js 最低版本是 22.19。

```sh
npm create @graftland@latest my-app
```

`npm create @graftland` 运行本包的 `create` 命令，它也就是
`graft create`。它会问几个问题，每个问题都有默认值；使用
`--yes`，或者终端无法作答时，所有问题都取默认值。它写入三个模板之一（`app`、`plugin`
或 `minimal`），然后安装依赖并运行 `git init`。

要在自己的程序中创建项目，请使用本包的
`create`。它不提问、不安装依赖，也不运行 git：

```sh
npm install @graftland/create effect
```

```ts
yield * Create.create({ directory: "my-app", template: "plugin" })
```

## 文档

- [命令行](https://docs.graft.land/zh-cn/cli/#graft-create)

属于 [Graft](https://github.com/graftland/graft)。基于
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE) 许可。

## 包管理器声明

共享的 `PackageManagerDeclaration` Schema 接受 `npm`、`pnpm` 或
`yarn`，后跟精确的 SemVer 版本（版本部分最多 256 个字符），可包含预发布标识。它拒绝空后缀、版本及预发布数字标识的前导零、版本范围、标签、URL 和首尾空白。

`+` 后缀仅用于
[Corepack hash](https://github.com/nodejs/corepack#when-authoring-packages)：支持
`sha224`、`sha256`、`sha384`、`sha512`，后跟点号及分别为 56、64、96、128 个字符的小写十六进制摘要。不支持普通 SemVer
build metadata。这里只校验声明语法，不下载或验证包管理器压缩包的真实性。

创建项目与检测包管理器使用同一个 Schema，可从
`@graftland/package-manager/PackageManagerDeclaration`
导入。创建时逐字保留传入的声明；检测时显式指定的 `agent`
仍优先于 manifest 声明。
