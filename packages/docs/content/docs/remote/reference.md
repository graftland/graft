---
title: Reference
description:
  Every Remote config field, command, default, timeout and error, and what to do
  about each error.
---

This page lists the exact details of Remote: config fields and their defaults,
the `graft-remote` command, timeouts, and errors with what to do about them. For
explanations, start with the [overview](../overview/). Exact TypeScript
signatures are in the [API reference](../../reference/plugin-remote/readme/).

## Conventions

- **Paths** in a config file are relative to the file that contains them, not to
  the working directory. This includes certificate, key, CA, token and `tokens`
  files, and the runner's `root` and `state`.
- **Certificates, keys and CAs** are always file paths. A **token** is a value,
  or `{ file: path }` to read it from a file.
- **Durations** are strings such as `30 seconds` or `500 millis`. `lease`,
  `grace` and `margin` must be finite and positive; `clockTolerance` may be
  zero.
- **One of each.** A `connect` or `listen` element takes exactly one transport
  form and at most one `auth` form.

## Host entry

The host loads `name: remote` with this config:

| Field      | Required | Meaning                                                                                                                                |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `contract` | Yes      | The contract module: a path relative to the config file, a `file:` URL, or a package name. Through a runner it must be a package name. |
| `connect`  | Yes      | Where and how to run the plugin. See below.                                                                                            |
| `config`   | No       | The plugin's config, in its encoded JSON form. Checked against the contract's schema. Defaults to `{}`.                                |

A YAML entry always uses a five-second `shutdownTimeout` and has no `retry`.
Changing `config` or `connect` restarts the remote plugin; it is never updated
in place.

### `connect` forms

| Form                            | Starts or connects to                                       | Extra fields                                                                                                  |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `local: {}`                     | A child process on the host.                                | `local.command`: the command to run instead of the bundled `graft-remote`, such as `[node, /path/to/bin.js]`. |
| `worker: {}`                    | A Node worker in the host process.                          | `worker.execArgv`: Node options for the worker.                                                               |
| `url: wss://…` or `url: ws://…` | A runner's WebSocket listener.                              | `ca`: CA file to trust. `servername`: name to verify instead of the URL's host.                               |
| `unix: path`                    | A runner's Unix socket.                                     | —                                                                                                             |
| `command: [program, args…]`     | A runner started by a command, such as SSH, over its stdio. | `cwd`, `env`.                                                                                                 |
| `transport: { name, config }`   | A [custom connector](../capabilities/).                     | —                                                                                                             |

`local` and `worker` accept no other fields: no `auth`, `instance`, `lease`,
`margin` or `expect`. `command` accepts no `auth`, not even `none`.

### `connect` options for runners

These apply to `url`, `unix`, `command` and `transport`:

| Option     | Default                              | Meaning                                                                                                       |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `instance` | The loader entry's `id`              | The instance name on the runner. Required when there is no entry id, or loading fails with `MissingInstance`. |
| `lease`    | The runner's `lease` (normally 15 s) | Asks the runner for this lease for this instance.                                                             |
| `margin`   | `5 seconds`                          | Extra time, beyond the lease, that the host waits for the runner to confirm the plugin exited.                |
| `expect`   | No checks                            | `{ version, digest }`, either or both, checked before the plugin starts. See below.                           |
| `auth`     | `none`                               | How the host authenticates. See below.                                                                        |

`expect.version` is compared with the `version` in the contract package's
`package.json` on the runner. `expect.digest` is compared with a SHA-256 hex
digest of the package's files, excluding every `node_modules` directory, so it
does not cover dependencies. The runner computes the digest only when `digest`
is set. A mismatch fails with `PackageError`; its message shows both values.

### Host `auth`

| Form                  | Fields                                           |
| --------------------- | ------------------------------------------------ |
| `mtls: { cert, key }` | Client certificate and key files. `wss` only.    |
| `bearer: { token }`   | `token`: a value, or `{ file }`.                 |
| `jwt: { token }`      | `token`: a value, or `{ file }`.                 |
| `none: {}`            | Presents nothing. Same as leaving `auth` out.    |
| `{ name, config }`    | A [custom credentials](../capabilities/) plugin. |

A `{ file }` token is read on every connection, and the file's entire content is
the token, as is. A trailing newline is not stripped and becomes part of the
token. The host sends tokens as `Authorization: Bearer <token>`.

