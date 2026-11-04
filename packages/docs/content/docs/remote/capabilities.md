---
title: Write capability plugins
description:
  Use this page to implement a connector, listener, credentials provider, or
  authenticator.
---

Use this page to implement a connector, listener, credentials provider, or
authenticator. The signatures and shared checks below are the public contract
for third-party plugins.

A capability is an ordinary Graft plugin with a default export. Its `apply`
publishes one agreed service key. Remote resolves `{ name, config }` through the
application's module resolver and starts the provider in a private assembly.
Business services remain visible from the parent realm. You do not choose custom
service keys or install providers beside each remote entry.

```yaml
connect:
  transport:
    name: my-remote-connector
    config: { address: example }
  auth:
    name: my-remote-credentials
    config: { account: billing }
```

Use the same references in a runner's `listen` elements, selecting listener and
authenticator plugins instead. Relative file paths should resolve against the
loader's `ConfigDirectory`. Decode configuration with the plugin's Schema;
perform I/O during activation, not module import.

## Four contracts

`@graftland/plugin-remote/Auth` exports `Credentials` and `Authenticator`.
`@graftland/plugin-remote/Transport` exports `Connector` and `Listener`. These
modules contain only contracts, with no Node listener implementations. The
following signatures omit only service-key declarations and import qualifiers:

```ts
interface ClientCertificate {
	cert: string
	key: Redacted<string>
}
interface VerifiedCertificate {
	der: Uint8Array
	subjectAltName: Option<string>
}
interface TlsPolicy {
	ca: ReadonlyArray<string>
	minVersion: "TLSv1.3"
	requestCert: true
	rejectUnauthorized: true
}
type Prepared =
	| { _tag: "None" }
	| { _tag: "Authorization"; value: Redacted<string> }
	| { _tag: "Certificate"; value: ClientCertificate }
type CredentialsApi = {
	[K in Prepared["_tag"]]: {
		kind: K
		read: Effect<Extract<Prepared, { _tag: K }>, CredentialsError, Scope>
	}
}[Prepared["_tag"]]
type AuthenticatorApi =
	| { _tag: "None"; identity: string }
	| {
			_tag: "Header"
			issuer?: string
			authenticate: (
				header: Option<Redacted<string>>,
			) => Effect<string, AuthenticationFailed>
	  }
	| {
			_tag: "Mtls"
			tls: TlsPolicy
			authenticate: (
				certificate: VerifiedCertificate,
			) => Effect<string, AuthenticationFailed>
	  }

interface Properties {
	protocol: string
	encrypted: boolean
	network: boolean
	carries: ReadonlyArray<"header" | "certificate">
}
interface Channel {
	input: Stream<Uint8Array, TransportError>
	output: Sink<unknown, Uint8Array, unknown, TransportError>
}
interface Handshake {
	authorization: Option<Redacted<string>>
	certificate: Option<VerifiedCertificate>
}
type Session = (channel: Channel) => Effect<void, TransportError, Scope>
type Accept = (handshake: Handshake) => Effect<Session, AuthenticationFailed>
interface Serving {
	ready: Effect<void>
	serve: (accept: Accept) => Effect<void, TransportError, Scope>
}
interface ConnectorApi {
	properties: Properties
	connect: (credentials: Prepared) => Effect<Channel, TransportError, Scope>
}
interface ListenerApi {
	properties: Properties
	bind: (tls: Option<TlsPolicy>) => Effect<Serving, TransportError, Scope>
}
```

`read` runs once per connection. Return the declared kind and retain source
failures in `CredentialsError.cause`. `Authenticator.authenticate` returns a
stable identity, not a session id. Only issuer-based authentication declares
`issuer`; bearer token files have no issuer. A runner rejects multiple distinct
declared issuers. Third-party capability code and its property declarations are
trusted, just like other plugins.

`AuthenticationFailed` has `reason: "missing" | "invalid"`, optional `challenge`
and optional `cause`. An HTTP listener maps this to 401 before upgrade and
passes `challenge` as `WWW-Authenticate`. Bearer challenges are `Bearer` for
missing credentials and `Bearer error="invalid_token"` for invalid credentials.
Do not log Authorization values. Transport failures use `TransportError` and
preserve the underlying cause.

