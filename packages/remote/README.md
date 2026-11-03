# @graftland/remote

Private remote-plugin implementation with a local process target. Each host
activation owns one Node.js process. Contracts can bridge services in both
directions. Network runners and security isolation are not implemented yet.

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
paths with `new URL(...)` in the contract. The installed-package resolver
described below is not yet wired into this local API.

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

## Cross-process services

Declare services in the shared contract with
`Contract.service(key, group, { toHandlers, fromClient })`, then list the
descriptors in `Contract.make({ inject: [...], provides: [...] })`. `toHandlers`
maps a service implementation to the group's handlers; `fromClient` maps its RPC
client back to the service interface. The latter explicitly chooses how to
expose `RpcClientError`: retain it in the service's error type, translate it, or
deliberately treat it as a defect. Calls are never automatically retried.

RPC tags must be unique within each direction, including the control tags
`Load`, `Events`, `Logs`, and `Dispose` in the child-facing direction. Use
qualified tags for unrelated services; duplicate tags fail when defining the
contract. Both contract modules must use matching service keys, RPC tags, and
schemas. See `test/fixtures/services-contract.ts` for complete mappings,
including a stream. Some nested handler parameters need explicit annotations
with the current TypeScript/RPC types.

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
`{ id, generation }`. For now each local activation gets a new UUID and
generation 1; these are not persistent fencing tokens. The reference's fallback
outside a remote activation is `{ id: "local", generation: 0 }`.

## Duplex transport and limits

Stdin carries host-to-child frames; fd 3 carries child-to-host frames. Either
can contain requests or responses. Every frame includes a session nonce,
direction, priority, and encoded RPC message. Each endpoint has one reader, one
writer, one RpcClient, and one RpcServer. The channel interface accepts an
Effect Stream and Sink and does not depend on ChildProcess.

Ordinary stdout is drained, so `console.log` cannot corrupt RPC; stdout is not
converted into structured Graft logs. Stdin and fd 3 are reserved for the
protocol. Discard calls and notifications are not supported.

Admission is bounded separately per priority and direction: 8 control, 16 data,
and 2 log requests by default. Excess local calls wait for a slot; waiting is
interruptible and connection failure fails the waiters. Excess remote admissions
fail the connection. Each inbound limit must be at least the peer's outbound
limit: local peers share defaults, and the network handshake must negotiate
these limits before starting RPC. Writer queues hold at most 64 control, 32
data, and 4 log frames. Each admitted request has a two-message mailbox, and RPC
ACKs bound outstanding stream chunks. A stalled stream does not block the shared
reader. Connection failure stops dispatch and fails the client while
interrupting the server's requests. Frames from retired sessions are discarded
before decoding their RPC payloads.

RPC annotations select request priority; ACKs, interrupts, and terminal replies
use control priority. The writer chooses control before data before logs.
Already-written bytes and the frame currently being written cannot be preempted.
The NDJSON reader rejects lines longer than 1,048,576 characters. These are
count and line-length limits, not a complete heap or byte budget; network
adapters must also bound received chunks and enforce their byte framing limits.

There is no code distribution, lease, authentication, network target,
scheduling, or stable logical instance identity yet. This implementation does
not restrict the plugin's filesystem, network, or ability to escape a process
group.

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
export withdrawal. `test/duplex.test.ts` exercises saturated admission, bounded
writer backpressure, priority ordering, disconnects in both directions, and
stale-session rejection with in-memory byte channels.

Run from the workspace root:

```sh
devenv shell -- pnpm exec vitest run --project remote
devenv shell -- pnpm typecheck
devenv shell -- pnpm build
```

## Network runner work in progress: session control

The first half of Phase 3 is implemented under `src/internal/runner`. It is not
wired to `Remote.plugin`, a TLS listener, or the runner executable yet.

- `Supervisor.make` owns session fibers, monotonic lease deadlines, generation
  allocation, idempotent Open/Load/Dispose, and status records. Defaults are a
  15-second lease, a five-second graceful deadline, and a five-second exit
  confirmation deadline after requesting a kill. It never treats sending a
  signal as proof of exit.
- Open takes an authenticated identity and logical instance id separately from
  its idempotency request id. Retrying an old request returns its original
  record, even after that record has been retired. It does not allocate a new
  generation. A new Open request waits for termination of the preceding unit.
- Limits are negotiated to the per-priority minimum. Both endpoints and the
  child must install the returned limits before starting business RPC. The TLS
  handshake still needs to enforce this.
