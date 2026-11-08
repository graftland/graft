# 05 · Config file

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

These are the same kind of plugins as before. This time the `graft` command
loads them from a config file. You change the running application by editing
files.

You will learn:

- A plugin module exports its plugin as the default export. See
  [`src/greeter.ts`](src/greeter.ts) and [`src/ticker.ts`](src/ticker.ts).
- [`graft.yml`](graft.yml) lists which plugins to load and what config each one
  gets.
- `graft start --watch` applies each saved change to the running application. It
  touches only what changed.

## Run it

From the repository root:

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

Leave it running and edit files in this folder:

1. In `graft.yml`, change `name: Alice` to `name: Bob` and save. You see
   `Goodbye, Alice!` and `Hello, Bob!`. The ticker keeps ticking, because its
   entry did not change.
2. Add `disabled: true` to the `ticker` entry and save. The ticks stop. Remove
   the line and they start again.
3. In `src/greeter.ts`, change `Hello` to `Hi there` and save. Graft imports the
   new code and replaces the running plugin: `Reloaded 1 plugin module(s)`,
   `Goodbye, Bob!`, `Hi there, Bob!`.

Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop. Graft unloads every plugin.

## Next
