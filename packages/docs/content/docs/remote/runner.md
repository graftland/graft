---
title: Runner
description: Use this page to deploy a runner and connect hosts to it.
---

Use this page to deploy a runner and connect hosts to it. It covers installed
packages, listeners, state, and SSH access.

## Configure a runner

Install Node.js 22.22 or later on Linux or macOS, remote, the built plugin
packages, and their dependencies. The runner resolves contract package names
under `root`; the host does not upload code. Keep installations unchanged while
running. Run the runner under an external supervisor that stops all descendants
(for example systemd `KillMode=control-group`).

```yaml title="runner.yml"
- id: runner
  name: remote/runner
  config:
    root: ./installation
    state: ./state
    lease: 15 seconds
    grace: 5 seconds
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth:
          mtls:
            ca: ./certs/ca.crt
      - unix: ./runner.sock
        auth:
          none:
            identity: billing
```

```sh
graft-remote serve --config runner.yml
```

Paths in `runner.yml`, including `root`, `state`, and certificate files, are
relative to that config file, not the working directory.

`serve` accepts only `--config`. One runner entry owns its supervisor and all
its listeners; they share an instance namespace. It starts only when all
listeners are ready. A startup failure closes resources already opened; a later
listener failure leaves the others and the supervisor running. One JWT issuer is
allowed per runner, including third-party authenticators declaring an issuer.
Bearer token files do not count as issuers.

Each entry gets private capability providers. Two entries may use the same
capability with different configuration without colliding. For custom plugins,
use `transport: { name: "my-listener", config: {...} }` or
`auth: { name: "my-authenticator", config: {...} }`. Names use the application's
loader resolution rules. Built-in forms expand to the same references.

`state` must be on a local filesystem and owned by one running supervisor.
Preserve it across restarts; it records generations and unfinished executions.
Do not reuse an active deployment's identity with an empty state directory.

See [transport and authentication](../transport-auth/) for certificates, auth
configuration, and WARNs; [replacement and stopping](../lifecycle/) describes
lease and grace deadlines.

## Stdio sessions

For stdio, use one `listen` element: `{ stdio: true, identity: billing }`. It
cannot share a runner with another listener. Stdout is protocol bytes; logs go
to stderr. EOF stops executions, confirms exit, releases the state lock, then
exits 0. Failure preserves the cause and exits nonzero. Concurrent invocations
with the same state directory fail. Use SSH `authorized_keys` forced commands
for authentication. SSH exit alone is not proof that the remote execution
exited.

## Connect through SSH

Install the plugin package on the runner and give this SSH identity its own
state directory. Use a stdio-only configuration:

```yaml title="stdio.yml"
- id: runner
  name: remote/runner
  config:
    root: /srv/graft/installation
    state: /srv/graft/state/billing
    listen:
      - stdio: true
        identity: billing
```

On the host, use the command form in `connect` (the same array works in YAML):

```ts
Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		command: ["ssh", "-T", "billing@runner.example"],
		instance: "greeter",
	},
	config: { greeting: "Hello" },
})
```

In the runner account's `authorized_keys`, restrict that key to the fixed
command. Replace the executable path and key with your deployment's values:

```text
restrict,command="/usr/local/bin/graft-remote serve --config /srv/graft/stdio.yml" ssh-ed25519 AAAA... billing-host
```

Do not allocate a terminal or print banners to stdout: it carries protocol
bytes. SSH authenticates the host; `identity` supplies its stable runner name. A
second concurrent invocation with this state directory is refused. SSH exit
alone does not confirm that the execution unit has stopped.
