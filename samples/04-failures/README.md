# 04 · Failures

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

At first, a client cannot connect. Graft logs each failure and cleans the plugin
up. Then it tries again on a schedule. Another plugin keeps running the whole
time.

You will learn:

- When `apply` fails, the fork becomes `Failed` and Graft logs the error.
- `retry: Schedule.spaced("300 millis")` tells Graft to try again 300 ms after
  each failure. Without `retry`, a failed plugin waits until its config changes.
- `Plugin.fork` runs background work. Here the work is a heartbeat. The work
  belongs to the plugin and stops with it.
- When one plugin fails, the other plugins are not affected.

All the code is in [`src/main.ts`](src/main.ts).

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-failures start
```

```text
Connecting, attempt 1
Plugin "@graftland/sample-failures/main/makeClient" failed
  ConnectionRefused: Connection refused on attempt 1
heartbeat: still running
heartbeat: still running
Connecting, attempt 2
Plugin "@graftland/sample-failures/main/makeClient" failed
  ConnectionRefused: Connection refused on attempt 2
heartbeat: still running
Connecting, attempt 3
Connected
The client is running; unloading everything.
```

## Try it

- Change the schedule to `Schedule.exponential("100 millis")`. Then the waits
  grow: 100 ms, then 200 ms.

Next: [05 · Config file](../05-config-file).
