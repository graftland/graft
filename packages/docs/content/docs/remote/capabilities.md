---
title: Write your own transport or authentication
description:
  Build a plugin that connects, listens, supplies credentials or authenticates
  in a way the built-in options do not cover, and test it with the shared
  checks.
---

This page is for plugin authors who need a connection or authentication method
that Remote does not ship, such as a different network protocol or credentials
from a company identity service. It explains the idea, shows minimal working
examples and how to test them. Exact signatures are in the API reference for
[`Transport`](../../reference/plugin-remote/transport/readme/) and
[`Auth`](../../reference/plugin-remote/auth/readme/).

## The idea

Every built-in option, such as `url`, `unix`, `bearer` or `mtls`, is a shorthand
for an ordinary Graft plugin. Remote calls these plugins **capabilities**. Each
capability publishes exactly one of four services:

| Service         | Side   | Job                                                                      | Module                               |
| --------------- | ------ | ------------------------------------------------------------------------ | ------------------------------------ |
| `Connector`     | Host   | Opens a byte channel to a runner.                                        | `@graftland/plugin-remote/Transport` |
| `Credentials`   | Host   | Reads what the host presents: nothing, a header value, or a certificate. | `@graftland/plugin-remote/Auth`      |
| `Listener`      | Runner | Accepts byte channels from hosts.                                        | `@graftland/plugin-remote/Transport` |
| `Authenticator` | Runner | Turns what a host presented into an identity.                            | `@graftland/plugin-remote/Auth`      |

These modules contain only the service definitions, no Node implementations.

To use your own capability, name its module instead of a shorthand. On the host:

```yaml
connect:
  transport:
    name: my-remote-connector
    config: { address: example }
  auth:
    name: my-remote-credentials
    config: { account: billing }
```

