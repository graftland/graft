# 05 · Config file

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

这里的插件和之前是同一类。不同的是，这次由 `graft`
命令从配置文件加载它们。你通过编辑文件来修改正在运行的应用。

你将学到：

- 插件模块把它的插件作为默认导出。参见 [`src/greeter.ts`](src/greeter.ts) 和
  [`src/ticker.ts`](src/ticker.ts)。
- [`graft.yml`](graft.yml) 列出要加载哪些插件，以及每个插件使用什么配置。
- `graft start --watch`
  会把每次保存的修改应用到正在运行的应用上，只改动发生变化的部分。

## 运行

在仓库根目录运行：

```sh
devenv shell -- pnpm build
cd samples/05-config-file
devenv shell -- pnpm start
```

```text
Running graft.yml
Hello, Alice!
tick
tick
```

保持它运行，然后编辑这个文件夹中的文件：

1. 在 `graft.yml` 中，把 `name: Alice` 改成 `name: Bob` 并保存。你会看到
   `Goodbye, Alice!` 和 `Hello, Bob!`。ticker 继续计时，因为它的条目没有改变。
2. 给 `ticker` 条目加上 `disabled: true`
   并保存。tick 会停止。删除这一行后，它们会重新开始。
3. 在 `src/greeter.ts` 中，把 `Hello` 改成 `Hi there`
   并保存。Graft 会导入新代码并替换正在运行的插件：`Goodbye, Bob!`、`Hi there, Bob!`。

按 <kbd>Ctrl</kbd>+<kbd>C</kbd> 停止。Graft 会卸载所有插件。

## 下一步
