---
title: Runners
description: Run plugins on another machine with `graft-remote serve`.
---

A **runner** is a long-running process that hosts connect to. It authenticates
each host, finds the plugin package the host names among its installed packages,
and starts a plugin process for it. Hosts never send code.

## Set up a runner

1. **Install** `@graftland/plugin-remote`, the built plugin packages and their
   dependencies in the `node_modules` of an installation directory, on Linux or
   macOS with Node.js 22.22 or later. Expose each contract through the package's
   `exports`, such as `my-plugin/contract`, and install the same package on the
   host.
2. **Write** `runner.yml` with one `remote/runner` entry.
3. **Start** the runner with `graft-remote serve --config runner.yml`.
4. **Point** the host's `remote` entry at it and run `graft start host.yml`.

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

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      url: wss://runner.example:7443
      ca: ./certs/ca.crt
      auth:
        jwt:
          token: { file: ./runner-token.txt }
    config:
      greeting: Hello
```

| Field    | Required | Default      | Meaning                                                                    |
| -------- | -------- | ------------ | -------------------------------------------------------------------------- |
| `root`   | Yes      | —            | Installation directory. Contract packages resolve from its `node_modules`. |
| `state`  | Yes      | —            | State directory, created if missing. See the rules below.                  |
| `lease`  | No       | `15 seconds` | Default [lease](../lifecycle/#leases-and-network-loss) for instances.      |
| `grace`  | No       | `5 seconds`  | Time between interrupting a plugin process and killing it.                 |
| `listen` | Yes      | —            | Listeners, one per address. See [`listen` forms](#listen-forms).           |

| Rule                       | Detail                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Paths**                  | Relative to `runner.yml`, including `root`, `state` and certificate files.                                                    |
| **Installation**           | Keep it unchanged while the runner runs. To deploy, install the new package, then restart the entry on the host.              |
| **State directory**        | On a local filesystem, used by one runner at a time, kept across restarts. A second runner fails with `StateDirectoryLocked`. |
| **Fresh state**            | Do not start an empty state directory for identities still in use elsewhere: generations would start over.                    |
| **`serve`**                | Takes only `--config`. Reads the file once; restart to apply changes. Logs go to standard error.                              |
| **Startup**                | Complete only when every listener is ready. A failure closes what was opened and exits nonzero with `StartupError`.           |
| **A listener fails later** | The runner logs `Remote listener failed`; other listeners and plugins keep running.                                           |
| **Service manager**        | Run the runner under one that stops all its descendants, such as systemd with `KillMode=control-group`.                       |

## `listen` forms

| Form                          | Fields                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `url: ws://host:port`         | No `cert` or `key`.                                                              |
| `url: wss://host:port`        | `cert` and `key`: the server certificate and key.                                |
| `unix: path`                  | The socket file to create.                                                       |
| `stdio: true`                 | `identity`, default `anonymous`. No `auth`. See [SSH and stdio](#ssh-and-stdio). |
| `transport: { name, config }` | A [custom listener](../capabilities/).                                           |

- Each element takes one transport form and at most one `auth`, from
  [Transport and authentication](../transport-auth/).
- WebSocket listeners serve one path, `/graft`, with the subprotocol
  `graft-remote.v1`. A `url` path must be empty or `/graft`. There are no other
  HTTP endpoints and no health check.
- All listeners share one set of instances, and together use at most one JWT
  issuer.

## Instances

An **instance** is the name of a plugin slot on the runner. With the host's
**identity** from authentication, it decides which plugin process a connection
belongs to. A new connection for the same identity and instance replaces the old
process, and its start gets the next
[generation](../lifecycle/#generations-and-fencing). The state directory keeps
generations per identity and instance.

| Case                                     | What to do                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Default name                             | The loader entry's `id`. Keep it stable; the loader saves generated ids in the config file.     |
| Two hosts, same identity and instance    | They replace each other. Give each host its own identity, or set a distinct `connect.instance`. |
| Two remote plugins forked from one entry | Children inherit the entry id. Set `connect.instance` on each.                                  |
| Embedded groups                          | Group ids are unique only among siblings. Check the resulting names.                            |
| `Remote.plugin` without the loader       | No entry id. Set `connect.instance`, or loading fails with `MissingInstance`.                   |

`connect.expect` pins what the runner has installed before the plugin starts:

```yaml
connect:
  url: wss://runner.example:7443
  expect:
    version: 1.4.0
```

| Field     | Compared with                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `version` | The `version` in the contract package's `package.json` on the runner.                                                         |
| `digest`  | A SHA-256 hex digest of the package's files, excluding every `node_modules`, so not its dependencies. Computed only when set. |

A mismatch fails with `PackageError`, whose message shows both values.

## SSH and stdio

A `stdio` runner speaks over standard input and output, so a host can reach it
with a command such as SSH. SSH then authenticates and encrypts.

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

Restrict the host's key to that command in the runner account's
`authorized_keys`, and connect with `command`:

```text
restrict,command="/usr/local/bin/graft-remote serve --config /srv/graft/stdio.yml" ssh-ed25519 AAAA... billing-host
```

```yaml
connect:
  command: [ssh, -T, billing@runner.example]
```

| Rule                    | Detail                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No `auth`**           | Neither `command` nor `stdio` takes `auth`, not even `none`. `identity` only names the host.                                                        |
| **One listener**        | A `stdio` listener is its runner's only listener.                                                                                                   |
| **One state directory** | Give each SSH identity its own. A second session on the same directory at the same time is refused.                                                 |
| **Session end**         | At end of input, `serve` stops the plugin, confirms its exit, releases the state directory and exits 0; on failure it exits nonzero with the cause. |
| **Clean output**        | Standard output carries protocol bytes. Use `-T` and print no banners.                                                                              |
| **Exit proof**          | SSH exiting does not prove the plugin stopped; only the runner's confirmation does.                                                                 |
