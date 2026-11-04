---
title: Remote plugins
description: Run a plugin in a child process, a Node worker, or on a runner.
---

Load `name: remote` to run a plugin outside the host's execution context. Choose
a local child, a Node worker, or a connection to a runner. Consumers still
inject ordinary Graft services and stop when their provider withdraws.

Remote separates execution, not permissions. Use a container or VM for that
boundary; use [isolation](../isolation/) to control service visibility. The
[06 · Remote tutorial](https://github.com/graftland/graft/tree/main/samples/06-remote)
runs both local and worker connections. The
[chat-bot sample](https://github.com/graftland/graft/tree/main/samples/chat-bot)
isolates its weather integration in a child process.

## Define a contract

The host imports only the contract. Its `module` points to a separate
implementation, which exports a normal Graft plugin. Build both to JavaScript
before starting a child or worker; neither uses the host's TypeScript loader.

```ts title="contract.ts"
import { Contract } from "@graftland/plugin-remote"
import { Schema } from "effect"

export const config = Schema.Struct({ greeting: Schema.String })
export const contract: Contract.Contract<typeof config, typeof Schema.Never> =
	Contract.make({
		name: "greeter",
		config,
		error: Schema.Never,
		module: new URL("./worker.js", import.meta.url).href,
	})
```

```ts title="worker.ts"
import { Plugin } from "@graftland/graft"
import { Effect } from "effect"
import { config } from "./contract.js"

export default Plugin.make({
	name: "greeter",
	config,
	apply: ({ greeting }) => Effect.log(greeting),
})
```

Export the contract as `contract` or `default`. Config must encode as JSON;
contract codecs must not require services. Declare expected failures with the
contract's `error` schema.

## Load it from YAML or TypeScript

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect:
      local: {}
    config:
      greeting: Hello
```

Run `graft start`. No capability entries or service-key strings are needed. For
a Node worker, replace `local: {}` with `worker: {}`. The TypeScript form uses
the same `connect` data and business `config`:

```ts title="entry.ts"
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
	config: { greeting: "Hello" },
	shutdownTimeout: "5 seconds",
})
```

Load it with `Graft.plugin(entry)`. `contractModule` identifies the contract for
the child or runner; it is distinct from the contract's implementation `module`.
A custom host supplies `NodeServices.layer` and `SecureRandom.layerWebCrypto`
where it builds `Graft.layer`. The CLI supplies them. You can also provide the
loader's `ModuleResolver` and `ConfigDirectory` in that environment.

For a runner connection, install the contract package on both machines:

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      url: !env RUNNER_URL
      ca: ./certs/ca.crt
      auth:
        mtls:
          cert: ./certs/client-billing.crt
          key: ./certs/client-billing.key
      lease: 30 seconds
    config:
      greeting: Hello
```

Set `RUNNER_URL` to `wss://runner.example:7443`, then run
`graft start --config host.yml`. Paths are relative to the containing config
file, not the process working directory. Certificates, keys, and CA strings are
file paths. Token strings are values; use `{ file: "./token.txt" }` to read a
file. Each location allows exactly one transport and one auth form.

`connect` also accepts `unix: /run/graft.sock`,
`command: [ssh, runner.example, graft-remote, serve, --config, /srv/stdio.yml]`,
`local: { command: [node, /path/to/bin.js] }`, or `worker: { execArgv: [] }`.
Command connections accept optional `cwd` and `env` fields.

TS additionally accepts credential Effects, read once for each connection:

```ts
import { Config } from "effect"

Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		url: "wss://runner.example:7443",
		instance: "greeter",
		auth: { jwt: { token: Config.Redacted("RUNNER_TOKEN") } },
	},
	config: { greeting: "Hello" },
})
```

A service-backed token can be `{ inject: [Vault], read: Vault.pipe(...) }` in
place of that Effect. Token Effects return `Redacted<string>`; an mTLS Effect
returns `{ cert: string, key: Redacted<string> }` containing PEM. Remote owns a
credential child plugin with those dependencies. Withdrawing one stops the
proxy. `retry` belongs on `Remote.plugin`; calls are not automatically retried.

