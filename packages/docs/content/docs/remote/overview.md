---
title: Remote
description:
  Run one plugin in a child process, a Node worker or on another machine.
---

Remote runs a plugin's code outside the application's process: in a child
process, in a Node worker, or on a **runner**, a service on another machine that
starts plugins for hosts. The application, the **host**, still sees the plugin's
[services](../../services/), and the plugins that inject them do not change.

|                    | Direct: `local`, `worker`               | Runner                                                        |
| ------------------ | --------------------------------------- | ------------------------------------------------------------- |
| Where it runs      | A child process or a worker on the host | A process the runner starts, usually on another machine       |
| What you install   | Nothing beyond the built plugin         | The plugin package and `graft start runner.yml` on the runner |
| Connection         | Private to the host                     | `ws`/`wss`, a Unix socket, or a command such as SSH           |
| Authentication     | None                                    | mTLS, a bearer token, a JWT, or the command's own             |
| Replacing a plugin | Each start is a fresh process           | The old process must exit first; each start is a generation   |

Each loaded `remote` entry has its own plugin process. Stopping the entry stops
it, and restarting the entry replaces it. Moving a plugin has limits:

- **It isolates execution, not permissions.** A child process runs as your user,
  a worker shares the host's process, and a runner starts plugins with its own
  account's permissions. For a permission boundary, run the runner in a
  container or a VM. To limit what plugins see inside one process, use
  [realms](../../isolation/).
- **Config must encode as JSON.** The plugin process decodes it on its own.
- **Calls cross a connection.** Each call is a message, and a call that fails
  because the connection broke is not retried. See
  [what a Remote boundary costs](../../best-practices/production/#what-a-remote-boundary-costs).

## Move a plugin

A plugin that runs elsewhere is split in two. The **contract** names the plugin,
its config schema and the services that cross the boundary; both sides import
it. The **implementation** is the plugin itself, built to JavaScript; only the
plugin process imports it.

```ts title="src/contract.ts"
import { Context, Effect, Schema } from "effect"

import { Contract } from "@graftland/plugin-remote"

export class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<string> }
>()("app/Greeter") {}

declare const greeter: Contract.Service

export const config = Schema.Struct({ greeting: Schema.String })

export const contract = Contract.make({
	name: "app/greeter",
	config,
	provides: [greeter],
})
```

```ts title="src/greeter.ts"
import { Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { config, contract, Greeter } from "./contract.ts"

export default Plugin.make({
	name: "app/greeter",
	config,
	provides: contract.provides,
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.succeed(`${greeting}, ${name}!`),
		}),
})
```

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    implementation: ./dist/greeter.js
    connect:
      local: {}
    config:
      greeting: Hello
```

`greeter` describes how `Greeter` crosses the boundary; see
[Define a contract](../contracts/). Change `local: {}` to `worker: {}`, or to a
runner's address, to move the plugin again. The
[06 · Remote](https://github.com/graftland/graft/tree/main/samples/06-remote)
sample walks through all three.
