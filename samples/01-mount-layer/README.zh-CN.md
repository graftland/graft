# 01 · 挂载 Layer

简体中文

挂载一个 Layer，它就变成动态的。Graft 会构建它、发布它提供的服务，并在挂载消失时释放它。

你会学到：

- `Graft.layer` 提供图。它就是一个普通的 Effect Layer。
- `Graft.mount` 挂载一个普通的 `Layer`。挂载归当前作用域所有。
- `Graft.use` 等待服务出现，运行函数，并在运行期间持有该服务。
- `mount.unmount` 拆除 Layer；关闭作用域也能做到同样的事。

示例逻辑在 [`src/program.ts`](src/program.ts) 里，[`src/main.ts`](src/main.ts)
运行它。

## 运行它

在仓库根目录：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/01-mount-layer start
```

```text
Building the greeter
Hello, world!
Releasing the greeter
```

## 试一试

- 删掉 `mount.unmount`。程序结束时 greeter 仍会被释放，因为挂载属于作用域。
- 挂载 `greeter`
  两次。你会得到两个独立的实例，它们都会在各自的挂载结束时被释放。
