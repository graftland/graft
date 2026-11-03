# @graftland/remote

Private remote-plugin implementation with local process and authenticated
network runner targets. Each host activation owns one Node.js execution.
Contracts bridge services in both directions; the network runner supervises
executions without loading plugin implementations into its own process.

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
	target: Remote.local(),
	shutdownTimeout: "5 seconds",
})
const activation = Graft.plugin(proxy, { greeting: "Hello" })
```

Run `activation` inside the host's Graft runtime and scope. Provide
`ChildProcessSpawner` through that runtime's environment, for example with
`Layer.provideMerge(Graft.layer, NodeServices.layer)`. The local proxy declares
this service in `inject`; it does not create its own platform layer. Network
targets do not require a host process spawner.

Build the contract and implementation to JavaScript first; the child has no
TypeScript loader. Pass the same contract to the host and the generic runner.
Use a file URL for local contract modules. Network targets accept bare package
specifiers resolved from the runner's installation, not from the host module.
Resolve implementation paths with `new URL(...)` in the contract.
`Remote.local({ command })` can override the executable, using a nonempty array
of command and arguments. Its default resolves `@graftland/remote/bin` through
package exports. That executable must be built or installed; source development
can supply a custom command.

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
  business cleanup deadline is five seconds. For local targets, expiry fails
  cleanup and closes the process scope, whose Node spawner escalates to SIGKILL
  after one second. For network targets, the host still asks the supervisor to
  terminate and confirm exit; a disconnected host waits out the lease and
  margin.
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

## Cross-process services

Declare services in the shared contract with
`Contract.service(key, group, { toHandlers, fromClient })`, then list the
descriptors in `Contract.make({ inject: [...], provides: [...] })`. `toHandlers`
maps a service implementation to the group's handlers; `fromClient` maps its RPC
client back to the service interface. The latter explicitly chooses how to
expose `RpcClientError`: retain it in the service's error type, translate it, or
deliberately treat it as a defect. Calls are never automatically retried.

Each service uses its key as a separate port endpoint. RPC tags may repeat
across services or match control tags. Service keys must be unique across both
`inject` and `provides`, and the control endpoint `@graftland/remote/control` is
reserved; conflicting keys fail when defining the contract. Both contract
modules must use matching service keys, RPC tags, and schemas. See
`test/fixtures/services-contract.ts` for complete mappings, including a stream.
Some nested handler parameters need explicit annotations with the current
TypeScript/RPC types.

The proxy declares host-side `inject` dependencies. Their implementations run on
the host, and the child receives their clients as root provisions before its
implementation loads. A child export bridge leases the declared `provides`; only
after the child plugin and bridge are active does the proxy publish those
clients on the host. Other child provisions remain internal.

On host withdrawal, Graft drains host consumers before the proxy disposes its
child. Both RPC directions remain available during consumer finalizers. Host
dependency withdrawal uses the existing inject lifecycle and creates a new
process when that dependency becomes available again. The host dependency graph
includes the proxy, so publication-cycle detection remains effective.

If the child withdraws an export first, its bridge requests host withdrawal and
holds the export lease until Dispose releases it. The host uses the typed
`RemoteWithdrawn` error to start teardown. A failure that only becomes
observable after releasing that lease is returned through Dispose, retaining its
reasons at the top level of the host cleanup cause (Fail becomes Die under the
finalizer rule above). This avoids a circular wait between consumer draining and
the child's Failed state. It does mean such a late failure arrives through
cleanup rather than the ordinary typed failure channel.

Inside the implementation, inject `Remote.Instance` to read
`{ id, generation }`. Each local activation gets a new UUID and generation 1;
these local values are not persistent fencing tokens. A network execution gets
the configured or loader-derived logical instance id and a generation allocated
durably by its runner. The runner injects these through trusted startup
arguments, not business Load. Plugins can pass the generation to systems that
enforce fencing. The reference's fallback outside a remote activation is
`{ id: "local", generation: 0 }`.

## Port transport and limits

Stdin carries host-to-child frames; fd 3 carries child-to-host frames. Either
can contain requests or responses. Every frame includes a session nonce,
endpoint name, direction, priority, and encoded RPC message. A connection shares
one reader and writer across endpoints; each endpoint has its own request IDs
and typed RpcClient or RpcServer. The channel interface accepts an Effect Stream
and Sink and does not depend on ChildProcess.

Ordinary stdout is drained, so `console.log` cannot corrupt RPC; stdout is not
converted into structured Graft logs. Stdin and fd 3 are reserved for the
protocol. Discard calls and notifications are not supported.

Admission is bounded separately per priority and direction: 8 control, 16 data,
and 2 log requests by default. Excess local calls wait for a slot; waiting is
interruptible and connection failure fails the waiters. Excess remote admissions
fail the connection. Each inbound limit must be at least the peer's outbound
limit: local peers share defaults, and the network Open handshake negotiates
these limits before starting business RPC. Writer queues hold at most 64
control, 32 data, and 4 log frames. Each admitted request has a two-message
mailbox, and RPC ACKs bound outstanding stream chunks. A stalled stream does not
block the shared reader. Connection failure stops dispatch and fails the client
while interrupting the server's requests. Frames from retired sessions are
discarded before decoding their RPC payloads.

RPC annotations select request priority; ACKs, interrupts, and terminal replies
use control priority. The writer chooses control before data before logs.
Already-written bytes and the frame currently being written cannot be preempted.
The NDJSON reader rejects lines longer than 1,048,576 characters. These are
count and line-length limits, not a complete heap or byte budget; network
adapters must also bound received chunks and enforce their byte framing limits.

There is no code distribution, placement, or automatic runner failover. This
implementation does not restrict the plugin's filesystem, network, or ability to
escape a process group. Deploy the runner inside the desired VM/container
boundary.

The runner buffers at most 128 pending log entries and reports cumulative losses
on the `Logs` RPC. The host emits warnings with `remote.logs.dropped` (the new
loss count) and `remote.logs.droppedTotal` (the cumulative count). The final
`LogsEnded` message reports the final count even when no log entry remains.

`Failed`, `Withdrawing`, and `Stopped` use a separate bounded control stream.
The transport uses RPC priority annotations, not log method-name inspection.
After control completion the host drains the bounded log tail within the
existing shutdown deadline.

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
while log consumption is suspended. `test/services.test.ts` covers nested
bidirectional calls, instance identity, draining before process exit, dependency
restart, publication cycles, streams and interruption, and failures during
export withdrawal. `test/port.test.ts` exercises saturated admission, bounded
writer backpressure, priority ordering, disconnects in both directions, and
stale-session rejection with in-memory byte channels.

Run from the workspace root:

```sh
devenv shell -- pnpm exec vitest run --project remote
devenv shell -- pnpm typecheck
devenv shell -- pnpm build
```

## Network runner

Install the contract and implementation packages under the runner's installation
root, and run the built executable:

```sh
graft-remote serve --host 0.0.0.0 --port 7443 \
  --root /srv/graft/install --state /var/lib/graft \
  --cert /run/secrets/server.crt --key /run/secrets/server.key \
  --ca /run/secrets/clients-ca.crt --lease "15 seconds" --grace "5 seconds"
