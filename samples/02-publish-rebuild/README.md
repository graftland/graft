# 02 · Publish and rebuild

English

Configuration is not special. It is a value published into the graph. A mount
that requires it is rebuilt when the value changes.

You will learn:

- `Graft.publish` puts a value in the graph and returns a Publication with
  `set`. The value is applied by the graph's supervisor, so `publication.await`
  first if the next step depends on it.
- A mount's `requires` lists what the layer needs from the graph. The layer is
  built only while all of it is available.
- `publication.set` replaces the value. Every mount that requires it is torn
  down and built again with the new one.
- `mount.stable` waits until the mount and its children finish loading.

All the sample logic is in [`src/program.ts`](src/program.ts);
[`src/main.ts`](src/main.ts) runs it.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/02-publish-rebuild start
```

```text
Building the greeter with "Hello"
Hello, world!
Releasing the greeter for "Hello"
Building the greeter with "Hi"
Hi, again!
Releasing the greeter for "Hi"
```

## Try it

- Mount `greeter` before publishing `Config`. The mount stays `Pending` until
  the value appears, then builds on its own.
- Remove `requires: [Config]`. TypeScript rejects the mount, because the layer
  needs `Config` but `requires` does not list it.
