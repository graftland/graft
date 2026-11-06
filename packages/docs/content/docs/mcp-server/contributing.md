---
title: MCP contributions
description: Offer tools, resources and prompts with plugin-owned handlers.
---

A **contribution** belongs to a plugin. Its handlers use the plugin's services,
realm and log annotations. Request services and services added by middleware
take precedence when they differ from the transport's base context.

## Offer tools

```ts
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

import * as Tools from "@graftland/plugin-mcp-server/Tools"

const Echo = Toolkit.make(
	Tool.make("echo", {
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
	}),
)

export default Tools.plugin({
	name: "@acme/graft-plugin-echo",
	toolkit: Echo,
	handlers: Effect.succeed(
		Echo.of({ echo: ({ text }) => Effect.succeed(text) }),
	),
})
```

Use `inject` for services required by the plugin and declare tool dependencies
through Effect's `Tool`. `Tools.plugin` rejects undeclared service requirements.
Inside an existing plugin, use `Tools.offer(toolkit, handlers)` instead. A
conflicting name hides the entire toolkit, including its otherwise unique tools.

## Offer resources and prompts

```ts
import { Effect, Schema } from "effect"
import { McpSchema } from "effect/ai"

import { Plugin } from "@graftland/graft"
import * as Prompts from "@graftland/plugin-mcp-server/Prompts"
import * as Resources from "@graftland/plugin-mcp-server/Resources"

export default Plugin.make({
	name: "@acme/graft-plugin-notes",
	apply: () =>
		Effect.gen(function* () {
			yield* Resources.offer({
				name: "Notes",
				uri: "notes://index",
				content: Effect.succeed("One note"),
			})
			const greeting =
				yield* Resources.template`greeting://${McpSchema.param("name", Schema.String)}`(
					{
						name: "Greeting",
						content: (_uri, name) => Effect.succeed("Hello " + name),
						completion: { name: () => Effect.succeed(["Ada", "Grace"]) },
					},
				)
			yield* Resources.offer(greeting)
			yield* Prompts.offer({
				name: "greet",
				parameters: { name: Schema.String },
				content: ({ name }) => Effect.succeed("Greet " + name),
				completion: { name: () => Effect.succeed(["Ada", "Grace"]) },
			})
		}),
})
```

| Contribution      | Input                                                             | Identity     |
| ----------------- | ----------------------------------------------------------------- | ------------ |
| Static resource   | Effect `registerResource` options                                 | URI          |
| Resource template | `Resources.template` with Effect schemas and registration options | URI template |
| Prompt            | Effect `registerPrompt` options, including `completion`           | Name         |

Resource templates and prompts own their completion handlers. A withdrawn static
resource or template no longer shadows a live overlapping template.
`Resources.updated(uri)` notifies listeners in its realm. Call it after changing
the content; offering a resource does not monitor its contents.

## Use the client's capabilities

Handlers call Effect directly; there is no Graft `Client` wrapper.

| Need                                           | Public Effect API                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Client capabilities                            | `McpServer.clientCapabilities`                                                                 |
| Request `_meta`, progress token and MRTR input | `McpSchema.McpRequestContext`                                                                  |
| Legacy form elicitation                        | `McpServer.elicit`                                                                             |
| URL elicitation, sampling, roots               | `(yield* (yield* McpSchema.McpServerClient).getClient).elicit`, `.createMessage`, `.listRoots` |
| URL elicitation completion                     | `(yield* McpServer.McpServer).notifyElicitationComplete`                                       |
| Protocol logs and progress                     | `(yield* McpServer.McpServer).notifications`                                                   |
| Low-level MRTR                                 | Effect `addTool` or `addPrompt` through a custom [kind](../extending/)                         |

Read `requestMetadata.progressToken` for the individual request, including
legacy requests. Send progress only when that token exists. Protocol logging is
separate from `Effect.log*`, which stays on stderr under the CLI. Effect handles
capability negotiation and protocol-specific delivery.

## Limits

These rows are not implemented in Graft; they require upstream changes to
`effect/ai` or its RPC layer.

| Limit                                                    | Effect boundary                                                                                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolkit tool icons                                       | `registerToolkit` does not carry icons                                                                                                                          |
| Toolkit MRTR                                             | Toolkit handlers cannot return `InputRequired`                                                                                                                  |
| Resource MRTR                                            | `addResource` cannot return `InputRequired`                                                                                                                     |
| Sealed or single-use `requestState`                      | State passes through without integrity protection                                                                                                               |
| Deterministic list sorting after reload                  | Effect retains registration order                                                                                                                               |
| Server `title`                                           | Not accepted by server options                                                                                                                                  |
| Modern-only `initialize` error details                   | `-32022` omits `data.supported` on this path                                                                                                                    |
| Malformed JSON normalization                             | Stdio and socket protocols do not return `-32700` with `id: null`                                                                                               |
| Custom-transport control messages and batch policy       | Stock RPC serialization is not an exported MCP wire codec                                                                                                       |
| Socket EOF session cleanup                               | Socket protocols report disconnects without synthesizing `Eof`                                                                                                  |
| Error-data sanitization                                  | RPC errors may contain Effect causes                                                                                                                            |
| Trace-context propagation                                | No MCP `traceparent`, `tracestate` or `baggage` integration                                                                                                     |
| Handler-triggered capability error                       | No public helper to require a capability with `-32021`                                                                                                          |
| Dynamic extension capabilities and custom methods        | Declarations are snapshots; there is no method-registration hook                                                                                                |
| Progress monotonicity and rate limits                    | No public MCP enforcement API                                                                                                                                   |
| Guaranteed final listen result during transport teardown | Scope shutdown may disconnect without a final result                                                                                                            |
| Completion predicates                                    | Effect completion lookup does not evaluate an item's own `EnabledWhen`; withdrawal is still enforced                                                            |
| Legacy HTTP GET                                          | Returns 405; no standalone SSE stream                                                                                                                           |
| Legacy HTTP resumption                                   | Event replay and resumption are not implemented                                                                                                                 |
| Legacy HTTP notifications                                | Delivered only over open POST response streams                                                                                                                  |
| HTTP proxy buffering                                     | Effect does not emit `X-Accel-Buffering: no`                                                                                                                    |
| HTTP session lifetime                                    | No session expiry; repeated initialize requests on an unprotected endpoint can allocate unbounded session state. Clients can release their session with DELETE. |
| Toolkit `x-mcp-header` annotations                       | Ordinary custom Schema annotations are omitted by `registerToolkit`; low-level tool input schemas work                                                          |

Tasks, MCP Apps, Skills, Server Cards and `capabilities.experimental` are out of
scope. Graft ships no MCP extension implementations.