```

Lease and grace accept Duration strings such as `"15 seconds"`. Values must be
finite and positive. Defaults are a 15-second lease and a five-second grace
period. The ready message is a JSON line with `event: "Listening"` and `port`.
`Runner.serve` also exposes a scoped Effect API; supply Node platform services,
`Digest`, and `SecureRandom` in the application environment. The executable
supplies these itself. The state directory requires a local filesystem and
exclusive ownership. A scoped `node:sqlite` exclusive transaction holds the
directory lock; a competing process fails startup, and the OS releases the lock
on SIGKILL. The record store still uses synchronized JSON files, not SQLite
tables.

```ts
const proxy = Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	target: Remote.runner({
		instance: "billing-worker",
		host: "runner.internal",
		port: 7443,
		tls: {
			cert: clientCertificate,
			key: Redacted.make(clientKey),
			ca,
			servername: "runner.internal",
		},
		lease: "15 seconds",
		margin: "5 seconds",
		expect: { version: "1.2.3", digest: installedPackageDigest },
	}),
})
```

`runner({ instance, ... })` uses the explicit instance when supplied. Otherwise
it uses `Entry.CurrentId` from `@graftland/loader`; without either, activation
fails with the typed `MissingInstance` error before connecting. The resolved id
is stable across host restarts; one runner owns it. The host queries the
authenticated key's generation high-water mark, then supplies it as
`expectedGeneration` in Open. A retained request id is replayed idempotently.
Otherwise a mismatched comparison returns `StaleSession`; a matching replacement
waits for confirmed old-process exit before allocating and persisting its
successor. This guarantees serial admission on this runner, not exactly-once
side effects. External systems must check generation fencing tokens.

### Loading from graft.yml

Point a relative entry path at a module that exports the remote proxy. Include
assigns an id when one is omitted and saves it in the YAML; keep that persisted
id to retain the same logical instance after a host restart.

```yaml
- name: ./billing.ts
  config:
    queue: invoices