On the runner, the same `transport` and `auth` keys go in a `listen` element and
name a listener and an authenticator. Names are resolved like any other
[plugin name](../../config-file/#plugin-names).

You do not load capabilities yourself, and you never pick service keys. Remote
starts each capability privately for the entry that names it. Two entries can
use the same capability with different configuration without colliding, and your
capability can still inject the application's ordinary services.

## Rules every capability follows

- **Default export.** The module exports the plugin as its default export.
- **Config through a schema.** Decode `config` with the plugin's `config`
  schema.
- **I/O on activation.** Do the work in `apply`, never when the module is
  imported.
- **Relative paths.** Resolve file paths in your config against the loader's
  `ConfigDirectory`, like the built-in capabilities, so they are relative to the
  config file.
- **Publish the service.** A capability that becomes active without publishing
  its service fails with `CapabilityContractError`. One that waits for a missing
  application service simply stays `Pending`.
- **Keep causes.** Report transport failures as `TransportError` and credential
  failures as `CredentialsError`, with the original failure in `cause`.
- **Never log secrets.** Do not log Authorization values.

Capability code is trusted like any other plugin, including what it declares
about itself.

## Describing a transport

Connectors and listeners declare four **properties**. Remote uses them to reject
unsafe combinations and to decide which warnings to log:

| Property    | Meaning                                                                   | What Remote does with it                                                                                                                                |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`  | A short name, such as `wss` or `unix`.                                    | mTLS requires `wss`. `stdio` must be a runner's only listener. `stdio` and `command` reject any explicit `auth`.                                        |
| `encrypted` | Whether the transport keeps traffic confidential.                         | mTLS requires `true`. Unencrypted network transports log warnings.                                                                                      |
| `network`   | Whether it is reachable over a network rather than locally.               | Unencrypted or unauthenticated network transports log the warnings in [Choose transport and authentication](../transport-auth/#what-the-warnings-mean). |
| `carries`   | Which evidence the handshake can carry: `header`, `certificate`, or both. | Header-based auth (bearer, JWT) requires `header`. mTLS requires `certificate`.                                                                         |

These are declarations, not proofs: Remote believes them.

A **channel** carries ordered, reliable bytes in both directions. Chunk
boundaries have no meaning, and the end of a channel does not prove that the
plugin process exited.

## How a listener runs

Remote drives a listener in a fixed order:

1. It takes the TLS policy from the authenticator (only mTLS has one) and calls
   `bind`. TLS settings, including requesting client certificates, come from
   this policy, not from a step after the connection opens.
2. It calls `serve` with an `accept` function, and waits for `ready` while
   watching for `serve` to fail. `ready` means the accept loop is running, not
   just that an address is bound. A runner starts only when all its listeners
   are ready. A listener that fails later affects only itself.
3. For each incoming connection, the listener calls `accept` with what the host
   presented, **before** it accepts an HTTP upgrade. If `accept` fails with
   `AuthenticationFailed`, an HTTP listener answers 401 and sends the error's
   `challenge` as `WWW-Authenticate`. If it succeeds, the listener runs the
   returned session with the channel. Remote attaches the authenticated identity
   itself.

Own every session fiber and its resources in a scope. A `stdio`-style listener
finishes `serve` at end of input; a network listener keeps accepting until it is
interrupted.

`AuthenticationFailed` has a `reason` of `"missing"` or `"invalid"`. The
built-in bearer and JWT authenticators use the challenges `Bearer` (missing) and
`Bearer error="invalid_token"` (invalid). An authenticator returns a stable
identity, not a session id. Only issuer-based authenticators declare an
`issuer`, and a runner rejects listeners with different issuers.

WebSocket adapters have extra duties: reject text messages, enforce the frame
size limit, accept exactly one complete protocol frame per binary message, and
reassemble output that arrives in several chunks. The built-in adapters already
do this.

## Minimal examples

An authenticator for a trusted local channel can hand out one configured
identity. Like `none`, it checks nothing:

```ts title="authenticator.ts"
import { Graft, Plugin } from "@graftland/graft"
import { Authenticator } from "@graftland/plugin-remote/Auth"
import { Schema } from "effect"

export default Plugin.make({
	name: "fixed-local-identity",
	config: Schema.Struct({ identity: Schema.NonEmptyString }),
	apply: ({ identity }) =>
		Graft.provide(Authenticator, { _tag: "None", identity }),
})
```

A connector can adapt a channel your application already has. Here an
application service `Link` opens the channel, and its resources belong to the
connection's scope:

```ts title="connector.ts"
import { Graft, Plugin } from "@graftland/graft"
import { Connector, type Channel } from "@graftland/plugin-remote/Transport"
import type { TransportError } from "@graftland/plugin-remote/Errors"
import { Context, Effect, type Scope } from "effect"

export class Link extends Context.Service<
	Link,
	{
		readonly open: Effect.Effect<Channel, TransportError, Scope.Scope>
	}
>()("example/Link") {}

export default Plugin.make({
	name: "application-link",
	inject: [Link],
	apply: Effect.fnUntraced(function* () {
		const link = yield* Link
		yield* Graft.provide(Connector, {
			properties: {
				protocol: "application",
				encrypted: false,
				network: false,
				carries: [],
			},
			connect: () => link.open,
		})
	}),
})
```

Because `carries` is empty, this connector supports only `none`. Remote rejects
header and certificate credentials before it ever calls `connect`.

Credentials are read once per connection, with the declared kind: `None`,
`Authorization` (a header value) or `Certificate`.

## Test it with the shared checks

`@graftland/plugin-remote/Testing` contains the checks the built-in capabilities
pass. It does not depend on any test runner, and it does not need a full runner
either.

`Testing.transport(plugins, fixture)` takes your four capability plugins
(`connector`, `listener`, `credentials`, `authenticator`) and a fixture. The
fixture starts them for real in Graft, together with a consumer, and returns a
channel connected to an echo session. Configuration, addresses and platform
layers belong in the fixture. You get two checks back:

```ts
import * as Testing from "@graftland/plugin-remote/Testing"

const checks = Testing.transport(plugins, openEchoSession)

it.live("preserves bytes", () =>
	checks.chunks.pipe(Effect.scoped, Effect.provide(runtime)),
)
it.live("closes cleanly", () =>
	checks.eof.pipe(Effect.scoped, Effect.provide(runtime)),
)
```

- `chunks` splits a frame header across chunks and merges the rest with the next
  frame, then checks that the bytes come back in order.
- `eof` checks that closing the channel ends it cleanly.
- `Testing.rejection(httpResponse, challenge?)` checks that rejected credentials
  get a 401, no WebSocket upgrade, and the expected challenge.

Failed checks fail with `ConformanceError`. Also test what the shared checks do
not cover: wrong credentials, preserved causes, scope cancellation, TLS settings
applied at `bind`, `serve` failing before `ready`, and two differently
configured copies of your capability running at once. The
[built-in test fixtures](https://github.com/graftland/graft/blob/main/packages/plugin-remote/test/capabilities.test.ts)
show all of this for WebSocket with mTLS and every other built-in combination.

## Built-in capability modules

The shorthands expand to these modules under `@graftland/plugin-remote/`. The
two execution modules back `local` and `worker`; the others are ordinary
capabilities.

| Role                  | Modules                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| Host execution        | `host/local`, `host/worker`                                                     |
| Host connectors       | `host/websocket`, `host/unix`, `host/command`                                   |
| Host credentials      | `host/auth/mtls`, `host/auth/bearer`, `host/auth/jwt`, `host/auth/none`         |
| Runner listeners      | `runner/websocket`, `runner/unix`, `runner/stdio`                               |
| Runner authenticators | `runner/auth/mtls`, `runner/auth/bearer`, `runner/auth/jwt`, `runner/auth/none` |

The [reference](../reference/#published-modules) lists every published module.
