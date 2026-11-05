---
title: Host entries
description:
  Describe a remote plugin with a contract and load it from YAML or TypeScript.
---

A host loads a remote plugin through its contract. The contract is the only
module the host imports; the implementation runs in the plugin process.

## Define a contract

Describe each service that crosses the boundary with `Contract.service`: its
key, an Effect `RpcGroup` of its calls, and two functions.

```ts title="src/contract.ts"
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Contract } from "@graftland/plugin-remote"

export class GreetingUnavailable extends Schema.TaggedError<
	GreetingUnavailable,
	{ readonly brand: unique symbol }
>()("GreetingUnavailable", { cause: Schema.Defect() }) {}

export class Greeter extends Context.Service<
	Greeter,
	{
		readonly greet: (name: string) => Effect.Effect<string, GreetingUnavailable>
	}
>()("app/Greeter") {}

const api = RpcGroup.make(
	Rpc.make("Greet", {
		payload: { name: Schema.String },
		success: Schema.String,
		error: GreetingUnavailable,
	}),
)

const greeter = Contract.service(Greeter, api, {
	toHandlers: (service) => ({ Greet: ({ name }) => service.greet(name) }),
	fromClient: (client) => ({
		greet: (name) =>
			client
				.Greet({ name })
				.pipe(
					Effect.catchTag("RpcClientError", (cause) =>
						GreetingUnavailable.make({ cause }),
					),
				),
	}),
})

export const contract = Contract.make({
	name: "greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	module: new URL("./greeter.js", import.meta.url).href,
	provides: [greeter],
})
```

`toHandlers` runs where the service is implemented, and `fromClient` where it is
used. Map `RpcClientError` in `fromClient`, so a broken connection reaches
callers as an error they already handle. `Contract.make` collects the
descriptions into the contract:

| Field      | Meaning                                                                                |
| ---------- | -------------------------------------------------------------------------------------- |
| `name`     | The plugin's name.                                                                     |
| `config`   | Config schema. Must encode to JSON.                                                    |
| `module`   | URL of the built implementation, usually `new URL("./impl.js", import.meta.url).href`. |
| `error`    | Schema of the plugin's declared failures. Defaults to `Schema.Never`.                  |
| `inject`   | Host services the implementation uses.                                                 |
| `provides` | Services the implementation publishes to the host.                                     |

- No schema in a contract may need services to encode or decode.
- Service keys are unique within a contract. RPC names may repeat across
  services.
- Export the contract as `contract` or as the default export.
- Both sides import the same built contract, so keys and RPC schemas match.

## Load from YAML

Replace the plugin's entry with a `remote` entry. `name: remote` loads
`@graftland/plugin-remote`, so install it in the application.

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

| Field      | Meaning                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `contract` | A path relative to the config file, a `file:` URL, or a package name. Through a runner, a package name only.          |
| `connect`  | Where the plugin runs. One of the forms below.                                                                        |
| `config`   | The plugin's config in encoded JSON form, checked against the contract's schema before anything starts. Default `{}`. |

| `connect` form                | Runs the plugin                                 | Other fields                                                                                    |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `local: {}`                   | In a child process on the host.                 | `local.command` replaces the bundled child entry, such as `[node, /path/to/childMain.js]`.      |
| `worker: {}`                  | In a Node worker in the host process.           | `worker.execArgv`: Node options for the worker.                                                 |
| `url: wss://…` or `ws://…`    | On a runner's WebSocket listener.               | `ca`: CA file to trust instead of Node's. `servername`: name to verify instead of the URL host. |
| `unix: path`                  | On a runner's Unix socket.                      | —                                                                                               |
| `command: [program, args…]`   | On a runner started by a command, such as SSH.  | `cwd`, `env`.                                                                                   |
| `transport: { name, config }` | Through a [custom connector](../capabilities/). | —                                                                                               |

- `local` and `worker` take no other fields: no `auth`, `instance`, `lease`,
  `margin` or `expect`.