| `connect` option | Default and meaning                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance`       | Loader entry id; an explicit value overrides it. Neither available: `MissingInstance`.                                                                                                                  |
| `lease`          | Runner default, normally 15 seconds. A host value overrides it for this instance.                                                                                                                       |
| `margin`         | 5 seconds beyond the lease to wait for exit confirmation.                                                                                                                                               |
| `expect`         | No checks. `{ version, digest }` can enforce either or both package checks before activation. Digest covers package files except `node_modules`, not dependencies, and is computed only when requested. |

The loader persists entry ids in YAML. Keep them across restarts. Child plugins
inherit `Entry.CurrentId`: two runner proxies forked from one entry need
distinct explicit instances or they replace each other. Embedded `Group.Group`
ids are only unique among siblings. Hosts sharing an authenticated identity and
instance name share the same runner slot too.

## Share services

Use `Contract.service(key, rpcGroup, { toHandlers, fromClient })` to describe a
service, then list it in `Contract.make`:

- `inject`: host services the implementation needs.
- `provides`: services the implementation publishes to host consumers.

Only declared services cross the boundary. Keys and RPC schemas must match;
service keys must be unique within a contract, but RPC method names can repeat
across services. The
[sample contract](https://github.com/graftland/graft/blob/main/samples/06-remote/src/contract.ts)
shows how `fromClient` maps `RpcClientError` into a service's own error.

Consumers finish before normal provider withdrawal, so their finalizers can
still call a healthy remote service. A withdrawn host dependency stops the proxy
until the dependency returns. Withdrawal of a child's exported service stops
host consumers. Connection failure can interrupt calls and finalizers.

## Configure a runner

Install Node.js 22.22 or later on Linux or macOS, remote, the built plugin
packages, and their dependencies. The runner resolves contract package names
under `root`; the host does not upload code. Keep installations unchanged while
running. Run the runner under an external supervisor that stops all descendants
(for example systemd `KillMode=control-group`).

```yaml title="runner.yml"
- id: runner
  name: remote/runner
  config:
    root: ./installation
    state: ./state
    lease: 15 seconds
    grace: 5 seconds
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth:
          mtls:
            ca: ./certs/ca.crt
      - unix: ./runner.sock
        auth:
          none:
            identity: billing
```

```sh
graft-remote serve --config runner.yml
```

`serve` accepts only `--config`. One runner entry owns its supervisor and all
its listeners; they share an instance namespace. It starts only when all
listeners are ready. A startup failure closes resources already opened; a later
listener failure leaves the others and the supervisor running. One JWT issuer is
allowed per runner, including third-party authenticators declaring an issuer.
Bearer token files do not count as issuers.

Each entry gets private capability providers. Two entries may use the same
capability with different configuration without colliding. For custom plugins,
use `transport: { name: "my-connector", config: {...} }` or
`auth: { name: "my-authenticator", config: {...} }`. Names use the application's
loader resolution rules. Built-in forms expand to the same references.

For wss, provision a server certificate and trusted CA. For mTLS, keep client
certificates under a dedicated CA:

```sh
graft-remote certificates --out certs --server runner.example --identity billing
```

Other tools work too. Keep `ca.key` with the operator; deploy server key/cert to
the runner and `client-billing.key`/`.crt` to the host. Both need `ca.crt`. The
hostname must match the server certificate. An mTLS client needs exactly one
`graft://` SAN URI, such as `graft://billing`; other URI SANs may coexist.
Rotating certificates with the same identity preserves the namespace.

`state` must be on a local filesystem and owned by one running supervisor.
Preserve it across restarts; it records generations and unfinished executions.
Do not reuse an active deployment's identity with an empty state directory.

## Choose transport and authentication

| `connect` / runner listener    | Auth                          | Guarantees and WARN                                                                                                                                      |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local: {}`                    | No `auth`                     | Separate process, normal OS permissions; no transport WARN.                                                                                              |
| `worker: {}`                   | No `auth`                     | Same process; execution isolation, **no permission isolation**; no transport WARN.                                                                       |
| `url: wss://…`                 | mtls, bearer, jwt, none       | Encrypted, server certificate verified. None warns at runner startup and every connection.                                                               |
| `url: ws://…`                  | bearer, jwt, none             | Unencrypted. Runner warns at startup, host at connection; token warnings explicitly say credentials travel in plaintext. None also warns per connection. |
| `unix: …`                      | bearer, jwt, none             | Filesystem permissions control access; no peer credentials read and no transport/auth WARN.                                                              |
| `command: […]` / `stdio: true` | No explicit `auth`, even none | Authentication and encryption belong to the external command, such as SSH.                                                                               |

Omitted auth means none, with runner identity `anonymous`. On a network listener
this produces WARNs; all callers share its identity. mTLS requires wss. For ws
omit cert/key; for wss supply both. WebSocket uses `/graft` and subprotocol
`graft-remote.v1`. There are no other HTTP endpoints or health checks.

- **Bearer:** host `auth: { bearer: { token: "value" } }`; runner
  `auth: { bearer: { tokens: "./tokens.json" } }`. The file maps SHA-256 hex
  digests to identities: `{ "<sha256 hex>": "billing" }`, never plaintext
  tokens.
- **JWT:** host `auth: { jwt: { token: { file: "./token.txt" } } }`. Runner uses
  `auth: { jwt: { issuer: "https://issuer.example", audience: [graft], algorithms: [ES256], keys: { publicKey: "./public.pem" } } }`.
  Use `keys: { jwksUrl: "https://issuer.example/jwks" }` instead for JWKS.
  `identityClaim` defaults to `sub`, `clockTolerance` to `5 seconds`. The claim
  must be a nonempty string, `exp` is required, and `nbf` is checked.
