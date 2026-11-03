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

The implementation module exports an ordinary `Plugin.make(...)` definition. An
explicit executable bootstrap imports only the contract and starts the runner:

```ts
import { NodeRuntime } from "@effect/platform-node"
import { run } from "@graftland/remote/Runner"
import { contract } from "./contract.js"

NodeRuntime.runMain(run(contract))
```

The host imports the contract and creates an ordinary proxy plugin:

```ts
import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/remote"
import { contract } from "./contract.js"

const proxy = Remote.plugin(contract, {
	runner: new URL("./runner.js", import.meta.url).pathname,
	shutdownTimeout: "5 seconds",
})
const activation = Graft.plugin(proxy, { greeting: "Hello" })
```

Run `activation` inside the host's Graft runtime and scope. Build the bootstrap
and implementation to executable JavaScript first; no TypeScript loader is
installed in the child. Use the same contract in the host and bootstrap. Resolve
relative implementation paths in the contract with `new URL(...)`; bare package
names resolve from the runner's installation.

The config schema's encoded type must extend `Schema.Json` and is checked again
before spawning. The child performs the implementation's config decoding. The
contract's schemas cannot require external encoding or decoding services.

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
- Cleanup failures retain their full decoded cause inside `Die(Cause)` in the
  host `CleanupError.cause`: Effect scope finalizers cannot expose typed
  failures. Transport and process diagnostics encountered during cleanup are
  also retained.
- Unexpected process exits include PID, exit code (or null for signals), the
  last 8,192 stderr characters, and the platform exit cause.
- Effect logs are emitted into the host logger with the proxy's `graft.fork` and
  `graft.plugin` annotations, plus `remote.pid` and `remote.annotations`.
  Finalizer logs are delivered before successful dispose returns.

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

The runner's log queue is unbounded and defect/log payloads use Effect's
diagnostic JSON encoding. These choices need revisiting before production or
untrusted use. The shutdown deadline is a local prototype default, not a
distributed lease.

`test/lifecycle.test.ts` runs actual child processes and covers startup gating,
combined typed errors and defects, retry, process exit and SIGKILL, graceful
cleanup and scope closure, cleanup defects, log annotations and finalizer logs,
configuration restart, background failure, cleanup timeout, and disposal while
apply is waiting. The fixture deliberately writes console output. Tests build
fixtures into the ignored `.cache/integration` directory; imports perform no I/O
except the explicit executable bootstrap.

Run from the workspace root:

```sh
devenv shell -- pnpm exec vitest run --project remote
devenv shell -- pnpm typecheck
devenv shell -- pnpm build
```