- `Store.directory` writes schema-versioned records using file synchronization,
  atomic rename, and directory synchronization. It retains historical Open
  records to preserve idempotency and generation high-water marks. There is no
  automatic retention policy or compaction.
- The state directory requires one exclusive supervisor owner. The store is not
  a multi-process database, and daemon-level directory locking is not
  implemented in this half. A storage failure or an unconfirmed stop fences
  further admission; recovery must complete before a restarted supervisor
  exposes its API.
- `Execution` is an injectable process adapter contract. It must register a
  gated child and its PID/start identity before returning from spawn;
  registration is persisted before Load replies. The real child-process adapter
  and OS orphan reaper are still pending. Recovery tests currently verify the
  startup barrier and recorded identity with a controlled adapter, not OS-level
  PID reuse safety.
- Stored leases never resume across a supervisor restart. Construction invokes
  recovery for every unfinished recorded child and waits for confirmed exit.
  Only then can a new generation be opened.
- The termination-wait helper preserves a failed confirmation's cause and waits
  a full lease plus margin before adding `RemoteTerminationUnconfirmed`. It is
  not yet connected to the host transport.

All session timing tests use TestClock. They cover renewal, expiry, grace,
confirmation deadlines, an unfinished Load, superseding an instance, and loss of
contact without relying on elapsed wall-clock time. State-directory tests use
real temporary files. No network or real orphan-reaping guarantee is claimed by
this intermediate implementation.

## Network transport and package resolution work in progress

These internal components are tested independently; they do not yet expose a
network runner target or a `serve` command:

- `Tls.listen` requires a trusted client certificate and provides `Tls.Peer`
  from the authenticated leaf certificate's SHA-256 fingerprint. The subject
  name is not an identity key. Renewing a certificate changes this namespace;
  certificate rotation needs an explicit identity migration policy before
  deployment. `Tls.connect` verifies the server certificate and hostname. Both
  require TLS 1.3. Keys are passed as `Redacted` values.
- `Framing` uses an eight-byte header: wire version, channel, priority, kind,
  and a big-endian 32-bit payload length. Version 1 permits two channels
  (session 0, instance 1), three priorities (control 0, data 1, logs 2), and
  data or credit frames. Payloads are opaque bytes, limited to 1 MiB before
  allocation or payload decoding. Invalid headers and truncated frames fail the
  connection.
- `Multiplex` owns one byte reader and writer. Each channel/priority pair has
  four credits and bounded queues. Sends wait interruptibly for credits;
  consumption returns a credit through the writer. Inbound overflow and
  unsolicited credits fail the connection. Credits and control frames are
  written before queued data and logs; an in-progress socket write cannot be
  preempted. `forwardInstance` relays only channel 1 in both directions and
  leaves channel 0 local. The caller must authenticate and admit the instance
  before attaching this relay. Existing local stdio RPC has not migrated to this
  outer framing yet.
- `Packages.resolve` accepts bare package specifiers rooted in the runner's
  `node_modules`, including package-root symlinks used by pnpm. A short-lived
  Node process resolves import exports without importing the contract and
  without inherited loader options. Ancestor fallback, path specifiers, and
  exports outside the selected package are rejected. Package contents may not
  contain symlinks or special files. Internal symlinks are rejected even when
  their targets stay inside the package.
- The package digest streams sorted entries into SHA-256. Its domain prefix is
  `graft-package-sha256-v1\0`; each entry contributes its type, UTF-8 path byte
  length, file byte length (zero for directories), path bytes, and file
  contents. Every `node_modules` subtree is excluded. Version and digest pins
  are checked before returning the resolved entry. The installation must be
  immutable during resolution and execution; this is a content digest, not an
  installation signature, dependency digest, or filesystem snapshot.

`runner-framing.test.ts` covers incremental decoding, limits, priority, credit
backpressure, interruption, connection failure, and opaque forwarding.
`runner-tls.test.ts` uses localhost TLS and certificates generated by openssl
inside an ignored temporary directory, removed at teardown. It covers trusted
identity, missing/untrusted certificates, hostname verification, and rejection
of an oversized frame before any payload arrives. `runner-packages.test.ts` uses
real temporary installations and import-condition exports.

Still pending: the session RPC/Open handshake and its negotiated limits,
exclusive state-directory ownership, bounded retention with an explicit old
request replay policy, a PID-reuse-safe execution/recovery adapter, trusted
bootstrap identity, local/network host targets, renewals and termination
results, and executable integration. The framing credit window is fixed by wire
version; it is distinct from the RPC admission limits negotiated by the
supervisor. No network plugin lifecycle or real orphan-reaping guarantee is
claimed by this intermediate implementation.
