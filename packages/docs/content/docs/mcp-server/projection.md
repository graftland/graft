---
title: Contract tools
description:
  Project annotated contract operations into MCP tools without changing the
  contract.
---

A **projection** exposes selected contract operations through the existing
[tool catalog](../contributing/). The contract remains an Effect value.

- Local services and managed Remote facades use the same binding.
- Every tool declares its metadata and output handling explicitly.
- Updating a view keeps transports and already admitted calls alive.

## Declare a tool

```ts
import { Context, Effect, Schema } from "effect"
import { Rpc } from "effect/rpc"

import { Plugin } from "@graftland/graft"
import * as Projection from "@graftland/plugin-mcp-server/Projection"
import { Contract } from "@graftland/plugin-remote"

class Forecast extends Context.Service<
	Forecast,
	{
		readonly get: (city: string) => Effect.Effect<string>
	}
>()("example/Forecast") {}

const Get = Contract.operation(
	"example/forecast/Get",
	1,
	Rpc.make("Get", {
		payload: { city: Schema.String },
		success: Schema.String,
	}),
).annotate(Projection.Annotation, {
	name: "forecast",
	title: "City forecast",
	description: "Read a city forecast",
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
	output: "json",
})

export default Plugin.make({
	name: "forecast-tools",
	inject: [Forecast],
	apply: () =>
		Projection.offer("forecast-tools", [
			Projection.operation(Forecast, Get, (forecast, { city }) =>
				forecast.get(city),
			),
		]).pipe(Effect.asVoid),
})
```

Use the service key and RPC exported by your contract package. The invocation
uses the contributor's injected service; managed deployments therefore call
through the fork-owned facade. Annotations may live in the contract package or
in the host's explicitly declared MCP view.

| Declaration                    | Rule                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `name`, `title`, `description` | All required. Tool names use 1–128 letters, digits, underscores, dots or hyphens.                       |
| Four hints                     | All required; copied to MCP annotations without inference.                                              |
| `output: "json"`               | Encode the success value with the portable codec and return `{ value }` as structured content and text. |
| `output: "void"`               | Discard the success value.                                                                              |
| Service and operation          | Each pair appears once in a view; tool names are unique within it.                                      |

## Payloads and failures

Input schemas use JSON Schema **2020-12**, MCP's default dialect, generated from
the operation payload's portable codec. This is an external client view only; it
never enters contract identity, provenance or compatibility checks. Runtime
Effect decoding remains authoritative.

`ProjectionError` names the service, operation and reason. Missing identities or
annotations, streaming, RPC middleware, recursive or opaque payloads, and
schemas without an object root are rejected before publication. Schemas must
need no additional decoding or encoding services. These are projection limits,
not contract restrictions; ordinary contract operations remain valid outside
MCP.

| Result                                     | MCP behavior                                                    |
| ------------------------------------------ | --------------------------------------------------------------- |
| Invalid tool arguments                     | Invalid-input `isError` result; the service is not invoked.     |
| Declared business error                    | `isError` with `kind: "business"` and the portable error value. |
| System failure, undeclared error or defect | Scrubbed `isError` with `kind: "system"`.                       |
| Output encoding failure                    | Scrubbed system result.                                         |
| Cancellation                               | Interrupt the owned call and wait for its cleanup.              |
| Malformed protocol request                 | MCP protocol error.                                             |

Full failure causes are logged with the service key and operation identity,
including encoding failures. Business error values are intentionally exposed; do
not put credentials in those values.

Cancellation takes precedence for caller cancellation and contributor disposal,
even when invocation or encoder cleanup also fails. The complete mixed cause is
logged; it never becomes a business or system tool result. Server-initiated
cancellation reaches clients as a protocol error.

## Publish a changed view

`Projection.offer` returns a controller. Use `controller.update` for a host-only
view edit. Use `controller.updateAfter(action, bindings, accepted)` when the
view belongs to a deployment change: pass `Change.run` or a release apply as the
action, and accept only its `Accepted` outcome. The new view is validated before
the action starts. The action and subsequent publication belong to the
contributor scope, so cancelling the caller does not lose an accepted update.

Concurrent controller actions fail with `ProjectionError` before their action
starts; nothing is queued. The registration and its history record publish
atomically.

The host must supply the new annotated view. Changing worker code or a release
alone does not import new annotations into the host. Failed actions retain the
old view. Removing the contributor cancels its owned work and withdraws its
tools before notifying connected clients of the list change.

Publication emits `notifications/tools/list_changed` to supported MCP sessions.
`Projection.Changed` records the revision and before/after metadata, including
service keys and operation identities. `controller.history` retains the latest
32 revisions; persist the event in the application if a durable audit is needed.
Notifications and records do not grant approval or implement re-approval.

The
[integration gateway sample](https://github.com/graftland/graft/tree/main/samples/integration-gateway)
uses an independent MCP client to check listing, calls, description
notifications and an admitted v1 call across an accepted v2 transition without
reconnecting.

Publish changed views over stdio or a transport with notification subscriptions.
Effect 4.1.2’s legacy Streamable HTTP adapter does not provide an idle GET event
stream (`405`); unsolicited list-change delivery on that path is not
implemented. Clients on that path can still list and call tools without
reconnecting. Tracked upstream in
[Effect #10436](https://github.com/Effect-TS/effect/issues/10436).

## Operator approval

For governed entries, projection metadata becomes part of the exact
[approval statement](../../trust/). Publishing changed metadata blocks new calls
until reapproval, including calls from clients with cached tool lists. A
list-change notification is not approval; already admitted calls retain their
serving attempt.

The projection validates its MCP fields and publishes them with the `mcp/tools`
tag for approval. Withdrawing a contributor removes its live tools but preserves
these approval facts. Remounting identical metadata needs no new approval;
publishing different metadata blocks admission before exposing the change.

Pass a stable name to `Projection.offer`, such as `"public/forecast-tools"`.
Each name identifies one logical view in this Graft runtime. Duplicate live
owners fail with `ProjectionConflict`; disposal releases ownership while
retaining the latest approval facts. Updates replace only that view's facts.
Reverting its metadata restores a matching approval. The release audit journal
keeps revisions; the live statement keeps only the latest values. See
[trust and isolation](../../trust/) for audit and revocation rules.
