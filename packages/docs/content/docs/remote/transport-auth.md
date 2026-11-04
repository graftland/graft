---
title: Choose transport and authentication
description:
  How hosts and runners connect, what each option protects against, and what the
  warnings mean.
---

This page helps you decide how a host connects to a runner and how the runner
knows who the host is. It explains what each option protects against, what it
does not, and what the warnings in your logs mean. Direct `local` and `worker`
plugins need none of this: they have no network connection and no
authentication.

## The short answer

| Situation                               | Use                                         |
| --------------------------------------- | ------------------------------------------- |
| Hosts reach the runner over a network   | `wss` with a JWT, mTLS or a bearer token    |
| You already manage access with SSH      | `command: [ssh, ...]` with a `stdio` runner |
| Host and runner are on the same machine | A Unix socket, guarded by file permissions  |
| Trying things out on `127.0.0.1`        | `ws` with `none`, and expect warnings       |

Two separate choices make up a connection:

- The **transport** carries the bytes: WebSocket, a Unix socket, or a command's
  standard input and output.
- **Authentication** tells the runner who the host is. The result is an
  **identity**, a name such as `billing`. Together with the instance name, it
  decides which running plugin a connection belongs to, so two hosts with the
  same identity and instance name replace each other's plugin.

## Transports

**`wss://`** is WebSocket over TLS. Traffic is encrypted, and the host checks
the runner's certificate: against `ca` if you set it, otherwise against the CAs
Node trusts. `servername` overrides the name checked when it differs from the
URL's host. Use it whenever traffic crosses a network.

**`ws://`** is plain WebSocket. Anyone on the path can read and change the
traffic, including any token the host sends. Use it only on loopback or for
tests.

**`unix:`** is a Unix socket on the same machine. Whoever can open the socket
file can connect, so file permissions are the access control. The runner does
not read the peer's operating system credentials.

**`command:`** on the host and **`stdio: true`** on the runner run the protocol
over a command's standard input and output, usually SSH. The command provides
authentication and encryption, so these forms take no `auth` at all, not even
`none`.

WebSocket listeners serve one path, `/graft`, with the subprotocol
`graft-remote.v1`. There are no other HTTP endpoints and no health check.

## Authentication

**mTLS** (mutual TLS): the host presents a client certificate signed by a CA the
runner trusts. The identity is the certificate's `graft://` name, so
`graft://billing` means `billing`. It works only over `wss`.

**Bearer token**: the host sends a shared secret. The runner never stores the
token itself, only its SHA-256 digest, in a file that maps digests to
identities.

**JWT**: the host sends a signed token from an issuer you run or use. The runner
checks the signature against the issuer's public key or JWKS, the issuer, the
audience and the expiry, and takes the identity from a claim (`sub` by default).

**None**: no check at all. On the runner, `none` assigns every caller one
identity, `anonymous` unless you set `identity`. Leaving `auth` out means
`none`.

### Bearer tokens

```yaml title="host.yml"
connect:
  url: wss://runner.example:7443
  auth:
    bearer:
      token: { file: ./runner-token.txt }
```

```yaml title="runner.yml"
listen:
  - url: wss://0.0.0.0:7443
    cert: ./certs/server.crt
    key: ./certs/server.key
    auth:
      bearer:
        tokens: ./tokens.json
```

```json title="tokens.json"
{ "<sha256 hex of the token>": "billing" }
```

Compute the digest of the exact token bytes, for example with
`printf %s "$TOKEN" | shasum -a 256`. A `{ file }` token is read as is,
including any trailing newline, so write the token file without one.

### JWT

```yaml title="host.yml"
auth:
  jwt:
    token: { file: ./runner-token.txt }
```

```yaml title="runner.yml"
auth:
  jwt:
    issuer: https://issuer.example
    audience: [graft]
    algorithms: [ES256]
    keys:
      publicKey: ./issuer-public.pem
```

Use `keys: { jwksUrl: https://issuer.example/jwks }` to fetch keys from the
issuer instead of a file. The token must have an `exp` claim; `nbf` is checked
when present; the identity claim must be a nonempty string. `clockTolerance`
(default `5 seconds`) allows for clock skew. Only asymmetric algorithms are
accepted.