```

The entry module uses the contract's ordinary config schema. Runner settings
come from Effect Config, not a second YAML format:

```ts
// billing.ts
import { Config, Effect, FileSystem, Redacted } from "effect"
import * as Remote from "@graftland/remote"
import { contract } from "my-plugin/contract"

const target = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const read = (name: string) =>
		Config.String(name).pipe(Effect.flatMap((path) => fs.readFileString(path)))
	return Remote.runner({
		host: yield* Config.String("RUNNER_HOST"),
		port: yield* Config.Port("RUNNER_PORT"),
		tls: {
			servername: yield* Config.String("RUNNER_SERVERNAME"),
			ca: yield* read("RUNNER_CA"),
			cert: yield* read("RUNNER_CERT"),
			key: yield* read("RUNNER_KEY").pipe(Effect.map(Redacted.make)),
		},
	})
})

export default Remote.plugin(contract, {
	target,
	contractModule: "my-plugin/contract",
})
```

`RUNNER_CA`, `RUNNER_CERT`, and `RUNNER_KEY` are file paths on the host. The
configured target runs on each activation using the host's ConfigProvider and
FileSystem; importing the entry performs no I/O. Config and file-read failures
are retained in `RemoteError.cause`. An explicit `instance` overrides the loader
id, including inside nested groups. Local targets keep their existing identity
behavior.

With host HMR enabled, re-evaluating this entry creates a new Plugin object and
restarts the proxy: the old execution terminates before a new generation starts.
The implementation module installed on the runner is outside the host HMR graph.

TLS requires version 1.3, trusted client certificates, and server hostname
verification. Identity comes from exactly one SAN URI of the form
`graft://name`, where name matches `[a-z0-9][a-z0-9._-]*`. There is no CN
fallback. Renewing a certificate with the same URI preserves its namespace. Use
a dedicated CA: issuing the same URI grants access to the same logical
instances. The dedicated CA supplies a single graft URI; missing or ambiguous
identities are rejected. Session methods authorize every handle against the
authenticated connection.

The runner terminates only session RPC. Instance traffic is relayed as opaque
frames to the child, so services still use one end-to-end RPC relationship. An
eight-byte outer header identifies the protocol version, channel, and payload
length; payloads over 1 MiB are rejected before JSON decoding. Multiplex only
frames and routes bytes, preserving FIFO order within each channel and selecting
session traffic before instance traffic. Port owns request admission and RPC ACK
backpressure, with control, data, and log priorities. There is no second credit
window. No transport can preempt bytes already written to the socket. Open
negotiates RPC admission limits to their per-priority minimum and installs them
in both host and child. An execution channel has only one attached reader;
competing attachments fail.

The host renews at approximately T/3. The supervisor and child both enforce the
lease. fd 4 is reserved for supervision commands; a worker-thread watchdog owns
it independently of plugin JavaScript. EOF or expiry kills the entire child,
even if its main thread is looping. Normal Dispose first completes plugin
finalizers and log draining, then requests process shutdown and waits for exit.
The runner's graceful deadline escalates to kill and then bounded exit
confirmation. The three outcomes are observable as follows:

- Confirmed exit: `remote.termination: Exited` in host Graft logs.
- Confirmed forced termination: `remote.termination: Killed` in those logs.
- Lost confirmation: after a full T plus margin, `RemoteTerminationUnconfirmed`
  in cleanup, retaining the transport cause. A timeout never counts as proof of
  exit.

