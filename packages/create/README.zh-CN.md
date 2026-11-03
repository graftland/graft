# @graftland/create

[English](https://github.com/graftland/graft/blob/main/packages/create/README.md)
| 简体中文 |
[繁體中文](https://github.com/graftland/graft/blob/main/packages/create/README.zh-TW.md)

生成新的 Graft 项目。`graft create` 使用它。

支持的 Node.js 最低版本是 22.19。

```sh
npm install @graftland/create effect
```

`create`
会把这些文件写入空目录或新目录：`package.json`、`graft.yml`、一个示例插件和
`.gitignore`。

## 文档

- [命令行](https://graftland.github.io/graft/zh-cn/cli/)

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
