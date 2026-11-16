# Isolation: realms and intercepts

Most mounts share one set of services. When two instances of the same layers
must run side by side, or a shared service needs per-caller settings, use realms
and intercepts instead of copying code.

## Realms with `isolate`

A realm is a separate namespace for service keys. Mounting the same layer with
`isolate: [Key]` gives that key its own realm:

```ts
const program = Effect.gen(function* () {
	const tenant = yield* Graft.mount(tenantLayer, {
		name: "tenant-a",
		requires: [Database],
		isolate: [Database],
	})
})
```

- Each unlabelled `isolate` creates a private realm below that mount. The same
  key in two mounts is two independent providers.
- Pass a label to share one realm across mounts:
  `isolate: [[Database, "tenant-a"]]`. Every mount using that label joins the
  same realm.
- Isolation applies to what the mount publishes and to what it reads: a consumer
  below the mount resolves the isolated key to that realm's provider.
- Isolation is about visibility, not permissions. For a security boundary, use a
  process or a container.

## Intercepts

An intercept adjusts a `Context.Reference` for one mount and everything below
it. Use it for a per-caller setting layered over one shared service:

```ts
const program = Effect.gen(function* () {
	yield* Graft.mount(apiLayer, {
		intercept: [
			Graft.intercept(RequestContext, (outer) => ({
				...outer,
				region: "eu",
			})),
		],
	})
})
```

- `Graft.intercept(reference, f)` runs `f` on the outer value in this subtree
  only; siblings and parents are unaffected.
- References still need a default. The intercept only transforms the value.
- Prefer a publication for a setting that applies to the whole graph; prefer an
  intercept when different subtrees need different values of the same reference.

## Choosing

| The variation is…                     | Use                                      |
| ------------------------------------- | ---------------------------------------- |
| A whole set of services per tenant    | `isolate` on the tenant mount            |
| Shared services, per-subtree settings | `intercept` on a `Context.Reference`     |
| One setting for the entire graph      | `Graft.publish` of a config service      |
| Fixed for the process                 | An environment service in the host layer |

Do not reach for a realm when plain layering works: every isolated key is a
separate provider to build and tear down.
