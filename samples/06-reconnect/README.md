# 06 · Reconnect

English

A connection can drop. Graft treats the presence stream as the source of truth,
so a lost connection withdraws every remote service, and reconnecting brings
them back.

You will learn:

- While the connection is up, the connect mount mirrors the server's available
  services into the local graph.
- When the connection ends, the remote services are withdrawn. `Graft.watch`
  emits the current availability first, then every change, so it shows each
  withdrawal and each publication.
- With `retry`, the connect mount opens a fresh protocol and connects again.
  When the server reports the service again, it is published again.
- Downstream mounts follow the same lifecycle: they stop when the service is
  withdrawn and start again when it returns.

The sample uses the in-memory protocol from `@graftland/graft/testing`, which
can end the current connection on demand. A real application relies on the
transport ending when the socket, HTTP response, or worker goes away.

All the sample logic is in [`src/program.ts`](src/program.ts);
[`src/main.ts`](src/main.ts) runs it.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/06-reconnect start
```

```text
The remote service is gone
The remote service is available
Before the drop, the book costs 12
The remote service is gone
The connection dropped and the remote service was withdrawn
The remote service is available
The connection is back and the remote service is published
After reconnecting, the book costs 12
```

The first line is the watcher's initial value: the service is not published yet.
The graph also logs the failed connection attempt before reconnecting. The
logger adds timestamps and mount annotations; those are omitted here.

## Try it

- Remove `retry`. The mount stays `Failed` after the drop, and the remote
  service never returns.
- Use `Graft.whileAvailable(Pricing, ...)` in another mount. It stops work on
  the drop and resumes it after reconnecting, without any reconnect code of its
  own.
