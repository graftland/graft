---
title: Run plugins on another machine
description:
  Deploy a runner, install plugin packages on it, and connect a host over wss
  with a JWT or over SSH.
---

This guide is for deploying a runner and connecting a host to it. It assumes you
already have a plugin split into a contract and an implementation, as in
[Getting started](../getting-started/). The main path uses `wss` with a JWT,
which is what a real deployment over a network usually looks like. SSH and Unix
sockets are covered at the end.

## What a runner is

A **runner** is a long-running process, started with `graft-remote serve`, that
hosts connect to. For each connection, it:

1. Checks who the host is (authentication).
2. Looks up the plugin package that the host names. The package must already be
   installed on the runner. The host never sends code.
3. Starts a plugin process for it, and stops it when the host is done, when the
   host disappears, or when a newer copy replaces it.

Each plugin a runner starts belongs to an **instance**: a stable name that, by
default, is the `id` of the host's config entry. The runner keeps a small
**state directory** on disk that records, for each instance, how many times it
has been replaced. See [Restarts, replacements and stopping](../restarts/) for
why that matters.

## 1. Prepare the machine

The runner needs:

- Linux or macOS, with Node.js 22.22 or later.
- An **installation directory** with `@graftland/plugin-remote`, the built
  plugin packages, and their dependencies installed in its `node_modules`. The
  runner looks up contract packages by name there.

Because the runner finds plugins by package name, publish the contract as part
of a package with an `exports` entry for it, for example `my-plugin/contract`.
Install the same package on the host too: the host also imports the contract.

