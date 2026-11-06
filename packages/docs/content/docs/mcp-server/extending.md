---
title: MCP extension points
description:
  Write a transport, kind or middleware using public services and events.
---

Every transport, contributor and policy is an ordinary Graft plugin. Helpers
live beside their public tokens: they import no driver and perform no I/O when
imported. This keeps the same API available to third parties.

## Write a transport

A transport injects `Server`, obtains fresh options and builds Effect's server
over its own protocol.

```ts
import { Effect, Layer } from "effect"
import { McpServer } from "effect/ai"
import { RpcServer } from "effect/rpc"

import { Plugin } from "@graftland/graft"
import { Server } from "@graftland/plugin-mcp-server/Server"

declare const protocol: Layer.Layer<RpcServer.Protocol>

export default Plugin.make({
	name: "@acme/graft-plugin-mcp-transport",
	inject: [Server],
	apply: Effect.fnUntraced(function* () {
		const options = yield* (yield* Server).options
		yield* Layer.build(McpServer.layer(options).pipe(Layer.provide(protocol)))
	}),
})
```

`Server.options` captures the core's context and snapshots extensions on each
call. Build its `registrations` in the transport's scope. Its projection,
notifications and conflict logs then belong to that transport. Withdrawing
`Server` stops its consumers through normal Graft dependency handling.

## Write a kind

A **kind** maps an item to one of MCP's existing lists. Its key labels offers;
it is not a realm key.

```ts
import { Context, Effect } from "effect"
import { McpSchema, McpServer } from "effect/ai"

import * as Catalog from "@graftland/plugin-mcp-server/Catalog"

type Item = Parameters<McpServer.McpServer["Service"]["addTool"]>[0]

export const kind: Catalog.Kind<Item> = {
	key: "@acme/graft-plugin-proxy/Tools/kind",
	list: "tools",
	identities: (item) => [item.tool.name],
	install: (item, annotations) =>
		McpServer.McpServer.use((server) =>
			server.addTool({
				...item,
				annotations: Catalog.enabledWhen(annotations, item.annotations),
			}),
		),
}

export const offer = Effect.fnUntraced(function* (
	tool: McpSchema.Tool,
	forward: Item["handle"],
) {
	const handle = yield* Catalog.own(forward)
	yield* Catalog.offer(kind, { tool, handle, annotations: Context.empty() })
})
```

| Rule                                                                          | Reason                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `install` only registers; it performs no I/O                                  | A catalog emitter awaits every transport                                                   |
| Pass `Catalog.enabledWhen(annotations, ownAnnotations)` to every registration | Withdrawal and conflicts hide old registrations; the item's predicate is combined with AND |
| Report completion argument names with `completions`                           | Replacements cannot expose withdrawn completion handlers                                   |
| Use `Catalog.own` for handlers                                                | Cancellation interrupts and awaits work in the contributor's lifetime                      |
| Identities are unique within a list, across kinds                             | A custom kind receives no first-party privilege                                            |
| Use `Catalog.advertise` for a prepared offer                                  | It answers `Offered` and emits `Changed` on start and after withdrawal                     |

A kind can compose tools, resources and prompts. Adding JSON-RPC methods
requires an upstream Effect API.

Catalog emitters wait for every transport's synchronization. Cancelling an
emitter leaves that work owned by the transport; unloading the transport
interrupts collection, installation and notification delivery. A `Changed`
emitted inside collection or installation schedules a coalesced follow-up pass
without waiting on itself.

## Write middleware

```ts
import { Effect, Ref } from "effect"
import { McpSchema } from "effect/ai"

import { Event, Plugin } from "@graftland/graft"
import * as Middleware from "@graftland/plugin-mcp-server/Middleware"

export default Plugin.make({
	name: "@acme/graft-plugin-mcp-call-budget",
	apply: () =>
		Effect.gen(function* () {
			const remaining = yield* Ref.make(100)
			yield* Event.on(
				Middleware.Middleware,
				(call, next) =>
					Effect.gen(function* () {
						if (
							call.method === "tools/call" &&
							(yield* Ref.updateAndGet(remaining, (n) => n - 1)) < 0
						) {
							return yield* Effect.fail(
								McpSchema.McpErrorBase.make({
									code: -32000,
									message: "Call budget exhausted",
								}),
							)
						}
						return yield* next(call)
					}),
				{ order: -10 },
			)
		}),
})
```

Lower `order` runs first and outermost. Equal orders use registration order,
with `prepend` first. Use distinct orders when relative order matters across
reloads. `{ global: true }` reaches every realm.

| Hook              | Behavior                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `Middleware`      | Wraps Effect's `MiddlewareMethod` calls, not lists, initialize, discover or listen                 |
| `Visible`         | All handlers must return true; errors fail the request                                             |
| `call.services`   | Request context; add services with `Context.add` before `next`                                     |
| Middleware unload | Interrupts running handlers before or after `next`; skips handlers removed before they are claimed |

Visibility runs before middleware and cannot see services added by it. Read a
transport's per-request principal from `call.services` when implementing
per-user lists. Middleware handlers run with their own plugin's services. Custom
MCP error codes must be in `-32000..-32019`.

For HTTP, this is `Principal` from `@graftland/plugin-http/Authorization`. Its
verified request value also reaches owned tool handlers and wins over a same-key
plugin service.

## Declare extensions

```ts
import { Plugin } from "@graftland/graft"
import { declare as declareExtensions } from "@graftland/plugin-mcp-server/Extensions"

export default Plugin.make({
	name: "@acme/graft-plugin-mcp-declaration",
	apply: () => declareExtensions({ "com.acme/notes": { version: "1" } }),
})
```

Equal declarations merge; unequal declarations for one key hide that key.
Conflicts and declaration failures are logged once per newly observed state per
transport. A transport keeps its starting snapshot until it restarts. Request
and result `_meta`, registration annotations and visibility remain Effect's
public extension points.

## Testing

`Testing.transport` creates an in-memory transport plugin and a raw JSON-RPC
connection. Load it beside the core. `Testing.transportConformance` checks
discovery identity, configured protocols, a contributed tool, list changes,
resource subscription IDs, cancellation and connection closure.
`Testing.kindConformance` checks lifetime, conflicts, liveness predicates and a
partially failed installation.

| Kit       | Argument                                                  | Purpose                                                                                                                |
| --------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Transport | `expected.name`, `expected.version`, `expected.protocols` | Required expectations for the options the transport serves                                                             |
| Transport | `expected.close`                                          | Core fork's disposal effect; verifies withdrawal disconnects the client. Omit to check input closure in a separate run |
| Transport | `expected.closeTimeout`                                   | Time allowed for closure; defaults to five seconds. A timeout fails the kit with a closure diagnostic                  |
| Kind      | `ownDisabled`                                             | Optional item with its own false predicate                                                                             |
| Kind      | `changed`                                                 | Optional notification-reading effect to check each list change                                                         |

Run the transport kit once with `close` and once without it to check both
dependency withdrawal and input closure. Protocol-layer
[limits](../contributing/#limits) remain Effect's responsibility. See the
generated [API reference](../../reference/plugin-mcp-server/readme/) for exact
types.
