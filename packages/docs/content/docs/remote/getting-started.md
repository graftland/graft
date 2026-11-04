---
title: Getting started
description:
  Move one plugin into a child process, then into a Node worker, without
  changing the plugins that use it.
---

This tutorial moves one plugin out of your application's process: first into a
child process, then into a Node worker. It assumes you can already write a
plugin that [publishes a service](../../services/). The finished code is the
[06 · Remote](https://github.com/graftland/graft/tree/main/samples/06-remote)
sample.

## Where we start

The application has two plugins. `greeter` publishes a `Greeter` service, and
`welcome` injects it:

```ts title="src/welcome.ts"
export default Plugin.make({
	name: "welcome",
	inject: [Greeter],
	apply: () =>
		Effect.gen(function* () {
			const greeter = yield* Greeter
			yield* Effect.log(yield* greeter.greet("Alice"))
		}),
})
```

```yaml title="graft.yml"
- id: greeter
  name: ./src/greeter.ts
  config:
    greeting: Hello

- id: welcome
  name: ./src/welcome.ts
```

The goal is to run `greeter` in another process. `welcome` will not change at
all.

## 1. Split the contract from the implementation

The host must not import the greeter's code, or that code would run in the host
again. So the plugin is split in two:

- The **contract** is everything both sides need to agree on: the plugin's name,
  its config schema, the services that cross the boundary, and where the
  implementation lives. The host imports only this.
- The **implementation** is the plugin as it was. Only the plugin process
  imports it.

A service crosses the boundary as remote procedure calls (RPC). Describe it with
`Contract.service`, which takes the service key, an Effect `RpcGroup` that lists
its calls, and two functions:

- `toHandlers` turns the real service into RPC handlers. It runs where the
  service is implemented.
- `fromClient` turns an RPC client back into the service's interface. It runs
  where the service is used.

```ts title="src/contract.ts"
import { Contract } from "@graftland/plugin-remote"
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export class GreetingUnavailable extends Schema.TaggedError<
	GreetingUnavailable,
	{ readonly brand: unique symbol }
>()("GreetingUnavailable", { cause: Schema.Defect() }) {}

export class Greeter extends Context.Service<
	Greeter,
	{
		readonly greet: (name: string) => Effect.Effect<string, GreetingUnavailable>
	}
>()("@graftland/sample-remote/contract/Greeter") {}

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

export const config = Schema.Struct({ greeting: Schema.String })

export const contract = Contract.make({
	name: "greeter",
	config,
	module: new URL("./greeter.js", import.meta.url).href,
	provides: [greeter],
})
```

A few things to note:

- `fromClient` maps `RpcClientError` into the service's own error. That is how a
  broken connection shows up to callers: as a `GreetingUnavailable`, which they
  already handle.
- `module` points to the **built** implementation next to the built contract.
- `provides` lists the services the implementation publishes to the host.
- Export the contract as `contract` or as the default export.

The contract has rules because both sides decode it independently:

- The config schema must encode to JSON, and no schema in the contract may need
  services to encode or decode.
- Service keys must be unique within a contract. RPC method names may repeat
  across different services.
- Only declared services cross the boundary. The keys and RPC schemas must match
  on both sides, which is why both import the same contract.

## 2. Point the implementation at the contract

The implementation is unchanged, except that it imports the config schema and
the service key from the contract:

```ts title="src/greeter.ts"
import { Graft, Plugin } from "@graftland/graft"
import { Effect } from "effect"
import { config, Greeter } from "./contract.ts"

export default Plugin.make({
	name: "greeter",
	config,
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.succeed(`${greeting}, ${name}!`),
		}),
})
```

## 3. Build to JavaScript

The plugin process does not use the host's TypeScript loader. It imports plain
JavaScript, so build the contract and the implementation first. The sample uses
tsdown:

```ts title="tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	entry: ["src/contract.ts", "src/greeter.ts"],
	format: "esm",
	platform: "node",
	fixedExtension: false,
	dts: false,
	deps: { neverBundle: true },
})
```

This writes `dist/contract.js` and `dist/greeter.js`. Rebuild whenever either
changes.

## 4. Load it with `name: remote`

Replace the `greeter` entry, and only that entry:

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect:
      local: {}
    config:
      greeting: Hello

- id: welcome
  name: ./src/welcome.ts
```

| Field      | Meaning                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `contract` | The built contract: a path relative to this config file, or a package name such as `my-plugin/contract`. |
| `connect`  | Where to run the plugin. `local: {}` starts a child process.                                             |
| `config`   | The plugin's own configuration. It is checked against the contract's schema before anything starts.      |

`name: remote` loads the `@graftland/plugin-remote` package, so install it in
the application. Then start the application:

```sh
graft start
```

The log shows `Hello, Alice!`, now produced in a child process.

## 5. Switch to a worker

Change only `connect`:

```yaml
connect:
  worker: {}
```

The greeting now comes from a Node worker inside the host process. A worker
isolates execution on its own thread, but it shares the host's process and its
permissions. Pass Node options to the worker with `worker: { execArgv: [...] }`,
or run the child process with a different command with
`local: { command: [node, /path/to/bin.js] }`.

## What changed, and what did not

These stay the same:

- `welcome` and every other plugin that uses `Greeter`.
- The `Greeter` interface and how callers handle its errors.
- The plugin's lifecycle: stopping the entry stops the plugin process, and
  restarting the entry starts a new one.

These are different now:

- **Calls cross a connection.** Arguments and results are encoded with the RPC
  schemas. A call that fails because the connection broke is not retried.
- **A config change restarts the plugin.** Editing `greeting` stops the plugin
  process and starts a new one. A remote plugin is never
  [updated in place](../../plugins/#update-in-place).
- **Contract changes need a restart.** After editing the contract, rebuild and
  restart the host. The contract does not take part in
  [hot reload](../../hot-reload/). Editing the inner `config` or `connect` while
  the host runs is fine.
- **Errors are wrapped.** Failures from the plugin reach the host as described
  in [Errors callers see](#errors-callers-see).

## Services in the other direction

`provides` sends services from the plugin process to the host. `inject` does the
opposite: it lists host services that the implementation needs.

```ts
export const contract = Contract.make({
	name: "report",
	config,
	module: new URL("./report.js", import.meta.url).href,
	inject: [database],
	provides: [reports],
})
```

Here `database` is a `Contract.service(Database, ...)` description. The
implementation injects `Database` as usual and gets a client that calls the
host. On the host, the remote entry waits until `Database` is available, like
any plugin with a dependency. If the host withdraws `Database`, the remote
plugin stops until it comes back.

## Load it from TypeScript

Instead of a YAML entry, you can build the plugin in code with `Remote.plugin`
and load it with `Graft.plugin`:

```ts title="src/entry.ts"
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
	config: { greeting: "Hello" },
	shutdownTimeout: "5 seconds",
})
```

- `contractModule` tells the plugin process where to import the contract from.
  It is different from the contract's own `module`, which points to the
  implementation.
- `connect` and `config` take the same data as the YAML entry.
- `shutdownTimeout` and `retry` are only available here. A YAML entry always
  uses the default five-second shutdown timeout and has no `retry` schedule.

The `graft` command provides everything Remote needs. If you build `Graft.layer`
yourself, provide `NodeServices.layer` and `SecureRandom.layerWebCrypto` in the
same environment. You may also provide the loader's `ModuleResolver` and
`ConfigDirectory` there.

## Errors callers see

Failures of the remote plugin reach the host in a few shapes:

| You see                      | It means                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| An error from `error`        | The plugin failed with an error the contract declares. Add an `error` schema to declare some.   |
| `Contract.UndeclaredFailure` | The plugin failed with something the contract does not declare. `original` holds it.            |
| `RemoteError`                | Remote itself failed: the process exited, the connection broke, a runner refused. Read `cause`. |
| `RemoteWithdrawn`            | The plugin's services were withdrawn while you were using them.                                 |

Defects stay defects. The [reference](../reference/#errors) lists every error
and what to do about it.

## Next

- Run the plugin on another machine:
  [Run plugins on another machine](../runners/).
- Learn what happens on restarts and shutdowns:
  [Restarts, replacements and stopping](../restarts/).
