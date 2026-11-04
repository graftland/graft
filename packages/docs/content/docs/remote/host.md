---
title: Host
description: Use this page when loading a remote plugin from YAML or TypeScript.
---

Use this page when loading a remote plugin from YAML or TypeScript. It covers
the contract, connection settings, and services that cross the boundary.

## Define a contract

The host imports only the contract. Its `module` points to a separate
implementation, which exports a normal Graft plugin. Build both to JavaScript
before starting a child or worker; neither uses the host's TypeScript loader.

```ts title="contract.ts"
import { Contract } from "@graftland/plugin-remote"
import { Schema } from "effect"

export const config = Schema.Struct({ greeting: Schema.String })
export const contract = Contract.make({
	name: "greeter",
	config,
	module: new URL("./worker.js", import.meta.url).href,
})
```

```ts title="worker.ts"
import { Plugin } from "@graftland/graft"
import { Effect } from "effect"
import { config } from "./contract.js"

export default Plugin.make({
	name: "greeter",
	config,
	apply: ({ greeting }) => Effect.log(greeting),
})
```

Export the contract as `contract` or `default`. Config must encode as JSON;
contract codecs must not require services. Declare expected failures with the
contract's optional `error` schema; it defaults to `Schema.Never`.

## Load it from YAML or TypeScript

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect:
      local: {}
    config:
      greeting: Hello
```

Run `graft start`. No capability entries or service-key strings are needed. For
a Node worker, replace `local: {}` with `worker: {}`. The TypeScript form uses
the same `connect` data and business `config`:

```ts title="entry.ts"
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
	config: { greeting: "Hello" },
	shutdownTimeout: "5 seconds",
})
```

Load it with `Graft.plugin(entry)`. `contractModule` identifies the contract for
the child or runner; it is distinct from the contract's implementation `module`.
A custom host supplies `NodeServices.layer` and `SecureRandom.layerWebCrypto`
where it builds `Graft.layer`. The CLI supplies them. You can also provide the
loader's `ModuleResolver` and `ConfigDirectory` in that environment.

For a runner connection, install the contract package on both machines:

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      url: !env RUNNER_URL
      ca: ./certs/ca.crt
      auth:
        mtls:
          cert: ./certs/client-billing.crt
          key: ./certs/client-billing.key
      lease: 30 seconds
    config:
      greeting: Hello
```

Set `RUNNER_URL` to `wss://runner.example:7443`, then run
`graft start --config host.yml`. Paths are relative to the containing config
file, not the process working directory. Certificates, keys, and CA strings are
file paths. Token strings are values; use `{ file: "./token.txt" }` to read a
file. Each location allows exactly one transport and one auth form.

`connect` also accepts `unix: /run/graft.sock`,
`command: [ssh, runner.example, graft-remote, serve, --config, /srv/stdio.yml]`,
`local: { command: [node, /path/to/bin.js] }`, or `worker: { execArgv: [] }`.
Command connections accept optional `cwd` and `env` fields.

TS additionally accepts credential Effects, read once for each connection:

```ts
import { Config } from "effect"

Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		url: "wss://runner.example:7443",
		instance: "greeter",
		auth: { jwt: { token: Config.Redacted("RUNNER_TOKEN") } },
	},
	config: { greeting: "Hello" },
})
```

A service-backed token can be `{ inject: [Vault], read: Vault.pipe(...) }` in
place of that Effect. Token Effects return `Redacted<string>`; an mTLS Effect
returns `{ cert: string, key: Redacted<string> }` containing PEM. Remote owns a
credential child plugin with those dependencies. Withdrawing one stops the
proxy. `retry` belongs on `Remote.plugin`; calls are not automatically retried.

| `connect` option | Default and meaning                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance`       | Loader entry id; an explicit value overrides it. Neither available: `MissingInstance`.                                                                                                                  |
| `lease`          | Runner default, normally 15 seconds. A host value overrides it for this instance.                                                                                                                       |
| `margin`         | 5 seconds beyond the lease to wait for exit confirmation.                                                                                                                                               |
| `expect`         | No checks. `{ version, digest }` can enforce either or both package checks before activation. Digest covers package files except `node_modules`, not dependencies, and is computed only when requested. |

The loader persists entry ids in YAML. Keep them across restarts. Child plugins
inherit `Entry.CurrentId`: two runner proxies forked from one entry need
distinct explicit instances or they replace each other. Embedded `Group.Group`
ids are only unique among siblings. Hosts sharing an authenticated identity and
instance name share the same runner slot too.

## Custom capabilities

For a custom capability, use
`connect.transport: { name: "my-connector", config: {...} }` and
`connect.auth: { name: "my-credentials", config: {...} }`. Names follow the
application's loader rules; see [capability plugins](../capabilities/).

## Share services

Use `Contract.service(key, rpcGroup, { toHandlers, fromClient })` to describe a
service, then list it in `Contract.make`:

- `inject`: host services the implementation needs.
- `provides`: services the implementation publishes to host consumers.

Only declared services cross the boundary. Keys and RPC schemas must match;
service keys must be unique within a contract, but RPC method names can repeat
across services. The
[sample contract](https://github.com/graftland/graft/blob/main/samples/06-remote/src/contract.ts)
shows how `fromClient` maps `RpcClientError` into a service's own error.

Consumers finish before normal provider withdrawal, so their finalizers can
still call a healthy remote service. A withdrawn host dependency stops the proxy
until the dependency returns. Withdrawal of a child's exported service stops
host consumers. Connection failure can interrupt calls and finalizers.

## Hot reload

Reloading a host entry replaces its execution; runner generations advance after
confirmed exit. **Restart the host after changing a contract.** Raw contract
imports do not participate in HMR. Runner implementation modules are outside the
host HMR graph: deploy them on the runner, then restart the proxy.

See [replacement, leases, and stopping](../lifecycle/) for shutdown deadlines
and failure reporting.
