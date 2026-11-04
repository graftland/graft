---
title: Capability plugins
description: Write your own connector, listener, credentials or authenticator.
---

Every transport and authentication form is a shorthand for a **capability**: an
ordinary Graft plugin that publishes one of four services. Name your own
capability where a shorthand would go. Signatures are in the API reference for
[`Transport`](../../reference/plugin-remote/transport/readme/),
[`Auth`](../../reference/plugin-remote/auth/readme/) and
[the package](../../reference/plugin-remote/readme/).

```yaml
connect:
  transport: { name: my-remote-connector, config: { address: example } }
  auth: { name: my-remote-credentials, config: { account: billing } }
```

| Service         | Side   | Does                                                                                         | Import from (definitions only)       |
| --------------- | ------ | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| `Connector`     | Host   | Opens a byte channel to a runner.                                                            | `@graftland/plugin-remote/Transport` |
| `Credentials`   | Host   | Reads what the host presents: `None`, `Authorization` or `Certificate`, once per connection. | `@graftland/plugin-remote/Auth`      |
| `Listener`      | Runner | Accepts byte channels from hosts.                                                            | `@graftland/plugin-remote/Transport` |
| `Authenticator` | Runner | Turns what a host presented into a stable identity, not a session id.                        | `@graftland/plugin-remote/Auth`      |

On the runner, `transport` and `auth` go in a `listen` element. Names resolve
like any [plugin name](../../config-file/#plugin-names). Remote starts a private
copy per entry, so entries can configure one capability differently, and it can
still inject the application's services.

| Rule        | Detail                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| **Export**  | The plugin is the module's default export.                                                                         |
| **Config**  | Decoded with the plugin's `config` schema. Resolve paths against the loader's `ConfigDirectory`.                   |
| **I/O**     | Only in `apply`, never on import.                                                                                  |
| **Publish** | Active without publishing its service fails with `CapabilityContractError`. Waiting for a service stays `Pending`. |
| **Causes**  | Report `TransportError` or `CredentialsError` with the original failure in `cause`.                                |
| **Secrets** | Never log Authorization values.                                                                                    |
| **Trust**   | Capability code, and what it declares about itself, is trusted like any plugin.                                    |

## Properties

Connectors and listeners declare properties. Remote believes them and uses them
to reject combinations and choose [warnings](../transport-auth/#warnings).

| Property    | Meaning                                                  | Remote requires                                                                              |
| ----------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `protocol`  | A short name, such as `wss` or `unix`.                   | `wss` for mTLS. `stdio` alone among listeners. No explicit `auth` with `stdio` or `command`. |
| `encrypted` | Whether traffic stays confidential.                      | `true` for mTLS. Unencrypted network transports warn.                                        |
| `network`   | Reachable over a network rather than locally.            | Network transports warn when unencrypted or unauthenticated.                                 |
| `carries`   | Evidence the handshake carries: `header`, `certificate`. | `header` for bearer and JWT, `certificate` for mTLS. Empty allows only `none`.               |

A **channel** carries ordered, reliable bytes both ways. Chunk boundaries mean
nothing, and the end of a channel does not prove the plugin process exited.

## How a listener runs

1. **Bind** with the TLS policy from the authenticator; only mTLS has one. TLS
   settings, including client certificate requests, come from this policy.
2. **Serve** by calling `serve(accept)`. Remote waits for `ready`, which means
   the accept loop runs, while watching `serve` for failure. A runner starts
   when all listeners are ready; a later failure affects only that listener.
3. **Accept** each connection by calling `accept` with what the host presented,
   before any HTTP upgrade. On `AuthenticationFailed`, an HTTP listener answers
   401 with the error's `challenge` as `WWW-Authenticate`.
4. **Run** the returned session with the channel. Remote attaches the identity.

- Own every session fiber and resource in a scope.
- A `stdio`-style listener ends `graft start` at end of input; a network
  listener accepts until interrupted.
- `AuthenticationFailed.reason` is `"missing"` or `"invalid"`. Built-in bearer
  and JWT use the challenges `Bearer` and `Bearer error="invalid_token"`.
- Only issuer-based authenticators declare an `issuer`; a runner rejects
  listeners with different issuers.
- WebSocket adapters reject text messages, enforce the frame size limit, take
  one complete protocol frame per binary message, and reassemble chunked output.

## Example

An authenticator for a trusted local channel that hands out one identity and,
like `none`, checks nothing:

```ts title="authenticator.ts"
export default Plugin.make({
	name: "fixed-local-identity",
	config: Schema.Struct({ identity: Schema.NonEmptyString }),
	apply: ({ identity }) =>
		Graft.provide(Authenticator, { _tag: "None", identity }),
})
```

## Conformance checks

`@graftland/plugin-remote/Testing` holds the built-ins' checks; it needs no test
runner.

```ts
const checks = Testing.transport(plugins, openEchoSession)

it.live("preserves bytes", () =>
	checks.chunks.pipe(Effect.scoped, Effect.provide(runtime)),
)
```

| Check                                         | Verifies                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Testing.transport(plugins, fixture)`         | Takes `connector`, `listener`, `credentials` and `authenticator`; the fixture starts them in Graft with a consumer and returns a channel to an echo session. |
| `chunks`                                      | Bytes arrive in order when a frame header is split and frames are merged.                                                                                    |
| `eof`                                         | Closing the channel ends it cleanly.                                                                                                                         |
| `Testing.rejection(httpResponse, challenge?)` | Rejected credentials get 401, no upgrade, and the expected challenge.                                                                                        |

Failures are `ConformanceError`. Also test wrong credentials, preserved causes,
scope cancellation, TLS applied at `bind`, `serve` failing before `ready`, and
two differently configured copies at once, as the
[built-in fixtures](https://github.com/graftland/graft/blob/main/packages/plugin-remote/test/capabilities.test.ts)
do.

## Built-in modules

| Role                  | Modules under `@graftland/plugin-remote/`                                       |
| --------------------- | ------------------------------------------------------------------------------- |
| Host execution        | `host/local`, `host/worker`                                                     |
| Host connectors       | `host/websocket`, `host/unix`, `host/command`                                   |
| Host credentials      | `host/auth/mtls`, `host/auth/bearer`, `host/auth/jwt`, `host/auth/none`         |
| Runner listeners      | `runner/websocket`, `runner/unix`, `runner/stdio`                               |
| Runner authenticators | `runner/auth/mtls`, `runner/auth/bearer`, `runner/auth/jwt`, `runner/auth/none` |

The `/internal/child`, `/internal/worker` and `/internal/watchdog` exports let
Remote start its runtimes. They are not public APIs.