### mTLS

`graft-remote certificates` can issue a dedicated CA, a server certificate and
client certificates in one go:

```sh
graft-remote certificates --out certs --server runner.example --identity billing
```

| File                                       | Goes to                   |
| ------------------------------------------ | ------------------------- |
| `ca.key`                                   | Stays with the operator   |
| `ca.crt`                                   | Both the runner and hosts |
| `server.crt`, `server.key`                 | The runner                |
| `client-billing.crt`, `client-billing.key` | The host named `billing`  |

```yaml title="host.yml"
connect:
  url: wss://runner.example:7443
  ca: ./certs/ca.crt
  auth:
    mtls:
      cert: ./certs/client-billing.crt
      key: ./certs/client-billing.key
```

```yaml title="runner.yml"
listen:
  - url: wss://0.0.0.0:7443
    cert: ./certs/server.crt
    key: ./certs/server.key
    auth:
      mtls:
        ca: ./certs/ca.crt
```

You can use other tools. The rules are: the server certificate must match the
host name that hosts connect to, and a client certificate needs exactly one
`graft://` URI in its subject alternative names (other URIs may be present too).
Use a CA dedicated to Graft for client certificates: any certificate it signs
with a `graft://` name can connect as that identity. When you rotate a
certificate, keep the same identity and the host keeps its instances.

## All combinations

| Transport                      | Authentication              | What you get                                                                    | Warnings                                                                                        |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `local: {}`                    | None allowed                | A separate process with your normal OS permissions.                             | None.                                                                                           |
| `worker: {}`                   | None allowed                | A separate thread in the host process. Isolates execution, **not permissions**. | None.                                                                                           |
| `url: wss://…`                 | mtls, bearer, jwt, none     | Encrypted; the runner's certificate is verified.                                | With `none`: at runner startup and on every connection.                                         |
| `url: ws://…`                  | bearer, jwt, none           | Not encrypted.                                                                  | Runner at startup, host on connect; louder with tokens. `none` adds the per-connection warning. |
| `unix: …`                      | bearer, jwt, none           | Access controlled by file permissions.                                          | None.                                                                                           |
| `command: […]` / `stdio: true` | None allowed, not even none | Whatever the command provides, such as SSH.                                     | None.                                                                                           |

Combinations outside this table fail before connecting. mTLS needs `wss`; a `ws`
listener takes no `cert` or `key`, and a `wss` listener needs both.

## What the warnings mean

| Warning                                                                   | Logged by                  | Meaning                                                                    |
| ------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| `ws:// listener is unencrypted`                                           | Runner, at startup         | A network listener without TLS.                                            |
| `ws:// listener is unencrypted; credentials are transmitted in plaintext` | Runner, at startup         | The same, and its tokens can be read on the wire.                          |
| `ws:// connection is unencrypted` (and the `credentials` variant)         | Host, on each connection   | The host side of the same problem.                                         |
| `WebSocket listener has no authentication`                                | Runner, at startup         | A network listener uses `none`: anyone who can reach it gets its identity. |
| `WebSocket connection has no authentication`                              | Runner, on each connection | A host connected through such a listener.                                  |

Unix sockets, commands and `stdio` never produce these warnings. The fix is
always the same: move to `wss`, and add authentication.

## What authentication does not do

- **It is checked once.** Bearer tokens and JWTs are checked when the connection
  opens. A missing or invalid token gets HTTP 401 with a `WWW-Authenticate`
  header before the WebSocket opens. A JWT that expires later does not end a
  session that is already open.
- **Tokens can be replayed.** Anyone who steals a token can use it while it is
  valid. Send tokens only over `wss`, and keep JWT lifetimes short.
- **`none` is a name, not a check.** All callers share its identity.

## What Remote trusts

Remote trusts the runner's installation, its configuration, its operating system
and local permissions, the dedicated CA, and the configured JWT issuer and keys.

It does not support: browser hosts, Web Workers, token refresh, reauthentication
during a session, revocation lists, passwords, symmetric JWT algorithms,
certificate headers forwarded by a proxy, turning off TLS verification,
distributing code to runners, runner failover, or replaying calls.

For connections that none of these options cover, you can
[write your own transport or authentication](../capabilities/).
