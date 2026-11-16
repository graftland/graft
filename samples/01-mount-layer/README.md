# 01 · Mount a layer

English

A layer becomes dynamic when you mount it. Graft builds it, publishes the
services it provides, and releases it when the mount goes away.

You will learn:

- `Graft.layer` provides the graph. It is a normal Effect layer.
- `Graft.mount` mounts an ordinary `Layer`. The mount belongs to the current
  scope.
- `Graft.use` waits for the service, runs the function, and holds the service
  while it runs.
- `mount.unmount` tears the layer down; closing the scope does the same.

All the sample logic is in [`src/program.ts`](src/program.ts);
[`src/main.ts`](src/main.ts) runs it.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/01-mount-layer start
```

```text
Building the greeter
Hello, world!
Releasing the greeter
```

## Try it

- Remove `mount.unmount`. The greeter is still released when the program ends,
  because the mount belongs to the scope.
- Mount `greeter` twice. You get two independent instances, and both are
  released when their mounts end.
