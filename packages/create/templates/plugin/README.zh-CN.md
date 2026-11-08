# Graft 插件

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

一个 Graft 插件包。`src/index.ts` 定义插件，`graft.yml` 加载构建后的
`dist/index.js`。

## 运行

```sh
npm run dev
```

修改后停止进程，再次运行 `npm run dev`。不提供自动重载。

## 脚本

| Command             | Behavior                       |
| ------------------- | ------------------------------ |
| `npm run dev`       | 构建并启动                     |
| `npm test`          | 运行 `test/`                   |
| `npm run typecheck` | 检查类型和 Effect 诊断         |
| `npm run build`     | 将 `src` 编译到发布目录 `dist` |

pnpm 和 Yarn 也支持这些脚本。精确的插件包名优先；否则短名 `example` 尝试
`@graftland/plugin-example` 和
`graft-plugin-example`。两者都存在时请写完整包名。
