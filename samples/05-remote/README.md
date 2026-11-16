# 05 · Remote

English

A service can live in another graph, or another process, without its caller
knowing. The transport is an `effect/rpc` Protocol.

You will learn:

- `Remote.service` declares a contract: the local service key, an `RpcGroup`,
  and the two mappings between them.
- `Remote.serve` exposes every contract whose service is currently available. It
  returns a Mount, so it belongs to the current scope.
- While connected, the remote service is published locally. `Graft.use` waits
  for it, holds it for the call, and releases it afterwards.
- Availability travels over the connection, so a service that disappears on the
  server disappears on the client too.

The sample uses the in-memory protocol from `@graftland/graft/testing`. A real
application passes a socket, HTTP, or worker protocol instead.

All the sample logic is in [`src/program.ts`](src/program.ts);
[`src/main.ts`](src/main.ts) runs it.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/05-remote start
```

```text
The book costs 12
```

## Try it

- Remove the `pricing` mount on the server. The client waits in `Graft.use`
  instead of receiving a price.
- Add a second RPC to `PricingRpcs` and a second method to `Pricing`. The
  contract carries both directions, so the remote service has it too.
