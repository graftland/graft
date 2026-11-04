# Realms and intercepts

| You want a subtree to…                                 | Use                        |
| ------------------------------------------------------ | -------------------------- |
| Have its own instance of a service or its own handlers | A realm (`isolate`)        |
| Read a different setting from the same shared service  | An intercept (`intercept`) |

Both are options of `Graft.plugin` and fields of a `graft.yml` entry, and apply
to the fork and everything below it.

## Realms

By default the whole app is one realm. `isolate` gives a fork its own realm for
the listed keys:

```ts
const tenants = Plugin.make({
	name: "tenants",
	apply: () =>
		Effect.gen(function* () {
			yield* Graft.plugin(tenant, { name: "a" }, { isolate: [Database] })
			yield* Graft.plugin(tenant, { name: "b" }, { isolate: [Database] })
		}),
})
```

- Each `tenant` subtree publishes and sees only its own `Database`; outside
  publications are hidden both ways. Other keys are shared as usual.
- `isolate` takes service keys and event tokens.
- `[[Database, "staging"]]` puts forks anywhere in the tree into one shared
  realm named `staging`.
- Environment services (from the `Graft.layer` environment) are not isolated;
  consumers in an empty realm fall back to them.

In `graft.yml`: `isolate: { "<key string>": true }` for a private realm, or a
label string for a shared one.

## Intercepts

An intercept changes a `Context.Reference` (a key that always has a value) for a
subtree. Use it for settings a shared service reads from its caller:

```ts
export const Formal = Context.Reference<boolean>("@acme/greeter/Formal", {
	defaultValue: () => false,
})

// Inside the Greeter service: read the caller's setting per call.
const greet = (name: string) =>
	Effect.flatMap(Formal, (formal) =>
		Effect.log(formal ? `Good day, ${name}.` : `Hi, ${name}!`),
	)
```

```ts
const formal = Plugin.make({
	name: "formal",
	apply: () =>
		Graft.plugin(welcome, undefined, {
			intercept: [Graft.intercept(Formal, () => true)],
		}).pipe(Effect.asVoid),
})
```

The function receives the outer value, so intercepts nest:
`(outer) => ({ ...outer, timeout: 1000 })`. Effect's own settings are references
too, such as `References.CurrentLogAnnotations`.

### From `graft.yml`

A config file can set only references the host registered. `graft start`
registers two:

```yaml
- id: api
  name: ./plugins/api.mjs
  intercept:
    effect/References/CurrentLogAnnotations:
      component: api
    effect/References/MinimumLogLevel: Warn
```

For your own references, register them in the host environment before the loader
starts:

```ts
const references = Intercept.layer([
	Intercept.make(
		Settings,
		Schema.Struct({ color: Schema.optionalKey(Schema.String) }),
		(outer, patch) => ({ ...outer, ...patch }),
	),
])
```

An unregistered key fails the entry with `UnregisteredReference`; an invalid
value with `InvalidIntercept`.