With `Remote.plugin`, `mtls`, `bearer.token` and `jwt.token` can also be an
Effect, or `{ inject, read }` for an Effect that needs services. It runs once
per connection. A token Effect returns a `Redacted<string>`; an mTLS Effect
returns `{ cert, key }` in PEM, with `key` redacted.

## Runner entry

The runner loads `name: remote/runner` from the file given to
`graft-remote serve`:

| Field    | Required | Default      | Meaning                                                                                                     |
| -------- | -------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| `root`   | Yes      | —            | Installation directory. Contract packages are resolved from its `node_modules`.                             |
| `state`  | Yes      | —            | State directory. Created if missing. Must be local, used by one runner at a time, and kept across restarts. |
| `lease`  | No       | `15 seconds` | Default lease for instances. A host's `connect.lease` overrides it for that instance.                       |
| `grace`  | No       | `5 seconds`  | Time between interrupting a plugin process and killing it.                                                  |
| `listen` | Yes      | —            | Listeners. See below.                                                                                       |

### `listen` forms

| Form                          | Fields                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `url: ws://host:port`         | No `cert` or `key`. The URL's path must be empty or `/graft`.                                                 |
| `url: wss://host:port`        | `cert` and `key`: the server certificate and key. Path as above.                                              |
| `unix: path`                  | The socket file to create.                                                                                    |
| `stdio: true`                 | `identity`: the name given to the connecting host, default `anonymous`. No `auth`. Must be the only listener. |
| `transport: { name, config }` | A [custom listener](../capabilities/).                                                                        |

Every listener of a runner shares one set of instances. All listeners together
may use at most one JWT issuer.

### Runner `auth`

| Form                 | Fields                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mtls: { ca }`       | The CA file client certificates must chain to. `wss` only. The identity is the certificate's single `graft://` subject alternative name URI.                                                                                                                                                                                           |
| `bearer: { tokens }` | A JSON file mapping SHA-256 hex digests of tokens to identities: `{ "<sha256 hex>": "billing" }`.                                                                                                                                                                                                                                      |
| `jwt: { … }`         | `issuer` (required), `audience` (required, a list), `algorithms` (required, asymmetric only), `keys` (required: `{ publicKey: file }` or `{ jwksUrl: url }`), `identityClaim` (default `sub`), `clockTolerance` (default `5 seconds`). `exp` is required; `nbf` is checked when present; the identity claim must be a nonempty string. |
| `none: { identity }` | Assigns `identity` (default `anonymous`) to every caller without checking anything.                                                                                                                                                                                                                                                    |
| `{ name, config }`   | A [custom authenticator](../capabilities/).                                                                                                                                                                                                                                                                                            |

Leaving `auth` out means `none` with identity `anonymous`. Missing or invalid
bearer and JWT credentials get HTTP 401 with `WWW-Authenticate` before the
WebSocket opens.

## `graft-remote`

The `@graftland/plugin-remote` package installs the `graft-remote` command.

### `graft-remote serve`

```sh
graft-remote serve --config <file>
```

Runs a runner from the given config file. `--config` is its only flag. The file
is read once; restart to apply changes. Logs go to standard error.

- It reports startup as complete only when every listener is ready. A startup
  failure closes what was already opened and exits nonzero with the cause.
- A `stdio` runner exits with status 0 at end of input, after stopping its
  plugin, confirming the exit and releasing the state directory. If that fails,
  it exits nonzero with the cause.

### `graft-remote certificates`

```sh
graft-remote certificates --out <dir> [--server <name>]... [--identity <name>]... [--days <n>] [--force]
```

| Flag         | Default | Meaning                                                                                  |
| ------------ | ------- | ---------------------------------------------------------------------------------------- |
| `--out`      | —       | Directory for the CA and the issued certificates.                                        |
| `--server`   | —       | DNS name or IP address of the runner. Repeat for more names. Issues `server.crt`/`.key`. |
| `--identity` | —       | Host identity. Repeat for more hosts. Issues `client-<identity>.crt`/`.key`.             |
| `--days`     | `365`   | Validity of the certificates.                                                            |
| `--force`    | off     | Replace the requested server and client certificates. The CA is never replaced.          |

The first run creates `ca.crt` and `ca.key`; later runs reuse them. Without
`--force`, the command refuses to overwrite an existing certificate. Identities
are URI-encoded in file names. Key files are written with mode `0600`.

Other forms of `graft-remote` exist for Remote's own use and are not a public
interface.