Keep the installation unchanged while the runner is running. To deploy a new
version, install it and then restart the plugins that use it (see
[Redeploying a plugin](../restarts/#redeploying-a-plugin)).

## 2. Get a server certificate

With `wss`, hosts check the runner's TLS certificate, so the runner needs one
whose name matches the address hosts connect to. Any certificate tool works.
`graft-remote certificates` can make a small private CA and a server certificate
for you:

```sh
graft-remote certificates --out certs --server runner.example
```

This writes `certs/ca.crt`, `certs/ca.key`, `certs/server.crt` and
`certs/server.key`. Keep `ca.key` with the operator, put `server.crt` and
`server.key` on the runner, and give `ca.crt` to each host so it can trust the
runner.

## 3. Write `runner.yml`

A runner is configured with a Graft [config file](../../config-file/) containing
one `remote/runner` entry:

```yaml title="runner.yml"
- id: runner
  name: remote/runner
  config:
    root: ./installation
    state: ./state
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth:
          jwt:
            issuer: https://issuer.example
            audience: [graft]
            algorithms: [ES256]
            keys:
              jwksUrl: https://issuer.example/.well-known/jwks.json
```

| Field    | Meaning                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| `root`   | The installation directory from step 1.                                                                          |
| `state`  | Where the runner keeps its records. Created if missing.                                                          |
| `listen` | Where hosts connect, and how they authenticate. One entry per address.                                           |
| `auth`   | Here, JWTs from your issuer, checked against its published keys. The host's identity is the token's `sub` claim. |

All paths, including `root`, `state` and the certificate files, are relative to
`runner.yml`, not to the directory you start the runner from.
[Choose transport and authentication](../transport-auth/) explains the other
`auth` options, and the [reference](../reference/#runner-entry) lists every
field and its default.

Look after the state directory:

- It must be on a local filesystem.
- Only one running runner may use it. A second runner on the same directory
  fails to start with `StateDirectoryLocked`.
- Preserve it across restarts. It records replacement counts and any plugin
  processes that were still running.
- Do not start a fresh, empty state directory for a deployment whose identity is
  still in use elsewhere: the counts would start over.

## 4. Start the runner

```sh
graft-remote serve --config runner.yml
```

`serve` accepts only `--config`. The runner reads `runner.yml` once at startup;
restart it to apply changes.

- The runner reports itself started only when every listener is ready. If one
  fails during startup, the runner closes whatever it already opened and exits
  with the cause.
- If a listener fails later, the runner logs `Remote listener failed` and keeps
  the other listeners and the running plugins going.

Run the runner under a service manager that stops all of its descendant
processes when it stops, for example systemd with `KillMode=control-group`.
Plugin processes are descendants of the runner, and the runner's own checks have
limits (see [Leases](../restarts/#leases)).

## 5. Connect the host

On the host, point the `remote` entry at the runner:

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      url: !env RUNNER_URL
      ca: ./certs/ca.crt
      auth:
        jwt:
          token: { file: ./runner-token.txt }
    config:
      greeting: Hello
```

Set `RUNNER_URL` to `wss://runner.example:7443` and start the host:

```sh
graft start host.yml
```

- `contract` is now a package name. The host imports it from its own
  installation; the runner resolves the same name under its `root`.
- `ca` is the CA from step 2. Leave it out if the runner's certificate is signed
  by a CA the host already trusts.
- `token: { file: ... }` reads the token from a file each time the host
  connects, so you can rotate it without restarting. The file's whole content is
  the token, read as is: a trailing newline becomes part of the token, so write
  the file without one. `token: "..."` takes the token as a value instead.
- Paths are relative to `host.yml`.

The entry's `id`, `greeter`, names the instance on the runner. Keep it stable:
the loader saves generated ids in the config file, so they survive restarts.

### Instance names

The instance name decides which running plugin a connection belongs to. A new
connection for the same instance replaces the old plugin process. Watch out for
these cases:

- **Two hosts, same identity, same instance name.** They share one slot on the
  runner and keep replacing each other. Give each host its own identity, or set
  a distinct `connect.instance`.
- **Two remote plugins forked from one entry.** Child plugins inherit their
  entry's id, so they would collide. Give each one an explicit
  `connect.instance`.
- **Embedded groups.** Group ids are only unique among siblings. Check that the
  resulting names are unique.
- **Loading without the loader.** `Remote.plugin` loaded directly has no entry
  id. Set `connect.instance`, or loading fails with `MissingInstance`.

### Check the installed version

The host can require that the runner has a specific version installed before the
plugin starts:

```yaml
connect:
  url: !env RUNNER_URL
  expect:
    version: 1.4.0
```

`version` is compared with the contract package's `package.json`. `digest`
compares a SHA-256 of the package's files instead, excluding `node_modules`, so
it does not cover dependencies. The runner only computes the digest when you ask
for one. A mismatch fails with a `PackageError` whose message shows both the
expected and the received value.

### Credentials from code

With `Remote.plugin`, a credential can also be an Effect. It runs once for each
connection:

```ts
import * as Remote from "@graftland/plugin-remote"
import { Config } from "effect"
import { contract } from "my-plugin/contract"

export default Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		url: "wss://runner.example:7443",
		instance: "greeter",
		auth: { jwt: { token: Config.Redacted("RUNNER_TOKEN") } },
	},
	config: { greeting: "Hello" },
})
```

- A token Effect returns a `Redacted<string>`. An mTLS Effect returns
  `{ cert, key }` in PEM, with the key redacted.
- If the credential needs a service, use `{ inject: [Vault], read: ... }`
  instead of a bare Effect. Remote runs it in a child plugin that injects those
  services. If one of them is withdrawn, the remote plugin stops until it comes
  back.

## Connect over SSH instead

If hosts already reach the runner's machine over SSH, you can skip the network
listener. The host runs `ssh` as a command and talks to `graft-remote serve`
over its standard input and output. SSH does the authentication and encryption.

On the runner, write a configuration with a single `stdio` listener, and give
each SSH identity its own state directory:

```yaml title="/srv/graft/stdio.yml"
- id: runner
  name: remote/runner
  config:
    root: /srv/graft/installation
    state: /srv/graft/state/billing
    listen:
      - stdio: true
        identity: billing
```

In the runner account's `authorized_keys`, restrict the host's key to exactly
that command:

```text
restrict,command="/usr/local/bin/graft-remote serve --config /srv/graft/stdio.yml" ssh-ed25519 AAAA... billing-host
```

On the host, use the `command` form of `connect`:

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      command: [ssh, -T, billing@runner.example]
    config:
      greeting: Hello
```

How this behaves:

- SSH authenticates the host. `identity` only gives it a stable name on the
  runner; it defaults to `anonymous`. Do not add `auth` to a `command`
  connection or a `stdio` listener, not even `none`.
- Each SSH session runs its own `serve`. It stops when the connection ends: it
  stops the plugin, confirms that it exited, releases the state directory and
  exits with status 0. If something fails, it exits with a nonzero status and
  reports the cause.
- A second session with the same state directory at the same time is refused.
- Standard output carries protocol bytes, and logs go to standard error. Do not
  allocate a terminal (`-T`) or print banners to standard output.
- A `stdio` listener must be the only listener of its runner.
- SSH exiting does not prove that the plugin process stopped. Only the runner's
  own confirmation does.

`command` also accepts optional `cwd` and `env` fields for the command it runs.

## Connect over a Unix socket

On a single machine, a Unix socket avoids the network entirely. Access is
controlled by the socket file's permissions:

```yaml title="runner.yml"
listen:
  - unix: ./runner.sock
    auth:
      none:
        identity: billing
```

```yaml title="host.yml"
connect:
  unix: /srv/graft/runner.sock
```

`none` gives every connecting host the identity `billing` without checking
anything. That is reasonable only when the file permissions already decide who
may connect. You can use bearer or JWT authentication over a Unix socket too.

## Several listeners

One `remote/runner` entry can have several `listen` elements, for example `wss`
for remote hosts and a Unix socket for local ones. They share one set of
instances: the same identity and instance name refer to the same plugin, no
matter which listener the host came through. A runner may use only one JWT
issuer across all its listeners.

## Next

- [Choose transport and authentication](../transport-auth/) to pick mTLS, bearer
  or JWT, and to understand the warnings.
- [Restarts, replacements and stopping](../restarts/) for what happens when you
  redeploy or the network drops.
