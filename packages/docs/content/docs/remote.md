---
title: Remote plugins
description: Run a plugin in a child process, a Node worker, or on a runner.
---

Use `Remote.local()` to start a Node.js child, `Remote.worker()` for a Node
worker thread, or `Remote.runner(...)` to connect to a runner. The host still
loads an ordinary Graft plugin: consumers wait for services, restart on
withdrawal, and stop before providers.

This separates execution, not permissions. A plugin can still access its
machine's files and network. Use a container or VM when you need that boundary.
For service visibility within one process, use [isolation](../isolation/).

The
[remote-worker sample](https://github.com/graftland/graft/tree/main/samples/remote-worker)
includes a working service, host, child, and test. It needs no network or
certificates. The
[remote-runner sample](https://github.com/graftland/graft/tree/main/samples/remote-runner)
runs a `graft.yml` entry on a real runner over wss with JWT and shows
generations fencing out a stale write.

## Separate the contract from the implementation

The host imports only the contract. Put the implementation in a separate module
so importing the host entry cannot start or load it:

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

Export the contract as `contract` or `default`. Export the implementation as a
plugin. Use matching config schemas; config must encode as JSON. Put expected
plugin errors in the contract's `error` schema. Contract codecs must not need
external services.

Build both modules to JavaScript before starting a child or worker. Neither uses
the host's TypeScript loader.

## Load the capabilities you use

Remote uses ordinary Graft plugins on both sides. `Remote.plugin` injects the
capabilities selected by its target; it installs no providers. Missing providers
leave the proxy Pending. Withdrawing a transport or credential provider also
withdraws its dependent proxies.

The public contract modules `@graftland/plugin-remote/Transport`, `Auth`, and
`Supervisor` contain service keys and interfaces, not implementations.
`Auth.Peer` carries the authenticated identity. Load implementations by their
module names in YAML, or import their default exports and use `Graft.plugin`:

| Side   | Plugin subpaths under `@graftland/plugin-remote/`                               | Purpose                                                                                     |
| ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Host   | `host/local`, `host/worker`                                                     | Create a child process or Node worker. No auth plugin.                                      |
| Host   | `host/websocket`, `host/unix`, `host/command`                                   | Connect to a runner using the selected transport.                                           |
| Host   | `host/auth/mtls`, `host/auth/bearer`, `host/auth/jwt`, `host/auth/none`         | Prepare the chosen credentials; command needs none of these.                                |
| Runner | `runner/supervisor`                                                             | Own execution, persistent generations, leases, and the state-directory lock.                |
| Runner | `runner/websocket`, `runner/unix`, `runner/stdio`                               | Accept host sessions. Multiple network listeners share the supervisor's instance namespace. |
| Runner | `runner/auth/mtls`, `runner/auth/bearer`, `runner/auth/jwt`, `runner/auth/none` | Map credentials to stable identities. Stdio does not use an authenticator.                  |

There can be only one provider per service key in a realm. Listener `auth`
values are full service keys, such as
`@graftland/plugin-remote/Auth/JwtAuthenticator`, not entry ids. Withdrawing
that authenticator closes its listeners; the supervisor stays active.

## Start a local child or Node worker

```ts title="entry.ts"
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
	shutdownTimeout: "5 seconds",
})
```

Load `host/local` alongside the entry:

```yaml title="graft.yml"
- name: "@graftland/plugin-remote/host/local"
- name: ./entry.ts
  config:
    greeting: Hello
```

For a Node worker, change the target to `Remote.worker()` and the capability to
`host/worker`. It shares the host process and permissions. Forwarded Effect logs
identify it by `remote.threadId` instead of a separate PID.

Load this entry with `Graft.plugin(entry, { greeting: "Hello" })` or through
[graft.yml](../config-file/). A custom host supplies `NodeServices.layer` and
`SecureRandom.layerWebCrypto` (from `effect/crypto`) in the environment where
`Graft.layer` is built. The CLI supplies both. The installed or built
`@graftland/plugin-remote` executable starts the child for you.

Each activation gets a fresh process. Config changes restart it. Child failures
fail the host proxy; any retry policy belongs on that proxy. Retrying creates
another process. Effect logs appear in the host with `remote.pid`; use Effect
logging, since `console.log` output is not forwarded as structured logs.

## Share services across the boundary

Describe each service with `Contract.service(key, rpcGroup, mapping)`. The RPC
group defines the payloads, results, errors, and any streams. The mapping keeps
the service's usual interface:

```ts
const formatter = Contract.service(Formatter, api, {
	toHandlers: (service) => ({
		Format: ({ text }: { readonly text: string }) => service.format(text),
	}),
	fromClient: (client) => ({
		format: (text) =>
			client
				.Format({ text })
				.pipe(
					Effect.catchTag("RpcClientError", (cause) =>
						WorkerUnavailable.make({ cause }),
					),
				),
	}),
})
```

Here `Formatter`, `api`, and `WorkerUnavailable` are defined in the sample's
[contract](https://github.com/graftland/graft/blob/main/samples/remote-worker/src/contract.ts).
The adapter translates connection failures into a service error. Choose that
policy explicitly; a remote call can fail even when its local counterpart
cannot. Calls are not automatically retried.

Add descriptors to `Contract.make`:

- `inject: [hostService]`: the host provides the service; the child injects its
  key.
- `provides: [formatter]`: the child publishes the service; host plugins inject
  its key.

Only declared services cross the boundary. Both sides need matching keys and RPC
schemas. Keys must be unique across the contract; RPC method names may repeat in
different services.

On normal withdrawal, host consumers finish before the child stops. Their
finalizers can still call the remote service while the connection is healthy. If
a host dependency goes away, the proxy stops too and waits for it to return. If
the child withdraws an exported service, host consumers also stop. A broken
connection can interrupt calls; it cannot promise successful finalizer RPCs.

## Load a network worker from graft.yml

Point the entry at a local module. Its config remains the plugin's business
input:

```yaml title="graft.yml"
- name: "@graftland/plugin-remote/host/websocket"
- name: "@graftland/plugin-remote/host/auth/jwt"
- id: greeter
  name: ./greeter.ts
  config:
    greeting: Hello
```

The entry reads runner settings from environment variables through Effect
Config:

```ts title="greeter.ts"
import * as Remote from "@graftland/plugin-remote"
import { Config, Effect, FileSystem } from "effect"
import { contract } from "my-plugin/contract"

const target = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const ca = yield* Config.String("RUNNER_CA").pipe(
		Effect.flatMap((path) => fs.readFileString(path)),
	)
	return Remote.runner({
		transport: Remote.websocket({
			url: yield* Config.String("RUNNER_URL"),
			tls: { ca },
		}),
		auth: Remote.jwt(Config.Redacted("RUNNER_TOKEN")),
	})
})

export default Remote.plugin(contract, {
	target,
	contractModule: "my-plugin/contract",
})
```

Replace `my-plugin/contract` with your contract export. Install matching
versions on host and runner. `expect: { version, digest }` can require either or
both checks before starting. `RUNNER_URL` is a wss URL matching the server
certificate; `RUNNER_CA` is the host's CA file path. `RUNNER_TOKEN` is the JWT.
Config and files are read on activation, never on module import.

Set these options inside `Remote.runner({ ... })`, alongside `transport` and
`auth`:

| Option     | Default and meaning                                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance` | The loader entry id. An explicit string overrides it. Without either, activation fails with `MissingInstance`.                                                                                                        |
| `lease`    | The runner's `--lease` value, 15 seconds by default. A host value such as `"30 seconds"` overrides that runner default for this instance.                                                                             |
| `margin`   | `"5 seconds"`. Extra time beyond the lease for the host to wait for termination confirmation.                                                                                                                         |
| `expect`   | No checks. `{ version, digest }` pins the installed package; either field is optional. The digest is only computed when requested. It covers the package's own files, excluding `node_modules`, not its dependencies. |

The loader saves generated entry ids in YAML. Keep the saved id to address the
same instance after a host restart. `Entry.CurrentId` from `@graftland/loader`
is an `Option<string>` reference, inherited by child plugins forked inside that
entry. Two runner proxies forked from one entry without explicit `instance`
values therefore replace each other. Give them distinct names. Directly embedded
`Group.Group` only requires sibling ids to be unique, so ids from different
groups can collide too. Multiple hosts using the same authenticated identity and
the same instance name also address the same instance.

## Choose transport and authentication

| Target                                 | Allowed auth            | Protection and warnings                                                                                                                                   |
| -------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Remote.local()`                       | No `auth`               | Separate process, normal OS permissions. No transport WARN.                                                                                               |
| `Remote.worker({ execArgv? })`         | No `auth`               | Same process, separate execution; **no permission isolation**. No transport WARN.                                                                         |
| `Remote.websocket({ url: "wss://…" })` | mtls, bearer, jwt, none | Encrypted, server certificate checked. None warns at runner startup and on every connection.                                                              |
| `Remote.websocket({ url: "ws://…" })`  | bearer, jwt, none       | No encryption. Runner warns at startup, host on connection; bearer/JWT warnings say credentials travel in plaintext. None also warns on every connection. |
| `Remote.unix({ path })`                | bearer, jwt, none       | Access controlled by filesystem permissions; no peer credentials are read. No transport/auth WARN.                                                        |
| `Remote.command(argv, { cwd?, env? })` | No `auth`               | Starts a stdio runner; authentication and encryption belong to the command, for example SSH. No transport/auth WARN.                                      |

Wrap websocket, unix, and command in `Remote.runner({ transport, auth?, ... })`.
Local and worker are direct targets and do not use a supervisor. Omitting auth
on websocket/unix means `Remote.none()`; still load `host/auth/none` and
`runner/auth/none`. Its configured identity defaults to `anonymous`; every
connecting host shares that namespace.

- **mTLS:** load both `auth/mtls` plugins. Runner config is
  `{ ca: "clients-ca.crt" }`. The host uses
  `Remote.mtls(Effect.succeed({ cert, key }))`, with PEM strings and a
  `Redacted<string>` key. Only wss supports it.
- **Bearer:** runner config is `{ tokens: "tokens.json" }`. The JSON file maps
  SHA-256 hex digests to identities: `{ "<sha256 hex>": "billing" }`. Send the
  original token with `Remote.bearer(Config.Redacted("RUNNER_TOKEN"))`.
- **JWT:** use `Remote.jwt(Config.Redacted("RUNNER_TOKEN"))`. Runner config
  selects one `issuer`, an `audience` list, and a nonempty asymmetric
  `algorithms` allowlist. Set either
  `keys: { jwksUrl: "https://issuer.example/jwks" }` or
  `keys: { publicKey: "jwt-public.pem" }` (SPKI PEM). `identityClaim` defaults
  to `sub`; the selected claim must be a nonempty string. `clockTolerance`
  defaults to `5 seconds`. `exp` is required; `nbf` is checked when present.
- **None:** runner config is `{ identity: "billing" }`. It assigns an identity;
  it does not authenticate callers.

Credentials are read once per connection. For a service-backed credential
source, pass
`{ inject: [Credentials], read: Credentials.pipe(Effect.flatMap(...)) }` to
`Remote.jwt`, `Remote.bearer`, or `Remote.mtls`; those dependencies join the
proxy's inject list. JWT is verified only at upgrade. Expiry during an
established session does not disconnect it. Invalid or missing bearer/JWT
credentials return 401 with `WWW-Authenticate: Bearer` before a WebSocket is
established.

Stolen tokens can be replayed while valid. Use wss and short token lifetimes.
The runner trusts its configured issuer and keys. There is no token refresh,
mid-session reauthentication, revocation list, password auth, symmetric JWT, or
trust in forwarded certificate headers. TLS verification cannot be disabled.
Only Node hosts are supported, not browser hosts or Web Workers.

WebSocket uses `/graft` (added when omitted) and `graft-remote.v1`. There are no
other HTTP endpoints, including health checks.

## Prepare a runner

Use Node.js 22.22 or later on Linux or macOS. Install
`@graftland/plugin-remote`, the built plugin package, and their dependencies
under the installation root. Runner `contractModule` values are package
specifiers resolved there. The host does not upload code. Keep installed
packages unchanged while running.

`serve --config` loads ordinary Graft entries. This complete configuration uses
wss and JWT; paths in the file are relative to its directory.

```yaml title="runner.yml"
- id: remote-supervisor
  name: "@graftland/plugin-remote/runner/supervisor"
  config:
    root: /srv/graft/install
    state: /var/lib/graft
    lease: 15 seconds
    grace: 5 seconds

- id: remote-auth
  name: "@graftland/plugin-remote/runner/auth/jwt"
  config:
    issuer: https://issuer.example
    audience: [graft]
    algorithms: [ES256]
    identityClaim: sub
    clockTolerance: 5 seconds
    keys:
      publicKey: /run/secrets/jwt-public.pem

- id: public
  name: "@graftland/plugin-remote/runner/websocket"
  config:
    url: wss://0.0.0.0:7443/graft
    cert: /run/secrets/server.crt
    key: /run/secrets/server.key
    auth: "@graftland/plugin-remote/Auth/JwtAuthenticator"
```

```sh
graft-remote serve --config runner.yml
```

The command-line shorthand creates equivalent supervisor, authenticator, and
listener entries. It cannot be combined with `--config`. Repeat `--listen` for
multiple network listeners using the same auth:

```sh
# wss + mTLS
graft-remote serve --listen wss://0.0.0.0:7443 --auth mtls \
  --cert server.crt --key server.key --ca clients-ca.crt \
  --root /srv/graft/install --state /var/lib/graft

# ws + JWT (unencrypted)
graft-remote serve --listen ws://127.0.0.1:7080 --auth jwt \
  --jwt-issuer https://issuer.example --jwt-audience graft \
  --jwt-algorithm ES256 --jwt-public-key jwt-public.pem \
  --root /srv/graft/install --state /var/lib/graft

# Unix socket + none
graft-remote serve --listen /run/graft/runner.sock --auth none --identity billing \
  --root /srv/graft/install --state /var/lib/graft

# One session over stdin/stdout
graft-remote serve --stdio --identity billing \
  --root /srv/graft/install --state /var/lib/graft
```

For bearer use `--auth bearer --tokens tokens.json`. JWT also accepts
`--jwt-jwks URL` instead of `--jwt-public-key FILE`, repeated `--jwt-audience`
and `--jwt-algorithm`, `--jwt-identity-claim`, and `--jwt-clock-tolerance`.
Auth-specific flags must match the selected auth. For ws, omit cert/key; wss
requires both. mTLS is rejected on ws and unix.

Stdio is exclusive: one listener and one session per process, with no `auth`.
Its identity defaults to `anonymous`. Authentication belongs to an external
mechanism, such as an SSH `authorized_keys` forced command. Stdout contains only
protocol bytes; logs go to stderr. EOF stops the execution units, confirms exit,
then releases the state lock and exits successfully; cleanup failure preserves
its cause and exits nonzero. A second concurrent invocation using the same state
directory fails. See the sample's
[SSH instructions](https://github.com/graftland/graft/tree/main/samples/remote-runner#connect-over-ssh).
The SSH process exiting alone is not proof that a remote execution stopped.

For wss, provision a server certificate and its trusted CA. For mTLS, use a
**dedicated CA** for client certificates too:
`graft-remote certificates --out certs --server runner.example --identity billing`,
or any tool meeting these requirements. Keep `ca.key` with the operator. Deploy
`server.crt`/`server.key` to the runner; for mTLS deploy
`client-billing.crt`/`client-billing.key` to the host. Both need the relevant
`ca.crt`. TLS checks the server hostname. An mTLS client certificate must have
exactly one `graft://` SAN URI, for example `graft://billing`; other URI SANs
may coexist. Keep the same identity when rotating credentials to retain the
instance namespace.

`--grace` defaults to five seconds: after the runner requests interruption, it
waits that long before escalating to a forced kill. This is separate from the
host's `margin`, which extends the wait for exit confirmation; it does not give
plugin finalizers more time.

A `Listening` line reports the bound port. Give one runner exclusive ownership
of its state directory on a local filesystem. Preserve that directory across
restarts: it remembers instance generations and unfinished executions. Do not
reuse an active deployment's identity with an empty state directory.

Run the runner under an external supervisor that stops the whole process group
or container, including descendants a plugin starts. For systemd, use
`KillMode=control-group`. The runner trusts its CA, installed packages, state
directory, and operating system. It is not a sandbox for untrusted plugins.

## Replacement, leases, and stopping

For the same authenticated identity and instance id, one runner confirms that
the old process has exited **before** admitting a replacement. The replacement
gets a larger, persisted generation. This continues after runner recovery. If
exit cannot be confirmed, the runner refuses a replacement rather than assuming
success.

The host renews a lease while it is connected. Without renewal, the execution
expires; losing the runner also triggers child shutdown. The default lease is 15
seconds. This prevents an abandoned child from running indefinitely under normal
scheduling. Suspending the whole machine also suspends deadline enforcement, so
the lease is not a hard real-time guarantee. Process exit checks also retain a
small PID-reuse window.

Inside a remote plugin, read `Remote.Instance` for `{ id, generation }`.
External systems can reject writes from older generations: this is _fencing_.
They must enforce it themselves. Generations do not undo completed writes or
make calls exactly once, and they are not coordinated across independent
runners. Local children and Node workers get a new id and generation 1 each
time, not a persistent fencing token.

Normal stopping first waits for plugin finalizers and final logs. The proxy's
`shutdownTimeout` defaults to five seconds and bounds this graceful Dispose step
only. Process termination follows it:

- A local child gets one more second to finish output and exit naturally. If it
  stays alive, cleanup reports the exit timeout and terminates it. The process
  spawner escalates to SIGKILL after another second and confirms exit.
- A Node worker gets the same one-second exit window. On timeout, cleanup
  reports it, calls `worker.terminate()`, and waits for its actual exit.
- A runner-connected host waits at most the negotiated lease plus `margin` for
  termination confirmation. The runner uses its separate `--grace` window before
  forced killing.

Runner stopping has three observable results:

| Result                         | What you can rely on                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Exited`                       | Process exit was confirmed after the normal stop path.                                                                                                           |
| `Killed`                       | Forced termination was confirmed; finalizers may not have finished.                                                                                              |
| `RemoteTerminationUnconfirmed` | Exit could not be confirmed within the lease plus margin, whether contact was lost or the connected runner could not confirm it. A timeout is not proof of exit. |

The first two appear as `remote.termination` in host logs, with
`remote.instance` and `remote.generation`. The third appears in cleanup failure;
`Remote.RemoteTerminationUnconfirmed` is exported so you can recognize it there.
Cleanup errors remain errors even if the process was subsequently stopped. Logs
may be dropped under overload; the host reports the loss count.

A clean host disconnect ends its session without an ERROR. Abnormal disconnects
produce a Warning with the cause and peer identity; the runner keeps serving.
Execution lifetime is governed by Dispose and leases, not the connection alone.

## Handle failures

The proxy exposes the contract's declared errors, plus:

- `Remote.Contract.UndeclaredFailure`: the implementation failed with an error
  outside its contract; `original` retains its diagnostic value.
- `Remote.RemoteWithdrawn`: the child withdrew an exported service, so host
  consumers must stop.
- `Remote.RemoteError`: startup or infrastructure failed; `cause` retains the
  underlying reasons.
- `Remote.MissingInstance`: neither an explicit instance nor a loader entry id
  was available.

These are activation or background failures. Explicit disposal reports
`Fork.CleanupError`; inspect its `cause` for cleanup and termination errors,
including `Remote.RemoteTerminationUnconfirmed`. Unexpected defects remain
defects. A timeout never turns cleanup into success.

## Hot reload

Re-evaluating the host entry creates a new Plugin object. With
[HMR](../hot-reload/), this restarts the proxy and replaces its execution. A
network replacement gets a new generation after the old process stops. The
implementation installed on the runner is outside the host HMR graph; deploy it
on the runner and restart the proxy to use the new code.

There is no automatic code distribution, runner failover, or replay of calls.
