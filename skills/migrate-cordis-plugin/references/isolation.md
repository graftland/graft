# Isolation and intercepts

## Realms (`ctx.isolate`)

| cordis                                           | Graft                                                        |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `ctx.isolate('database').plugin(p, config)`      | `Graft.plugin(p, input, { isolate: [Database] })`            |
| `ctx.isolate('database', label)` (shared symbol) | `Graft.plugin(p, input, { isolate: [[Database, "label"]] })` |
| Isolating an event name                          | Put the event token in `isolate`                             |
| `isolate: { database: true }` in `cordis.yml`    | `isolate: { "<key string>": true }` in `graft.yml`           |
| `isolate: { database: 'label' }`                 | `isolate: { "<key string>": label }`                         |

Behavior to carry over and to check:

- The isolated fork and everything below it see only services of that key
  published inside the realm; outside publications are hidden both ways.
- Environment services (from the `Graft.layer` environment) are **not**
  isolated; consumers in an empty realm fall back to them.
- A label is a plain string. Labels starting with `#` or `@` do not address a
  private realm.

## Per-subtree settings (`ctx.intercept`)

cordis attaches a config object to a service name for one subtree
(`ctx.intercept('http', { timeout: 1000 })`, or
`inject: { http: { timeout: 1000 } }`), and the service merges intercepts with
`[Service.mergeIntercept]`.

In Graft the setting is a `Context.Reference` owned by the service's package:

```ts
export const HttpSettings = Context.Reference("@acme/http/Settings", {
	defaultValue: () => ({ timeout: 5000 }),
})

// Inside the Http service: read the caller's setting per call.
const get = (url: string) =>
	Effect.flatMap(HttpSettings, ({ timeout }) => fetchWithTimeout(url, timeout))
```

The caller applies it to a subtree:

```ts
const crawlers = Plugin.make({
	name: "app/crawlers",
	apply: () =>
		Graft.plugin(crawler, input, {
			intercept: [
				Graft.intercept(HttpSettings, (outer) => ({ ...outer, timeout: 1000 })),
			],
		}).pipe(Effect.asVoid),
})
```

| cordis                                               | Graft                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Intercept config object                              | `Context.Reference` value                                                                  |
| `[Service.mergeIntercept]` (default `Object.assign`) | The function given to `Graft.intercept`: `(outer) => next`                                 |
| `[Service.resolveIntercept]()` in the service        | `yield* HttpSettings` inside the method                                                    |
| `intercept:` in `cordis.yml`                         | `intercept:` in `graft.yml`, only for references the host registered with `Intercept.make` |

Settings that select **which** instance a subtree uses (a different database, a
tenant's handlers) are realms, not intercepts.
