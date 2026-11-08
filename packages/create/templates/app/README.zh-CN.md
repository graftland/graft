# Graft 应用

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

一个 Graft 应用。启动前先构建源码；`graft.yml` 选择捕获的 JavaScript 文件。

## 运行

```sh
npm run dev
```

修改 `src/hello.ts` 后，停止进程并再次运行
`npm run dev`。日志显示新消息。修改运行中的应用不会触发重载。

## 脚本

| Command             | Behavior               |
| ------------------- | ---------------------- |
| `npm run dev`       | 构建并启动             |
| `npm start`         | 启动已有构建           |
| `npm run build`     | 将 `src` 编译到 `dist` |
| `npm run typecheck` | 检查类型和 Effect 诊断 |

`greeter` 插件发布 `Greeter`，`ticker`
注入它并每三秒问候一次。pnpm 和 Yarn 也支持这些脚本。
