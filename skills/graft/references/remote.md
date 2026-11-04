# Remote: run a plugin in another process

`@graftland/plugin-remote` runs one plugin in a child process, a Node worker or
on another machine, while the host keeps its services in the plugin tree.
Consumers still `inject` the same keys; only the provider's `graft.yml` entry
changes. Exact behavior: `https://graftland.github.io/graft/remote/overview/`.

## When to reach for it

| The user wants…                                                    | Use                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| A crash, leak or blocked event loop in one plugin to spare the app | `connect: { local: {} }`, a child process                        |
| CPU-bound work on another thread                                   | `connect: { worker: {} }`, a Node worker                         |
| A plugin next to data, hardware or a network on another machine    | A runner (`graft start runner.yml`) and `url`, `unix`, `command` |
| Separate instances or settings inside one process                  | Not Remote: a [realm](realms.md) or an intercept                 |
| A permission or security boundary                                  | Not Remote alone: run the runner in a container or a VM          |

Remote isolates execution, not permissions. Every call becomes RPC, config must
encode to JSON, and a call that fails because the connection broke is not
retried. Do not move a plugin without one of the reasons above.

## Split the plugin

The host must not import the implementation. Put what both sides agree on in a
**contract** module, and leave the plugin itself unchanged:

```ts
// src/contract.ts: imported by the host and by the plugin process
import { Contract } from "@graftland/plugin-remote"

export const config = Schema.Struct({ greeting: Schema.String })

const greeter = Contract.service(Greeter, api, {
	toHandlers: (service) => ({ Greet: ({ name }) => service.greet(name) }),
	fromClient: (client) => ({
		greet: (name) =>
			client.Greet({ name }).pipe(
				// A broken connection becomes the service's own error.
				Effect.catchTag("RpcClientError", (cause) =>
					GreetingUnavailable.make({ cause }),
				),
			),
	}),
})

export const contract = Contract.make({
	name: "greeter",
	config,
	module: new URL("./greeter.js", import.meta.url).href,
	provides: [greeter],
})
```

- `api` is an Effect `RpcGroup` listing the service's calls. `fromClient` maps
  `RpcClientError` into an error callers already handle.
- `provides` lists services the plugin publishes to the host; `inject` lists
  host services it uses. Only listed services cross the boundary.
- `error` is optional and defaults to `Schema.Never`. Leave the contract
  unannotated; its type is inferred.
- `module` and the entry's `contract` point at **built JavaScript**. The plugin
  process does not use the host's TypeScript loader, so build both modules
  before running.
- The implementation imports `config` and the service key from the contract and
  stays an ordinary `Plugin.make` default export.

## Load it

In `graft.yml`, replace only the provider's entry; `name: remote` resolves to
`@graftland/plugin-remote`, which the app must depend on:

```yaml
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect: { local: {} } # or { worker: {} }, or a runner below
    config: { greeting: Hello }
```

From code, `Remote.plugin(contract, { contractModule, connect, config })` builds
the same plugin; load it with `Graft.plugin`. Only this form takes `retry` and
`shutdownTimeout`. When embedding, provide `NodeServices.layer` and
`SecureRandom.layerWebCrypto`; `graft start` already does.

## Through a runner

On the other machine, install the plugin package under the runner's `root` (the
host never uploads code), write `runner.yml` and start it:

```yaml
# runner.yml, started with: graft start runner.yml
- id: runner
  name: remote/runner
  config:
    root: ./installation
    state: ./state
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth: { bearer: { tokens: ./tokens.json } }
```

The host's `connect` becomes `url: wss://runner:7443` with
`auth: { bearer: { token: { file: ./token } } }`, plus `ca` for a private CA;
`contract` must then be a package name. `connect` also takes `unix` or `command`
(such as SSH), and `auth` takes `mtls`, `bearer`, `jwt` or `none`; leaving
`auth` out means none. The entry's `id` names the runner instance. Use
`graft start runner.yml`; a stdio runner requires `--stdio`, which reserves
stdout for protocol bytes. Enable certificate commands with
`graft add --plugin remote`, then run `graft remote certificates`.

## What changes for the app

- A config or `connect` edit restarts the plugin process; there is no update in
  place.
- Contract and implementation modules are not hot-replaced. After changing the
  contract, rebuild and restart the host.
- Callers see a declared error, `Contract.UndeclaredFailure`, `RemoteError`
  (Remote itself failed; read `cause`) or `RemoteWithdrawn` (normal during
  stops). Defects stay defects.

Test across the boundary as the samples do: load the remote plugin in a fresh
runtime, call the service from a consumer, dispose the provider, and check that
unrelated plugins keep working. `samples/06-remote` and `samples/chat-bot` show
both.