## Timeouts and defaults

| What                                       | Default                  | Set with                                  |
| ------------------------------------------ | ------------------------ | ----------------------------------------- |
| Graceful stop of the plugin                | 5 seconds                | `shutdownTimeout` in `Remote.plugin` only |
| Direct plugin exit after the graceful stop | 1 second                 | Fixed                                     |
| `local`: terminate, then `SIGKILL`         | 1 second later           | Fixed                                     |
| Lease                                      | 15 seconds               | Runner `lease`, or host `connect.lease`   |
| Lease renewal                              | Every third of the lease | Fixed                                     |
| Interrupt-to-kill on the runner            | 5 seconds                | Runner `grace`                            |
| Host wait for exit confirmation            | Lease + 5 seconds        | Host `connect.margin`                     |
| JWT clock tolerance                        | 5 seconds                | Runner `jwt.clockTolerance`               |
| Certificate validity                       | 365 days                 | `graft-remote certificates --days`        |

## `Remote.plugin` options

`Remote.plugin(contract, options)` builds a remote plugin in TypeScript.

| Option            | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `contractModule`  | Where the plugin process imports the contract from. Not the contract's `module`. |
| `connect`         | As in YAML, plus Effect credentials.                                             |
| `config`          | The plugin's config in its encoded form.                                         |
| `shutdownTimeout` | Bound for the graceful stop. Default `5 seconds`.                                |
| `retry`           | A `Schedule` for restarting after a failure. Calls themselves are never retried. |

## `Contract.make` options

| Option     | Meaning                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| `name`     | The plugin's name.                                                                         |
| `config`   | Config schema. Must encode to JSON and need no services.                                   |
| `module`   | URL of the built implementation, usually `new URL("./impl.js", import.meta.url).href`.     |
| `error`    | Schema of declared failures. Defaults to `Schema.Never`. Must need no services.            |
| `inject`   | Host services the implementation uses, each described with `Contract.service`.             |
| `provides` | Services the implementation publishes to the host, each described with `Contract.service`. |

`Contract.service(key, rpcGroup, { toHandlers, fromClient })` describes one
service. Service keys must be unique within a contract. A contract module
exports the contract as `contract` or as its default export.

## Errors

### What callers and `fork.await` see

| Error                        | Meaning                                                                                         | What to do                                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A declared error             | The plugin failed with an error in the contract's `error` schema.                               | Handle it like any plugin error.                                                                                                                                   |
| `Contract.UndeclaredFailure` | The plugin failed with an error the contract does not declare. `original` holds it.             | Declare it in `error`, or handle it inside the plugin.                                                                                                             |
| `RemoteError`                | Remote itself failed. `cause` holds the full cause; see the next table for what it may contain. | Read `cause`.                                                                                                                                                      |
| `RemoteWithdrawn`            | The plugin's services were withdrawn.                                                           | Normal during stops and restarts. Consumers are stopped first.                                                                                                     |
| `MissingInstance`            | A runner connection has neither `connect.instance` nor a loader entry id.                       | Set `connect.instance`.                                                                                                                                            |
| `RemoteEntryError`           | A YAML entry failed. `entry`, `directory` and `field` say which entry and which field.          | Fix that field. Fields include `contract`, `config`, `connect`, `connect.transport`, `connect.auth`, and on the runner `listen[n].transport` and `listen[n].auth`. |

Defects stay defects; Remote does not turn them into errors.

### What you may find inside `RemoteError`

These come from the connection, the plugin process or the runner:

