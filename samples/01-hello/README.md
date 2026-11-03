# 01 · Hello

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Your first plugin. It says hello when it starts and goodbye when it stops.

You will learn:

- `Plugin.make` defines a plugin. A plugin has a name, a config schema, and
  `apply`, which starts it.
- `Graft.plugin` loads a plugin. The running instance is a **fork**.
- `fork.update` gives a fork a new config. By default the plugin restarts.
- `fork.dispose` unloads the plugin. Cleanup that you register with
  `Effect.acquireRelease` runs every time the plugin stops.

All the code is in [`src/main.ts`](src/main.ts).

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-hello start
```

```text
Hello, Alice!
Goodbye, Alice!
Hello, Bob!
Goodbye, Bob!
```

`Goodbye, Alice!` comes from the update. Graft stops the old instance before it
starts the new one.

## Try it

- Remove the `yield* fork.dispose` line. `Goodbye, Bob!` is still printed. When
  the program ends, Graft unloads every plugin that it loaded.
- Pass `{ name: 42 }` to `Graft.plugin`. TypeScript rejects it, because the
  config schema says that `name` is a string.

Next: [02 · Services](../02-services).
