---
title: Transport and authentication
description:
  Choose how a host reaches a runner and how the runner identifies it.
---

A runner connection is a **transport**, which carries the bytes, and an
**authentication**, which gives the host an **identity** such as `billing`.
Direct `local` and `worker` plugins have neither.

## Combinations

| Transport                      | Authentication                  | Protects                                                                                                 | Warnings                    |
| ------------------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------- |
| `url: wss://…`                 | `mtls`, `bearer`, `jwt`, `none` | Encrypted; the host verifies the runner's certificate.                                                   | With `none`.                |
| `url: ws://…`                  | `bearer`, `jwt`, `none`         | Nothing on the wire. Anyone on the path can read and change traffic and tokens. Loopback and tests only. | Always; louder with tokens. |
| `unix: …`                      | `bearer`, `jwt`, `none`         | Whoever can open the socket file can connect. Peer OS credentials are not read.                          | None.                       |
| `command: […]` / `stdio: true` | No `auth`, not even `none`      | Whatever the command provides, such as SSH.                                                              | None.                       |

Other combinations fail before connecting, with `CapabilityCombinationError` on
the host or `ListenerConfigError` on the runner. A `ws` listener takes no `cert`
or `key`, and a `wss` listener needs both.

## Auth options

| Form     | Host `connect.auth`                  | Runner `listen[].auth`                                                                                                                                                                   | Identity                                                                     |
| -------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `mtls`   | `{ cert, key }` files. `wss` only.   | `{ ca }`: the CA client certificates chain to.                                                                                                                                           | The certificate's single `graft://` URI SAN: `graft://billing` is `billing`. |
| `bearer` | `{ token }`                          | `{ tokens }`: a JSON file `{ "<sha256 hex of token>": "billing" }`. The runner never stores tokens.                                                                                      | The mapped name.                                                             |
| `jwt`    | `{ token }`                          | `issuer`, `audience` (a list), `algorithms` (asymmetric only), `keys` (`{ publicKey: file }` or `{ jwksUrl }`), `identityClaim` (default `sub`), `clockTolerance` (default `5 seconds`). | The identity claim, a nonempty string.                                       |
| `none`   | `{}`, the same as leaving `auth` out | `{ identity }`, the same as leaving `auth` out. Checks nothing.                                                                                                                          | `identity`, default `anonymous`, shared by every caller.                     |
| custom   | `{ name, config }`                   | `{ name, config }`                                                                                                                                                                       | See [Capability plugins](../capabilities/).                                  |

- The host sends tokens as `Authorization: Bearer <token>`. Compute a bearer
  digest from the exact bytes: `printf %s "$TOKEN" | shasum -a 256`.
- A JWT needs `exp`; `nbf` is checked when present. `clockTolerance` may be
  zero.
- A missing or invalid token gets HTTP 401 with `WWW-Authenticate` before the
  WebSocket opens.
- Use a CA dedicated to Graft for client certificates: anything it signs with a
  `graft://` name connects as that identity. A client certificate needs exactly
  one `graft://` URI; other URIs may be present. The server certificate must
  match the name hosts connect to. Rotating a certificate with the same identity
  keeps the host's instances.

`graft remote certificates` issues a private CA and certificates:

Enable the command plugin once in the project or user configuration:

```sh
graft add --plugin remote
```

```sh
graft remote certificates --out certs --server runner.example --identity billing
```

| Flag         | Default | Meaning                                                                  |
| ------------ | ------- | ------------------------------------------------------------------------ |
| `--out`      | —       | Directory for the CA and certificates.                                   |
| `--server`   | —       | Runner DNS name or IP, repeatable. Issues `server.crt` and `server.key`. |
| `--identity` | —       | Host identity, repeatable. Issues `client-<identity>.crt` and `.key`.    |
| `--days`     | `365`   | Validity.                                                                |
| `--force`    | off     | Replace requested certificates. Without it, `CertificateExists`.         |

The first run creates `ca.crt` and `ca.key`, and later runs reuse them; the CA
is never replaced. Identities are URI-encoded in file names, and keys are
written with mode `0600`. Keep `ca.key` with the operator; `ca.crt` goes to the
runner and the hosts.

## Credential sources

| Source                  | Where                | Behavior                                                                                                                       |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A value, `token: "..."` | YAML and TypeScript  | Used as is.                                                                                                                    |
| `token: { file: path }` | YAML and TypeScript  | Read on every connection, so it can rotate. The whole file is the token, read verbatim: a trailing newline becomes part of it. |
| An Effect               | `Remote.plugin` only | Runs once per connection. A token returns `Redacted<string>`; `mtls` returns `{ cert, key }` in PEM with `key` redacted.       |
| `{ inject, read }`      | `Remote.plugin` only | An Effect that needs services. If one is withdrawn, the remote plugin stops until it returns.                                  |

Certificates, keys and CAs are always file paths, relative to the config file.

```ts
connect: {
	url: "wss://runner.example:7443",
	instance: "greeter",
	auth: { jwt: { token: Config.Redacted("RUNNER_TOKEN") } },
}
```

## Warnings

| Message                                                                     | When                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ws:// listener is unencrypted`                                             | Runner startup, for a `ws` listener.                                   |
| `ws:// listener is unencrypted; credentials are transmitted in plaintext`   | The same, with bearer or JWT.                                          |
| `ws:// connection is unencrypted`                                           | Host, on each `ws` connection.                                         |
| `ws:// connection is unencrypted; credentials are transmitted in plaintext` | The same, when the host sends a token.                                 |
| `WebSocket listener has no authentication`                                  | Runner startup, for a network listener with `none`.                    |
| `WebSocket connection has no authentication`                                | Runner, on each connection through such a listener.                    |
| `Remote host authentication failed`                                         | Runner, when it rejects a host's credentials, with the `reason`.       |
| `Remote host connection failed`                                             | Runner, when a connection ends abnormally, with the identity.          |
| `Remote listener failed`                                                    | Runner, when a listener fails after startup.                           |
| `Superseded remote execution cleanup failed`                                | Runner, when cleaning up a replaced plugin process fails.              |
| `Remote logs were dropped`                                                  | Host, when forwarded plugin logs were lost under load, with the count. |

Unix sockets, commands and `stdio` never log the transport warnings. To silence
them, use `wss` with authentication.

## Trust and limits

- Remote trusts the runner's installation and configuration, its operating
  system and local permissions, the dedicated CA, and the configured JWT issuer
  and keys.
- Tokens and JWTs are checked once, when the connection opens. A JWT that
  expires later does not end an open session.
- A stolen token works until it expires. Send tokens only over `wss`, and keep
  JWT lifetimes short.
- `none` is a name, not a check.
- Not supported: browser hosts, Web Workers, token refresh, reauthentication
  during a session, revocation lists, passwords, symmetric JWT algorithms,
  certificate headers forwarded by a proxy, turning off TLS verification,
  distributing code to runners, runner failover, and replaying calls.