| Error                        | Meaning                                                                                                      | What to do                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `TransportError`             | The connection failed. `cause` holds the underlying error.                                                   | Check the network, the address and TLS settings.                                                              |
| `CredentialsError`           | Reading the host's credentials failed, for example a missing token file.                                     | Check the credential source in `cause`.                                                                       |
| `ProcessExited`              | The plugin process or worker exited unexpectedly. Includes exit code and stderr.                             | Read `stderr` and `statusCause`.                                                                              |
| `CommandExited`              | The `command` connection's program exited, with its code and stderr.                                         | Check the command, such as SSH access and the forced command.                                                 |
| `CapabilityCombinationError` | The transport and authentication do not fit together, such as mTLS over `ws` or `auth` on `command`.         | Pick a supported combination. See [Choose transport and authentication](../transport-auth/#all-combinations). |
| `PackageError`               | The runner could not find, read or verify the contract package, or `expect` did not match.                   | Install the package under the runner's `root`, or fix `expect`.                                               |
| `SessionAccessDenied`        | The session belongs to another authenticated identity.                                                       | Make sure each host uses its own credentials.                                                                 |
| `StaleSession`               | Another start of the same instance got there first, or the runner no longer knows the session or generation. | Check for two hosts sharing an identity and instance name.                                                    |
| `SessionConflict`            | Conflicting requests on one session.                                                                         | Check for two hosts sharing an identity and instance name.                                                    |
| `LeaseExpired`               | The lease ran out before the host renewed it.                                                                | Check the network; consider a longer `lease`.                                                                 |
| `SessionStopped`             | The session is stopping, stopped, or was retired during runner recovery.                                     | Expected while an instance is being replaced or the runner is recovering.                                     |
| `TerminationUnconfirmed`     | The runner could not confirm that a plugin process exited.                                                   | Check the runner machine for the process. Replacement waits for confirmation.                                 |
| `RunnerClosing`              | The runner is shutting down.                                                                                 | Wait for it to come back.                                                                                     |
| `StateDirectoryLocked`       | Another runner owns the state directory, or it cannot be locked.                                             | Run one runner per state directory.                                                                           |
| `StateStorageError`          | The runner could not read or write its state.                                                                | Check the state directory's disk and permissions.                                                             |
| `ExecutionError`             | The runner could not start, watch or stop a plugin process.                                                  | Read `detail` and the runner's logs.                                                                          |

### Cleanup errors

These appear in the `cause` of `Fork.CleanupError` when a remote plugin is
disposed:

| Error                          | Meaning                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `RemoteTerminationUnconfirmed` | The host could not get confirmation that the runner's plugin process exited. It may still be running.                                        |
| `LocalTerminationTimeout`      | A `local` child or `worker` did not exit within one second of the graceful stop and was terminated. Reported even when termination succeeds. |

### Runner and capability errors

| Error                     | Meaning                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| `StartupError`            | `graft-remote serve` could not start. `cause` says why.                         |
| `ListenerConfigError`     | A listener's transport and authentication do not fit together.                  |
| `CapabilityContractError` | A capability plugin became active without publishing its service.               |
| `AuthenticationFailed`    | A host's credentials were `missing` or `invalid`. Sent to the host as HTTP 401. |
| `ConformanceError`        | A check from `@graftland/plugin-remote/Testing` failed.                         |
| `CertificateExists`       | `graft-remote certificates` would overwrite a certificate. Use `--force`.       |

## Logs

| Message                                      | Logged by | Meaning                                                                          |
| -------------------------------------------- | --------- | -------------------------------------------------------------------------------- |
| `Remote execution terminated`                | Host      | A runner's plugin process stopped. `remote.termination` is `Exited` or `Killed`. |
| `Remote logs were dropped`                   | Host      | Some plugin logs were lost under load; the count is annotated.                   |
| `Remote host connection failed`              | Runner    | A host connection ended abnormally. Annotated with the host's identity.          |
| `Remote listener failed`                     | Runner    | A listener failed after startup. The others keep running.                        |
| `Superseded remote execution cleanup failed` | Runner    | Cleaning up a replaced plugin process failed.                                    |
| Unencrypted and no-authentication warnings   | Both      | See [What the warnings mean](../transport-auth/#what-the-warnings-mean).         |

## Published modules

| Module                                         | Contents                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@graftland/plugin-remote`                     | The `remote` host plugin (default export), `plugin`, `Contract`, `Instance`, and the public errors. |
| `@graftland/plugin-remote/runner`              | The `remote/runner` plugin (default export).                                                        |
| `@graftland/plugin-remote/Contract`            | `Contract.make`, `Contract.service` and related types.                                              |
| `@graftland/plugin-remote/Errors`              | Error classes.                                                                                      |
| `@graftland/plugin-remote/Auth`, `/Transport`  | The four capability services.                                                                       |
| `@graftland/plugin-remote/Testing`             | The shared capability checks.                                                                       |
| `@graftland/plugin-remote/host/*`, `/runner/*` | The built-in capabilities. See [the list](../capabilities/#built-in-capability-modules).            |

`/internal/bin`, `/internal/worker` and `/internal/watchdog` exist so that
Remote can find its own executables. They are **not public APIs**. The runner's
supervisor and the plugin process runtime are internal too.