## Properties and lifecycle

- `protocol` describes the transport. `stdio` is exclusive; `stdio` and
  `command` reject explicit auth. mTLS requires `wss`.
- `encrypted` describes confidentiality. mTLS also requires it to be true.
- `network` distinguishes network exposure from local channels. Unencrypted
  network transports warn on runner startup and host connection; header
  credentials add a plaintext warning. Network listeners with none warn at
  startup and each connection. Unix does not warn.
- `carries` declares available handshake evidence. Header auth requires
  `header`; mTLS requires `certificate`. This is a declaration, not a security
  proof.

Remote extracts TLS policy from the authenticator, calls `bind(tls)`, starts
`serve(accept)`, and waits for `ready` while racing serve failure. `ready` means
the accept loop is registered, not merely that an address was bound. All
required listeners must become ready before runner startup succeeds. Later
failures are contained to that assembly.

A listener calls `accept(handshake)` **before** accepting an HTTP upgrade. TLS
validation and client-certificate requests use the policy supplied to `bind`,
not an authentication step after WebSocket opens. On success, call the returned
`Session` with the channel; remote supplies its authenticated identity
internally to the supervisor. Own each session fiber and all resources in a
scope. Stdio `serve` completes at EOF; network listeners keep accepting until
interrupted.

Channels carry ordered reliable bytes. Chunk boundaries have no meaning. EOF is
not process-exit confirmation. WebSocket adapters must reject text, enforce the
frame-size limit, accept exactly one complete framing frame per binary message,
and reassemble split output chunks. The built-in adapters implement this policy.

## Minimal providers

An authenticator for a local trusted channel can assign one configured identity.
This deliberately does no credential validation; it has the same limits as none:

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

A connector can adapt an existing scoped channel service. This example delegates
I/O to an application's `Link`; `Link.open` owns resources in the connection
scope:

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

It supports none only: remote rejects header and certificate credentials before
calling it. A capability subtree that becomes Active without providing its key
fails with a capability-contract error. A missing business service stays
Pending.

## Run shared checks

Import `@graftland/plugin-remote/Testing`; it has no test-runner dependency.
`transport(plugins, fixture)` returns `chunks` and `eof` Effects. `plugins` has
`connector`, `listener`, `credentials`, and `authenticator` plugin definitions.
The fixture receives them, activates real providers and a static-inject consumer
in Graft, and returns a connected channel to an echo session. Supply
configuration, addresses and platform layers there. No full runner is needed.

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

`chunks` splits a frame header and coalesces the remainder with another frame;
`eof` verifies clean completion. `rejection(httpResponse, challenge?)` checks
401, no WebSocket upgrade, and the challenge. Failures are `ConformanceError`
Effects. Also test wrong credentials, preserved causes, scope cancellation,
TLS-before-bind, serve failure before ready, and two differently configured
assemblies together. The
[built-in test fixtures](https://github.com/graftland/graft/blob/main/packages/remote/test/capabilities.test.ts)
show these checks for websocket/mTLS and every other built-in combination.

## Published modules

The package root exports the host default, `plugin`, `Contract`, `Instance`,
public errors and their types. `/runner` is the runner default. `/Auth`,
`/Transport`, `/Errors`, `/Contract`, and `/Testing` are reusable APIs.

Capability paths under `@graftland/plugin-remote/` are:

| Role                  | Paths                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| Host execution        | `host/local`, `host/worker`                                                     |
| Host connectors       | `host/websocket`, `host/unix`, `host/command`                                   |
| Host credentials      | `host/auth/mtls`, `host/auth/bearer`, `host/auth/jwt`, `host/auth/none`         |
| Runner listeners      | `runner/websocket`, `runner/unix`, `runner/stdio`                               |
| Runner authenticators | `runner/auth/mtls`, `runner/auth/bearer`, `runner/auth/jwt`, `runner/auth/none` |

`/internal/bin`, `/internal/worker`, and `/internal/watchdog` are executable
resolution paths, **not public APIs**. Supervisor and the child runtime are
internal. Applications should use the two entries described in the
[remote guide](../overview/).
