# 02 · Services

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

One plugin publishes a service. Another plugin uses it. You never check whether
the service exists. Graft starts the plugin that uses the service only when the
service exists.

You will learn:

- `Graft.provide` publishes a service for as long as the plugin is loaded.
- `inject: [Greeter]` says that a plugin needs a `Greeter`. Until a `Greeter`
  exists, the plugin waits in the `Pending` state.
- When the provider unloads, the plugin that uses the service stops first. Then
  it waits again. When another provider appears, the plugin starts again with
  the new one.

All the code is in [`src/main.ts`](src/main.ts).

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-services start
```

```text
Loading welcome. No Greeter exists yet, so it waits.
Loading english. welcome starts on its own.
Hello, world!
Unloading english. welcome stops first, then waits again.
welcome stopped
Loading french. welcome starts again, with the new Greeter.
Bonjour, world !
welcome stopped
```

`welcome` has no `if` for a missing `Greeter`. It has no code to switch from
English to French either. Graft restarts it with whichever `Greeter` exists.

## Try it

- Load `french` while `english` is still loaded. The second `Graft.provide`
  fails with `ServiceConflict`. Only one plugin can publish a service at a time.
  To swap one for the other, unload the first one, as the sample does.

Next: [03 · Events](../03-events).