Those logs include `remote.instance` and `remote.generation`; Status retains the
termination result, exit status, stderr tail, and diagnostic cause. The margin
default is five seconds. On unexpected exit, heartbeat/status observation fails
the host proxy. A watchdog deadline or abrupt loss can prevent finalizers; only
the graceful path promises cleanup completion. Whole-process/VM suspension also
suspends the watchdog, so this is not a hard real-time bound.

Before running plugin code, Execution records a gated child's PID and OS start
time durably. Recovery runs before the TLS listener opens. It compares PID and
start time; mismatches are not signaled. Matching survivors are killed and their
exit confirmed. A zombie is already stopped; the parent still needs to reap it.
There remains a small check-to-signal PID reuse window without an OS process
handle. An external supervisor must terminate the whole cgroup or container to
cover plugin-spawned descendants (for example, systemd
`KillMode=control-group`). A failed recovery fences admission instead of
assuming that the old process is gone.

Stored leases never resume after restart. The store atomically synchronizes each
record before returning a generation and compacts terminal history, keeping all
unfinished records plus each key's highest generation. Compacted request ids
cannot allocate a new generation through retry because their expected generation
is stale. Status/Dispose of compacted records also return `StaleSession`; only
retained results are replayable. Storage grows with logical keys and unfinished
sessions.

Package specifiers resolve from the configured installation root. The runner
trusts its installed packages and follows their filesystem links. Resolution
uses import exports without importing the contract. Load reports package name,
version, and digest. Host pins are checked before sending business Load;
rejected pins never apply the plugin and dispose the allocated execution.

The digest is SHA-256 over sorted package entries, excluding every
`node_modules` subtree. Its domain prefix is `graft-package-sha256-v1\0`;
entries encode type, UTF-8 path length, file length, path, and contents. Keep
installations immutable through resolution and execution. This is a content
digest, not an installation signature, dependency digest, or filesystem
snapshot.

## Network validation

`network.test.ts` runs the real executable and real child processes with
temporary openssl certificates. It covers nested calls in both directions,
streams and interruption, trusted instance identity, consumer draining before
confirmed normal exit, partitions and unconfirmed termination, SIGKILL and
stalled-runner watchdog enforcement, serial generations, late renewals, restart
recovery, PID/start mismatch safety, exclusive locking, authentication, pins,
and the required logical instance id. Private keys are generated at setup and
removed at teardown. Real-process deadlines have generous margins; supervisor
timing and lease edge cases in `runner-supervisor.test.ts` use TestClock.

`runner-framing.test.ts`, `runner-tls.test.ts`, and `runner-packages.test.ts`
independently test byte limits, channel ordering, stable certificate identity,
rejection paths, package resolution, and digest behavior. The network suite also
loads a relative entry through Loader and Include, reloads the same persisted
YAML in a fresh host runtime, and checks identity, confirmed exit, generation
ordering, explicit overrides, and the missing-instance error.

## Trust and deployment assumptions

Run the supervisor on Node.js 22.22 or later on Linux or macOS; Windows is not
supported. Node 22 may emit an ExperimentalWarning for the `node:sqlite`
directory lock.

The runner trusts its dedicated CA, installation directory, state directory, and
operating system, including `ps` output. A certificate issued by that CA grants
access to its SAN URI's instance namespace. CA compromise is outside this model.
Root access on the runner machine is outside this model. Plugin escape from its
process must be prevented by the deployment's VM or container boundary. The
small race between checking process identity and signaling its PID remains an
accepted limitation. Whole-machine suspension suspends lease enforcement. An
external supervisor must stop the entire process group or container to cover
descendants created by a plugin.

Session state is persisted as a phase-tagged record. This private refactor
changes the on-disk format; stop all instances before replacing a prototype
runner and use a fresh state directory. Do not discard the generation high-water
marks of an active deployment or reuse its fencing namespace with downstream
systems.

Plugin failures expose declared contract errors, `UndeclaredFailure`,
`RemoteWithdrawn`, `MissingInstance`, and `RemoteError`. Infrastructure details
remain available in `RemoteError.cause`; consumers do not need to handle
individual RPC, socket, or runner journal error types.
