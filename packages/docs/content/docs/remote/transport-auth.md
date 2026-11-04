---
title: Transport and authentication
description: Choose a transport and authentication method for your deployment.
---

Choose a transport and authentication method for your deployment. This page
lists supported combinations, warnings, and the boundaries they provide.

## Choose transport and authentication

| `connect` / runner listener    | Auth                          | Guarantees and WARN                                                                                                                                      |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local: {}`                    | No `auth`                     | Separate process, normal OS permissions; no transport WARN.                                                                                              |
| `worker: {}`                   | No `auth`                     | Same process; execution isolation, **no permission isolation**; no transport WARN.                                                                       |
| `url: wss://…`                 | mtls, bearer, jwt, none       | Encrypted, server certificate verified. None warns at runner startup and every connection.                                                               |
| `url: ws://…`                  | bearer, jwt, none             | Unencrypted. Runner warns at startup, host at connection; token warnings explicitly say credentials travel in plaintext. None also warns per connection. |
| `unix: …`                      | bearer, jwt, none             | Filesystem permissions control access; no peer credentials read and no transport/auth WARN.                                                              |
| `command: […]` / `stdio: true` | No explicit `auth`, even none | Authentication and encryption belong to the external command, such as SSH.                                                                               |

Omitted auth means none, with runner identity `anonymous`. On a network listener
this produces WARNs; all callers share its identity. mTLS requires wss. For ws
omit cert/key; for wss supply both. WebSocket uses `/graft` and subprotocol
`graft-remote.v1`. There are no other HTTP endpoints or health checks.

- **Bearer:** host `auth: { bearer: { token: "value" } }`; runner
  `auth: { bearer: { tokens: "./tokens.json" } }`. The file maps SHA-256 hex
  digests to identities: `{ "<sha256 hex>": "billing" }`, never plaintext
  tokens.
- **JWT:** host `auth: { jwt: { token: { file: "./token.txt" } } }`. Runner uses
  `auth: { jwt: { issuer: "https://issuer.example", audience: [graft], algorithms: [ES256], keys: { publicKey: "./public.pem" } } }`.
  Use `keys: { jwksUrl: "https://issuer.example/jwks" }` instead for JWKS.
  `identityClaim` defaults to `sub`, `clockTolerance` to `5 seconds`. The claim
  must be a nonempty string, `exp` is required, and `nbf` is checked.
- **None:** `auth: { none: { identity: billing } }` on the runner assigns a
  name; it does not authenticate callers.

Missing or invalid bearer/JWT credentials return 401 with `WWW-Authenticate`
before upgrade. JWT is checked only then; expiry does not disconnect an existing
session. Stolen tokens can be replayed while valid. Use wss and short lifetimes.

## mTLS certificates

For wss, provision a server certificate and trusted CA. For mTLS, keep client
certificates under a dedicated CA:

```sh
graft-remote certificates --out certs --server runner.example --identity billing
```

Other tools work too. Keep `ca.key` with the operator; deploy server key/cert to
the runner and `client-billing.key`/`.crt` to the host. Both need `ca.crt`. The
hostname must match the server certificate. An mTLS client needs exactly one
`graft://` SAN URI, such as `graft://billing`; other URI SANs may coexist.
Rotating certificates with the same identity preserves the namespace.

See the [host configuration](../host/#load-it-from-yaml-or-typescript) for
client `auth.mtls` and the [runner configuration](../runner/#configure-a-runner)
for server `auth.mtls`. For command connections, follow the
[SSH/stdio setup](../runner/#connect-through-ssh).

## Trust and limits

Remote trusts the runner's installation, configuration, OS and local
permissions, the dedicated CA, and the configured JWT issuer and keys. It does
not support browser hosts, Web Workers, token refresh, mid-session
reauthentication, revocation lists, passwords, symmetric JWT, forwarded
certificate headers, disabled TLS verification, code distribution, runner
failover, or call replay.
