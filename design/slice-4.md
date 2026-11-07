# Slice 4: annotated contract operations as MCP tools

Add a public `Projection` module to `@graftland/plugin-mcp-server`. It projects
existing Effect RPC values into the existing Tools catalog. It neither replaces
the contract nor adds a serialized contract model. Local services and managed
Remote facades use the same public service-key and invocation binding.

## Declaration and limits

Authors annotate each selected RPC with an explicit tool name, title,
description, all four MCP side-effect hints, and an output policy. `json`
returns the portable success value inside `{ value }`; `void` discards it.
Selected operations without identities or complete annotations fail with a
diagnostic containing the service key, operation, and reason. Duplicate names,
streaming, RPC middleware, opaque/non-JSON payloads and unsupported object-root
schemas are rejected before publication. These are projection limits, never
contract or provenance rules.

Generate JSON Schema 2020-12 from the payload's portable codec for MCP discovery
only. Effect decoding remains authoritative. No schema hash, provenance input,
compatibility comparison, or lossless-document claim is introduced.

## Calls and changes

A contributor binds an operation to its injected service, so Remote calls go
through the fork-owned facade and retain its per-call admission semantics.
Catalog handlers and updates belong to the contributor scope. Metadata updates
must not cancel calls already running or restart transports.

The projection controller validates an entire replacement view before changing
the catalog. The host publishes that view after an accepted transition or
release; no implementation metadata is inferred across the process boundary.
Provide an owned update-after-action helper so caller cancellation cannot lose
publication after an accepted action. Concurrent view actions fail without
queuing; registration and history publish atomically. Rejected actions retain
the previous view. Publish `Projection.Changed` events with before/after
annotations and revision, retain the latest 32 records, and use existing catalog
notifications to emit `notifications/tools/list_changed`. Applications can
persist those events for slice 5. No approval policy is implemented here.

## Failure mapping

Malformed tool arguments produce MCP invalid-input tool results; malformed
protocol requests remain protocol errors. Declared business failures produce
`isError` tool results with portable error data. Undeclared failures,
transport/system failures and defects produce scrubbed `isError` results. Log
complete causes with the service and operation. Interruption keeps its
cancellation semantics. Output encoding failures are system failures.

## Proof and delivery

Test local invocation, input encoding, rejection diagnostics, every failure
mapping, cancellation, update validation and change records. Extend the packed
WebSocket gateway sample with a Streamable HTTP MCP endpoint and an independent
MCP SDK client: list and call the forecast tool, upgrade v1 to v2 without
reconnecting, retain an old admitted call, observe changed descriptions and
annotations, and reject broken declarations. Update MCP guides and the contract
projection link in English, Simplified Chinese and Traditional Chinese.

Run formatting, typecheck, all tests, build, packed-gateway and packed-ecosystem
through `devenv shell --`. Historical release replay remains byte/metadata-only;
only the selected release receives executable publication inspection.

## Transport decision

The independent SDK proof uses stdio for `tools/list_changed`; it also exercises
listing, calls and transitions on Streamable HTTP. Effect 4.1.2's legacy HTTP
adapter returns 405 for the idle GET event stream. Idle push on that adapter is
not implemented here; use stdio or a notification subscription transport. No
private Effect code or alternate HTTP notification state machine is added.

Upstream request:
[Effect #10436](https://github.com/Effect-TS/effect/issues/10436).
