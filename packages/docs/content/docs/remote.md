---
title: Remote plugins
description: Run a plugin in a child process or on another machine.
---

Use `@graftland/remote` to move a plugin out of the host process. Choose
`Remote.local()` for a local Node.js child, or `Remote.runner(...)` for a runner
on another machine. The host still loads an ordinary Graft plugin. Its consumers
wait for services, restart on withdrawal, and stop before their providers do.

This separates execution, not permissions. A plugin can still access its
machine's files and network. Use a container or VM when you need that boundary.
For service visibility within one process, use [isolation](../isolation/).

The
[remote-worker sample](https://github.com/graftland/graft/tree/main/samples/remote-worker)
includes a working service, host, child, and test. It needs no network or
certificates. The
[remote-runner sample](https://github.com/graftland/graft/tree/main/samples/remote-runner)
runs a `graft.yml` entry on a real runner over mutual TLS and shows generations
fencing out a stale write.

## Separate the contract from the implementation

The host imports only the contract. Put the implementation in a separate module
so importing the host entry cannot start or load it:

```ts title="contract.ts"
import { Contract } from "@graftland/remote"
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

Build both modules to JavaScript before starting a child. Children do not use
the host's TypeScript loader.

## Start a local child

```ts title="entry.ts"
import * as Remote from "@graftland/remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
	shutdownTimeout: "5 seconds",
})
```

Load this entry with `Graft.plugin(entry, { greeting: "Hello" })` or through
[graft.yml](../config-file/). A custom host supplies `NodeServices.layer` and
`SecureRandom.layerWebCrypto` (from `effect/crypto`) in the environment where
`Graft.layer` is built. The CLI supplies both. The installed or built
`@graftland/remote` executable starts the child for you.

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
- name: ./greeter.ts
  config:
    greeting: Hello
```

The entry reads runner settings from environment variables through Effect
Config:

```ts title="greeter.ts"
import * as Remote from "@graftland/remote"
import { Config, Effect, FileSystem, Redacted } from "effect"
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

Replace `my-plugin/contract` with your package's contract export. Install
matching contract versions on host and runner. Set `expect: { version, digest }`
to require a particular package version and content digest before the plugin
starts; either check can be used alone. The three certificate variables are file
paths on the host. `RUNNER_SERVERNAME` must match the runner's server
certificate. Config and files are read when the plugin activates, not when the
module is imported.

Set these options inside `Remote.runner({ ... })`, alongside `host`, `port`, and
`tls`:

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
groups can collide too. Multiple hosts using the same certificate identity and
the same instance name also address the same instance.

## Prepare a runner

Use Node.js 22.22 or later on Linux or macOS. Install `@graftland/remote` and
the built plugin package, including its dependencies, under the installation
root. Network `contractModule` values are package specifiers resolved there. The
host does not upload code. Keep installed packages unchanged while they are
running.

Provision server and client certificates from a **dedicated CA**. Use
`graft-remote certificates --out certs --server runner.example --identity billing`,
or any other tool that produces certificates meeting these requirements. Keep
`ca.key` with the operator; deploy `server.crt` / `server.key` to the runner and
`client-billing.crt` / `client-billing.key` to the host, with `ca.crt` on both.
TLS checks the server hostname and requires a client certificate. Each client
certificate needs exactly one `graft://` SAN URI, such as `graft://billing`;
other SAN URIs may also be present. That identity owns an instance namespace:
issuing another certificate with the same URI grants the same access. Renewing a
certificate with the same URI keeps that namespace.

```sh
graft-remote serve --host 0.0.0.0 --port 7443 \
  --root /srv/graft/install --state /var/lib/graft \
  --cert /run/secrets/server.crt --key /run/secrets/server.key \
  --ca /run/secrets/clients-ca.crt --lease "15 seconds" --grace "5 seconds"
```

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

For the same certificate identity and instance id, one runner confirms that the
old process has exited **before** admitting a replacement. The replacement gets
a larger, persisted generation. This continues after runner recovery. If exit
cannot be confirmed, the runner refuses a replacement rather than assuming
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
runners. Local children get a new id and generation 1 each time, not a
persistent fencing token.

Normal stopping first waits for plugin finalizers and final logs. The proxy's
`shutdownTimeout` defaults to five seconds and bounds this graceful Dispose step
only. Process termination follows it:

- A local child gets one more second to finish output and exit naturally. If it
  stays alive, cleanup reports the exit timeout and terminates it. The process
  spawner escalates to SIGKILL after another second and confirms exit.
- A network host waits at most the negotiated lease plus `margin` for
  termination confirmation. The runner uses its separate `--grace` window before
  forced killing.

Network stopping has three observable results:

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
