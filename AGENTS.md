# 协作约定

## 项目

- Graft 是基于 Effect 4 的插件框架，设计上参考
  [cordis](https://github.com/cordiverse/cordis)。借鉴其插件、上下文与服务的组合方式，但直接用 Effect 的
  `Context`、`Layer`、`Scope` 与 `Fiber` 等表达，不另造一套概念包装。

## 开发环境

- 所有命令通过 `devenv shell -- <command>` 运行。
- 检查：`pnpm typecheck`、`pnpm test`、`pnpm build`；格式化：`treefmt`。

## 文档

- 编写或修改文档前先读
  `packages/docs/STYLE.md`，按其中的规则写：一个主题一页、简洁、表格优先、不重复、不写实现细节，签名只出现在自动生成的 API 参考里。
- 行为改动和对应文档放在同一次改动中；三种语言（英文、简体、繁体）结构与内容一致。

## 代码

- 代码中的所有文字（注释、文档注释、错误信息、日志、测试名称与数据）使用自然、地道的英文。
- 优先使用 Effect 的不可变数据结构；仅在确有必要时使用 JavaScript 原生可变数据结构。
- `tsconfig.base.json` 中 Effect language
  service 的诊断规则不得为省事关闭；确需保留原生写法时只对单行关闭，并在 `--`
  后写明原因。
- 导入模块不得触发任何 I/O。
- 公开签名中出现的每个类型（包括用作属性键的常量）都必须从公开入口导出。文档构建会运行 TypeDoc 校验，任何「referenced
  but not included」警告都会让构建失败；本地用 `pnpm build` 即可检查。
- 文档内容中的站内链接一律用相对路径，不写以 `/`
  开头的链接（`check-links.test.mjs` 会检查）。
- 每个 fiber 都有归属：scope、`FiberSet` 或 `FiberMap`。
- 不丢弃失败的 cause。