- **None:** `auth: { none: { identity: billing } }` on the runner assigns a
  name; it does not authenticate callers.

Missing or invalid bearer/JWT credentials return 401 with `WWW-Authenticate`
before upgrade. JWT is checked only then; expiry does not disconnect an existing
session. Stolen tokens can be replayed while valid. Use wss and short lifetimes.

For stdio, use one `listen` element: `{ stdio: true, identity: billing }`. It
cannot share a runner with another listener. Stdout is protocol bytes; logs go
to stderr. EOF stops executions, confirms exit, releases the state lock, then
exits 0. Failure preserves the cause and exits nonzero. Concurrent invocations
with the same state directory fail. Use SSH `authorized_keys` forced commands
for authentication. SSH exit alone is not proof that the remote execution
exited.

Remote trusts the runner's installation, configuration, OS and local
permissions, the dedicated CA, and the configured JWT issuer and keys. It does
not support browser hosts, Web Workers, token refresh, mid-session
reauthentication, revocation lists, passwords, symmetric JWT, forwarded
certificate headers, disabled TLS verification, code distribution, runner
failover, or call replay.

## Connect through SSH

Install the plugin package on the runner and give this SSH identity its own
state directory. Use a stdio-only configuration:

```yaml title="stdio.yml"
- id: runner
  name: remote/runner
  config:
    root: /srv/graft/installation
    state: /srv/graft/state/billing
    listen:
      - stdio: true
        identity: billing
```

On the host, use the command form in `connect` (the same array works in YAML):

```ts
Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		command: ["ssh", "-T", "billing@runner.example"],
		instance: "greeter",
	},
	config: { greeting: "Hello" },
})
```

In the runner account's `authorized_keys`, restrict that key to the fixed
command. Replace the executable path and key with your deployment's values:

```text
restrict,command="/usr/local/bin/graft-remote serve --config /srv/graft/stdio.yml" ssh-ed25519 AAAA... billing-host
```

Do not allocate a terminal or print banners to stdout: it carries protocol
bytes. SSH authenticates the host; `identity` supplies its stable runner name. A
second concurrent invocation with this state directory is refused. SSH exit
alone does not confirm that the execution unit has stopped.

## Replacement and stopping

For one authenticated identity and instance, the runner confirms the old process
has exited **before** accepting a replacement. The persisted generation grows,
including after runner recovery. If exit cannot be confirmed, replacement fails.
Read `Remote.Instance` for `{ id, generation }`. External systems can reject
older generations (fencing); they must enforce this themselves. Generations do
not undo writes, make calls exactly once, or coordinate independent runners.
Direct local/worker activations always use generation 1 and fresh ids.

The host renews the lease. Without renewal, the child expires; loss of the
runner also triggers shutdown. Whole-machine suspension pauses enforcement, so
this is not a hard real-time deadline. Process identity checks retain a narrow
PID-reuse window. Keep an external supervisor responsible for descendants.

Stopping first runs graceful Dispose. `shutdownTimeout` defaults to five seconds
and bounds only that step. Afterwards:

- Local children get one more second to exit naturally, then forced termination;
  the spawner escalates to SIGKILL after another second and confirms exit.
- Workers get the same one-second window, then `worker.terminate()` and
  confirmed thread exit. Timeouts remain cleanup errors even after successful
  termination.
- Runner connections wait at most lease plus host `margin`. Runner `grace`
  (default five seconds) is its interruption-to-kill window; `margin` only gives
  the host extra time to obtain confirmation.

| Result                         | Meaning                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `Exited`                       | Normal stop and process exit confirmed.                                                                                      |
| `Killed`                       | Forced termination confirmed; finalizers may be incomplete.                                                                  |
| `RemoteTerminationUnconfirmed` | Exit unconfirmed, either after disconnection or because the connected runner cannot confirm it. Timeout does not prove exit. |

The first two appear in `remote.termination` logs with instance and generation.
The third is a cleanup error. Clean disconnects produce no ERROR; abnormal
connections produce a Warning with cause and peer identity. Dispose and leases,
not the connection alone, govern execution lifetime. Logs may be dropped under
load; the host reports the count.

The TS proxy exposes declared errors, `Contract.UndeclaredFailure`,
`RemoteWithdrawn`, `RemoteError` (with cause), and `MissingInstance`. Disposal
reports `Fork.CleanupError`; inspect its cause for
`RemoteTerminationUnconfirmed`. Defects remain defects. YAML errors also
identify the entry and failing field.

## Hot reload

Reloading a host entry replaces its execution; runner generations advance after
confirmed exit. **Restart the host after changing a contract.** Raw contract
imports do not participate in HMR. Runner implementation modules are outside the
host HMR graph: deploy them on the runner, then restart the proxy.

## Write a capability plugin

The public [capability author guide](../remote-capabilities/) covers the four
service contracts, handshakes, and reusable conformance checks. Built-in modules
under `host/*` and `runner/*` implement those same contracts; applications do
not need to load them as separate entries.