- Runner forms also take `auth`
  ([Transport and authentication](../transport-auth/)), `instance` and `expect`
  ([Runners](../runners/#instances)), and `lease` and `margin`
  ([Replacement and stopping](../lifecycle/#timeouts-and-defaults)).
- Paths are relative to the config file, not the working directory.
- A YAML entry has a fixed 5 s `shutdownTimeout` and no `retry`.

## Load from TypeScript

`Remote.plugin` builds the same plugin in code, for `Graft.plugin`:

```ts title="src/entry.ts"
import { Effect } from "effect"

import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

import { contract } from "./contract.ts"

const greeter = Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
	shutdownTimeout: "5 seconds",
})

export const program = Effect.gen(function* () {
	const fork = yield* Graft.plugin(greeter, { greeting: "Hello" })
	yield* fork.await
	yield* fork.update({ greeting: "Hi" })
	yield* fork.await
})
```

The factory fixes deployment options. Pass business config to `Graft.plugin`;
`fork.update` stops the old execution unit and starts a new one with the next
config.

| Option            | Meaning                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `contractModule`  | Where the plugin process imports the contract from. Not the contract's `module`.            |
| `connect`         | As in YAML, plus [credential effects](../transport-auth/#credential-sources).               |
| `shutdownTimeout` | Bound for the graceful stop. Default `5 seconds`.                                           |
| `retry`           | A `Schedule` for restarting the plugin after a failure. Calls themselves are never retried. |

`graft start` provides everything Remote needs. If you build `Graft.layer`
yourself, provide `NodeServices.layer` and `SecureRandom.layerWebCrypto` in its
environment, and optionally the loader's `ModuleResolver` and `ConfigDirectory`.

## Services across the boundary

| Rule                   | Detail                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Provides**           | The implementation publishes these with `Graft.provide`; host plugins inject them as usual.                 |
| **Inject**             | The implementation injects these host services and gets a client that calls the host.                       |
| **Waiting**            | The `remote` entry waits for its `inject` services like any plugin with dependencies.                       |
| **Host withdraws**     | When a host service in `inject` is withdrawn, the remote plugin stops until it returns.                     |
| **Plugin withdraws**   | Host consumers stop. Calls made after the withdrawal fail with `RemoteWithdrawn`.                           |
| **Stopping order**     | Consumers stop before the services are withdrawn, as in [withdrawal](../../services/#how-withdrawal-works). |
| **Broken connections** | Can interrupt calls and finalizers at any point.                                                            |
| **Only declared**      | Services not listed in the contract do not cross.                                                           |

## Errors callers see

Callers and `fork.await` see these:

| Error                        | Meaning                                                                                  | What to do                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A declared error             | The plugin failed with an error in the contract's `error` schema.                        | Handle it like any plugin error.                                                                                                                 |
| `Contract.UndeclaredFailure` | The plugin failed with an undeclared error. `original` holds it.                         | Declare it in `error`, or handle it in the plugin.                                                                                               |
| `RemoteError`                | Remote itself failed. `cause` holds the error; runner errors arrive here too, see below. | Read `cause`.                                                                                                                                    |
| `RemoteWithdrawn`            | The plugin's services were withdrawn while in use.                                       | Normal during stops and restarts.                                                                                                                |
| `MissingInstance`            | A runner connection has neither `connect.instance` nor an entry id.                      | Set `connect.instance`.                                                                                                                          |
| `RemoteEntryError`           | A YAML entry is invalid. `entry`, `directory` and `field` locate it.                     | Fix that `field`: `contract`, `config`, `connect`, `connect.transport`, `connect.auth`, or a runner's `listen[n].transport` or `listen[n].auth`. |

Public errors above are exported from the package root. Defects stay defects.
The following nested tags are diagnostics carried in `RemoteError.cause`:

| Error                        | Meaning                                                                             | What to do                                           |
| ---------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `TransportError`             | The connection failed. `cause` holds the underlying error.                          | Check the network, address and TLS settings.         |
| `CredentialsError`           | Reading the host's credentials failed, such as a missing token file.                | Check the source in `cause`.                         |
| `ProcessExited`              | The plugin process or worker exited unexpectedly, with exit code and stderr.        | Read `stderr` and `statusCause`.                     |
| `CommandExited`              | The `command` program exited, with its code and stderr.                             | Check SSH access and the forced command.             |
| `CapabilityCombinationError` | Transport and authentication do not fit, such as mTLS over `ws`.                    | See [combinations](../transport-auth/#combinations). |
| `PackageError`               | The runner could not find, read or verify the contract package, or `expect` failed. | Install the package under `root`, or fix `expect`.   |
| `SessionAccessDenied`        | The session belongs to another identity.                                            | Give each host its own credentials.                  |
| `StaleSession`               | Another start of the instance won, or the runner no longer knows the session.       | Check for two hosts sharing identity and instance.   |
| `SessionConflict`            | Conflicting requests on one session.                                                | Same as above.                                       |
| `LeaseExpired`               | The lease ran out before the host renewed it.                                       | Check the network, or use a longer `lease`.          |
| `SessionStopped`             | The session is stopping, stopped, or was retired during runner recovery.            | Expected during replacement or recovery.             |
| `TerminationUnconfirmed`     | The runner could not confirm a plugin process exited.                               | Check the runner machine. Replacement waits.         |
| `RunnerClosing`              | The runner is shutting down.                                                        | Wait for it to return.                               |
| `StateDirectoryLocked`       | Another runner owns the state directory, or it cannot be locked.                    | Run one runner per state directory.                  |
| `StateStorageError`          | The runner could not read or write its state.                                       | Check the disk and permissions.                      |
| `ExecutionError`             | The runner could not start, watch or stop a plugin process.                         | Read `detail` and the runner's logs.                 |

## Config changes and hot reload

| You change                                                                 | What happens                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Business config through `fork.update` or YAML                              | The execution unit restarts. Remote never updates in place.                                                                                                  |
| `connect` in YAML                                                          | The old execution unit stops, then the new connection starts.                                                                                                |
| A local/worker contract or implementation file under `graft start --watch` | The matching remote fork restarts with fresh code. Imported contract dependencies are observed too. Rebuild first when the entry points at built JavaScript. |
| A network runner's implementation                                          | The host does not watch it. Install the new code on the runner and restart the entry.                                                                        |

Observation lasts until the entry is removed or disabled, even if importing,
validating or starting it fails. Fixing a known contract, dependency or
implementation file retries the entry. A successful import replaces its old
dependencies. Watcher failures are logged and retried against the previous file
digests, so edits made during recovery still trigger a restart.

Without `--watch`, restart the host after rebuilding its contract.
