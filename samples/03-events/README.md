# 03 · Events

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Plugins listen to events with handlers that belong to them. When a plugin
unloads, its handlers go away with it.

You will learn:

- `Event.make` defines a typed event.
- `Event.on` registers a handler inside the `apply` of a plugin.
- `Event.emit` calls every handler that is registered at that moment.
- There is no unsubscribe call. When you unload the plugin, Graft removes its
  handlers.

All the code is in [`src/main.ts`](src/main.ts).

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-events start
```

```text
Sending a message to both plugins.
printer: hello
shouter: HELLO!
Unloading shouter, then sending another message.
printer: anyone there?
```

## Try it

- Handlers can also answer.
  `Event.make<[question: string], Option.Option<string>>` with `Event.bail`
  returns the first answer that a handler gives. See
  [Events](../../packages/docs/content/docs/events.md) for this and the other
  ways to dispatch.

Next: [04 · Failures](../04-failures).
