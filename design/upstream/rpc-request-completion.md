# Observe RPC execution completion after request scope cleanup

Status: upstream proposal draft, not submitted. Reproduced with `effect@4.1.2`.

## Problem

A transport can observe an encoded RPC `Exit`, but that message does not prove
that the request's execution and owned cleanup have finished. This affects
ordinary unary calls, including calls returning an immediate value. It is not
limited to deferred replies, streams, notifications, or discarded calls.

A runtime replacing a provider must distinguish these facts:

| Fact                        | What it proves                                                               |
| --------------------------- | ---------------------------------------------------------------------------- |
| The caller stopped waiting  | Only the caller's local wait ended                                           |
| A response `Exit` was sent  | The handler result was encoded and sent                                      |
| Request execution completed | The handler, its request scope, and owned cleanup ended                      |
| A Worker exited             | No execution continues in that Worker; successful cleanup is not established |

The runtime cannot safely release an execution credit or declare a provider
drained using either of the first two facts.

## Reproduction

The executable reproduction is
[`encoded-channel.prototype.test.ts`](../../packages/plugin-remote/test/encoded-channel.prototype.test.ts),
with fixtures under
[`encoded-channel/`](../../packages/plugin-remote/test/fixtures/encoded-channel/).
It starts real consumer and provider Workers and transfers the two endpoints of
a `MessageChannel` to them. Each Worker builds its own typed RPC endpoint using
the public `RpcClient.Protocol` or `RpcServer.Protocol` service and the JSON
serialization codec. The host imports no contract module and sees no request or
response payload.

Run from the Graft repository after installing dependencies and building its
workspace package dependencies:

```sh
devenv shell -- pnpm vitest run --project @graftland/plugin-remote packages/plugin-remote/test/encoded-channel.prototype.test.ts
```

| Test                                                                                            | Observed order                                                                                                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `stops the client before an ensuring finalizer finishes and retains the remote exit obligation` | Caller stops; an `Effect.ensuring` finalizer blocks; no server `Exit` is sent until that finalizer is released                              |
| `sends the RPC exit before a request scope finalizer finishes`                                  | Caller cancels; server sends `Exit`; a finalizer registered with `Effect.addFinalizer` starts and blocks                                    |
| `returns a unary result before its request scope cleanup completes`                             | Server sends `Exit`; request scope cleanup starts and blocks; consumer receives the decoded successful result while cleanup remains blocked |

The cleanup latch is controlled by the test over a separate control port. These
orderings use explicit events and a latch, not timing sleeps. The
`cleanup-finished` event is fixture instrumentation, not a proposed production
completion mechanism. A generic runtime cannot require each handler to emit it.

The distinction can be reproduced by replacing a handler whose body is
`Effect.never.pipe(Effect.ensuring(cleanup))` with one that registers `cleanup`
using `Effect.addFinalizer` before waiting forever. Both are legal Effect
resource ownership patterns; only the latter exposes the gap.

## Source confirmation

In the installed 4.1.2 `effect/src/rpc/RpcServer.ts`:

- `makeNoSerialization` builds the handler's `Effect.onExit` callback around
  lines 348–378. It constructs `write = respond(exit)`, obtains the request
  scope close effect, and returns `Effect.ensuring(write, close)` when cleanup
  is necessary. The response precedes scope completion.
- `RpcServer.make` forwards that decoded response through response encoding to
  `Protocol.send`. Its public options do not expose a hook after the request
  fiber and scope finish.
- The encoded protocol's receive callback only admits the request. Waiting for
  that callback to return does not wait for the spawned handler fiber.
- `makeNoSerialization` has a per-write `onRequest` wrapper, but it accepts
  decoded messages. Switching to it would move schema-dependent decoding into
  the runtime adapter instead of providing an encoded transport completion hook.

The ordinary result and completion are therefore observably different facts with
the public encoded API. The tests establish the early response; the claim that
no suitable general public hook exists is based on reviewing the exported APIs
and their implementation, not an exhaustive proof over all compositions.

## Requested capability

Expose a request completion observation on the encoded `RpcServer.make` path.
Keep it distinct from response serialization and transport delivery.

| Requirement                                                               | Reason                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Identify the client session and request id                                | Request ids alone can be reused across clients or connections                               |
| Observe after the logical request's owned execution and scope cleanup end | Handler result, response emission, and client cancellation are earlier events               |
| Cover cancellation, success, typed failure, and defects                   | Credits must be settled on every terminal execution path                                    |
| Preserve execution and cleanup causes                                     | A successful result can precede a failed finalizer                                          |
| Give the observation an explicit owner and failure policy                 | A failed reporting hook must not silently lose an execution obligation                      |
| Define behavior on server shutdown and disconnect                         | A dropped connection must not synthesize successful cleanup                                 |
| State supported reply forms explicitly                                    | Deferred replies and discard need their whole logical lifecycle, or must remain unsupported |

A completion callback or an outer request-lifecycle wrapper could satisfy these
requirements. It should not require the transport to decode business payloads,
inspect private server maps, parse diagnostic strings, or require handlers to
wrap their bodies in an extra `Effect.scoped` solely to change response order.
The provider unit can project this observation into a schema-free control
message containing its generation, connection session, request id, and a
completion disposition. Business schemas stay inside the unit.

## Limits

This proposal does not make a disconnected call safe to retry. A request
registered for dispatch but lacking a terminal result remains `Unknown`.
Observed Worker exit establishes termination, not successful finalization or
rollback of external effects. Reliable completion delivery, duplicate handling,
authority fencing, route installation, and admission accounting belong to the
runtime protocol and are not supplied by this draft.

Graft has not added a workaround or changed its product paths. Its next-stage
drain guarantee must remain unimplemented for general unary request scopes until
this lifecycle observation exists.
