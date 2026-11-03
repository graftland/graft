# @graftland/remote

Private local-process prototype for Graft. Each host activation owns one Node.js
process. This package proves lifecycle mapping; it is not a network runner or a
security sandbox.

## Usage

Keep the contract and implementation in separate modules. The contract declares
`name`, `config`, `error`, and the implementation `module` specifier:

```ts
import { Contract } from "@graftland/remote"
import { Schema } from "effect"

export const contract = Contract.make({
	name: "example",
	config: Schema.Struct({ greeting: Schema.String }),
	error: Schema.Never,
	module: new URL("./implementation.js", import.meta.url).href,
})
```

The implementation module exports an ordinary `Plugin.make(...)` definition. The
package supplies the `graft-remote <contract-module-specifier>` executable; no
application bootstrap is needed. The contract module exports either `default` or
a named `contract` created by `Contract.make`.

The host imports the contract and creates an ordinary proxy plugin:

```ts
import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/remote"
import { contract } from "./contract.js"

const proxy = Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	shutdownTimeout: "5 seconds",
})
const activation = Graft.plugin(proxy, { greeting: "Hello" })
```

Run `activation` inside the host's Graft runtime and scope. Provide
`ChildProcessSpawner` through that runtime's environment, for example with
`Layer.provideMerge(Graft.layer, NodeServices.layer)`. The proxy declares this
service in `inject`; it does not create its own platform layer.

Build the contract and implementation to JavaScript first; the child has no
TypeScript loader. Pass the same contract to the host and the generic runner.
Use a file URL for local contract modules. Bare package specifiers resolve from
the runner's installation, not from the host module. Resolve implementation
paths with `new URL(...)` in the contract. Network package resolution and
identity verification are not implemented yet.

The config schema's encoded type must extend `Schema.Json`. Before spawning, the
host validates JSON compatibility and decodes `contract.config`, including
Type-side refinements. It sends the original encoded input; the child decodes
with the implementation's schema. Contract codecs must be pure and cannot
require external encoding or decoding services.

## Lifecycle and failure behavior

- `Load` returns only after the child fork becomes Active or Failed. Later child
  failures reach the host through the `Events` stream.
- Retry belongs to the host proxy. The runner disables the implementation's
  retry policy, so each retry creates a fresh process. Updates always return
  `false` and therefore restart through Graft's existing update behavior.
- Dispose waits for the child fork's cleanup, a final log barrier, and process
  exit. The protocol remains alive while activation finalizers run. The default
  graceful deadline is five seconds; expiry fails cleanup and closes the process
  scope, whose Node spawner escalates to SIGKILL after one second.
- Application failures travel as `Schema.Cause` values using the contract's
  typed error schema, without squashing Fail and Die reasons. Defects preserve
  diagnostic message and stack, not arbitrary JavaScript object identity.
  Undeclared errors use `Contract.UndeclaredFailure`.
- Cleanup failures remain at the top level of the host `CleanupError.cause`.
  Because scope finalizers cannot expose typed failures, each Fail becomes a Die
  carrying the same error; reason annotations are retained, and existing Die and
  Interrupt reasons remain unchanged. Transport and process diagnostics
  encountered during cleanup are also retained.
- Unexpected process exits include PID, exit code (or null for signals), the
  last 8,192 stderr characters, and the platform exit cause.
- Effect logs are emitted into the host logger with the proxy's `graft.fork` and
  `graft.plugin` annotations, plus `remote.pid` and `remote.annotations`.
  Buffered finalizer logs are delivered before successful dispose returns. When
  the log queue is full, new logs are dropped and counted.

Control requests use stdin; responses use an extra inherited descriptor, fd 3.
The runner uses Effect's stdio server protocol with an overridden
`Stdio.stdout`. The host implements `RpcClient.Protocol` over the ChildProcess
handle. Ordinary stdout is drained, so `console.log` cannot corrupt RPC; stdout
is not converted into structured Graft logs. Stdin and fd 3 are reserved for the
protocol.

## Prototype limits and verification

There is no cross-process inject/provide, code distribution, lease,
authentication, network transport, scheduling, or stable logical instance
identity. Plugins may use the child runtime's own services. This implementation
does not restrict the plugin's filesystem, network, or ability to escape a
process group.

The runner buffers at most 128 pending log entries and reports cumulative losses
on the `Logs` RPC. The host emits warnings with `remote.logs.dropped` (the new
loss count) and `remote.logs.droppedTotal` (the cumulative count). The final
`LogsEnded` message reports the final count even when no log entry remains.

`Failed` and `Stopped` use a separate bounded control stream. The client
dispatches log responses through a separate scoped fiber and a one-frame queue,
so a backpressured log consumer cannot stall control response decoding. RPC ACKs
bound outstanding log frames. Already-written bytes share the same fd and cannot
be preempted. After control completion the host drains the bounded log tail
within the existing shutdown deadline.

Defect/log payloads still use Effect's diagnostic JSON encoding. The bounded
entry count is not a total byte budget; per-entry size limits and general duplex
flow control belong to the next transport phase. The shutdown deadline is a
local default, not a distributed lease.

`test/lifecycle.test.ts` runs actual child processes and covers startup gating,
combined typed errors and defects, retry, process exit and SIGKILL, graceful
cleanup and scope closure, cleanup defects, log annotations and finalizer logs,
configuration restart, background failure, cleanup timeout, and disposal while
apply is waiting. The fixture deliberately writes console output. Tests build
fixtures into the ignored `.cache/integration` directory and build the package
bin into `dist`. Library imports perform no I/O; executing the bin starts the
runner. `test/hardening.test.ts` additionally covers ambient spawner
replacement, host refinement rejection before spawn, flat cleanup reasons and
annotations, contract module loading, loss accounting, and control progress
while log consumption is suspended.

Run from the workspace root:

```sh
devenv shell -- pnpm exec vitest run --project remote
devenv shell -- pnpm typecheck
devenv shell -- pnpm build
```
