# 协作约定

## 项目

- Graft 是基于 Effect 4 的插件框架，设计上参考
  [cordis](https://github.com/cordiverse/cordis)。借鉴其插件、上下文与服务的组合方式，但直接用 Effect 的
  `Context`、`Layer`、`Scope` 与 `Fiber` 表达，不另造一套概念包装。

## 开发环境

- 所有命令通过 `devenv shell -- <command>` 运行。
- 检查：`pnpm typecheck`、`pnpm test`、`pnpm build`；格式化：`treefmt`。

## 代码

- 代码中的所有文字（注释、文档注释、错误信息、日志、测试名称与数据）使用自然、地道的英文。
- 优先使用 Effect 的不可变数据结构；仅在确有必要时使用 JavaScript 原生可变数据结构。
- `tsconfig.base.json` 中 Effect language
  service 的诊断规则不得为省事关闭；确需保留原生写法时只对单行关闭，并在 `--`
  后写明原因。
- 导入模块不得触发任何 I/O。
- 每个 fiber 都有归属：scope、`FiberSet` 或 `FiberMap`。
- 不丢弃失败的 cause。
