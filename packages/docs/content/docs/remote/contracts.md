---
title: Remote contracts
description:
  Define versioned operations and keep their implementations separate.
---

A **contract** describes the protocol shared by units. Select captured code in a
[unit target](../../units/) and connect services with
[bindings](../../bindings/).

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
	Contract.operation(
		"@app/greeter/Greet",
		1,
		Rpc.make("Greet", {
			payload: { name: Schema.String },
			success: Schema.String,
			error: GreetingUnavailable,
		}),
	),
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
	name: "app/greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	provides: [greeter],
})
```

`toHandlers` runs where the service is implemented, and `fromClient` where it is
used. Map `RpcClientError` in `fromClient`, so a broken connection reaches
callers as an error they already handle. `Contract.make` collects the
descriptions into the contract:

| Field      | Meaning                                                               |
| ---------- | --------------------------------------------------------------------- |
| `name`     | The plugin's name.                                                    |
| `config`   | Config schema. Must encode to JSON.                                   |
| `error`    | Schema of the plugin's declared failures. Defaults to `Schema.Never`. |
| `inject`   | Services the implementation uses.                                     |
| `provides` | Services the implementation publishes.                                |

- No schema in a contract may need services to encode or decode.
- Constructors collect pure declarations. Describe validates service keys,
  operation identities and unary call shape before admission. Service keys are
  unique within a contract. RPC names may repeat across services.
- Export the contract as `contract` or as the default export.
- Both sides import the same built contract, so keys and RPC schemas match.

## Operation identities

Each RPC in a service has an immutable `name@version`, assigned with
`Contract.operation`.

| Rule             | Meaning                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name and version | A nonempty name without whitespace and a positive integer version.                                                                                                          |
| Protocol changes | Change the operation version when its schema, encoding, or meaning changes.                                                                                                 |
| Wire tag         | The Effect RPC tag is unchanged; it is not the operation identity.                                                                                                          |
| Service metadata | `service.operations` lists the identities in its RPC group. Unnamed operations and duplicate identities in one service are rejected.                                        |
| Compatibility    | `Contract.compareOperations(required, provided)` checks exact set inclusion. Additional provided operations are allowed. A newer version does not satisfy an older version. |

Comparison is pure metadata inspection. It neither compares schemas nor checks a
running implementation. Package versions and digests are deployment facts, not
operation compatibility.

```ts import.meta.vitest name="contracts: compare operations"
import { Array } from "effect"

import { Contract } from "@graftland/plugin-remote"

import { contract } from "./src/contract.ts"

const required = Array.flatMap(
	contract.provides,
	(service) => service.operations,
)
Contract.compareOperations(required, required) // => ({ _tag: "Compatible" })
Contract.compareOperations(required, []) // => ({ _tag: "Incompatible", missing: [{ name: "@app/greeter/Greet", version: 1 }] })
```

## Declare an implementation

Declare the service descriptors in `Plugin.make({ provides })`, then publish
their values with `Graft.provide` inside `apply`. `overlap: true` declares that
serving is safe alongside another attempt; its default is `false`. Kernel
Overlap requires this declaration. Embedded restart remains cooperative.

```ts title="src/greeter.ts"
import { Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { contract, Greeter } from "./contract.ts"

export default Plugin.make({
	name: "app/greeter",
	config: contract.config,
	provides: contract.provides,
	overlap: true,
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.succeed(`${greeting}, ${name}!`),
		}),
})
```

## Project contract operations

The [MCP projection](../../mcp-server/projection/) exposes explicitly annotated
operations through injected services. `Contract.identity(rpc)` reads an
operation identity without interpreting its schemas. MCP JSON Schema describes
tool input only; it never participates in provenance or compatibility.
