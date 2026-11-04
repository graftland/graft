# Services

## Declaring a service

A cordis service is a name on `ctx` plus a value. A Graft service is a
`Context.Service` key whose type is the service's interface:

```ts
// cordis
declare module "cordis" {
	interface Context {
		database: Database
	}
}
export class Database extends Service {
	constructor(ctx: Context) {
		super(ctx, "database")
	}
	query(sql: string) {
		/* ... */
	}
}
```

```ts
// Graft
export class Database extends Context.Service<
	Database,
	{
		readonly query: (
			sql: string,
		) => Effect.Effect<ReadonlyArray<Row>, QueryError>
	}
>()("@acme/graft-plugin-db/Database") {}
```

- The `declare module` augmentation disappears; the key carries the type.
- Methods return Effects. A method that threw or rejected fails with a tagged
  error (`Schema.TaggedError` or `Data.TaggedError`) in its error channel.
- The key string is public: config files use it in `inject` and `isolate`.

## Publishing

| cordis                                                  | Graft                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `class X extends Service` loaded with `ctx.plugin(X)`   | `Plugin.service(Key, build, { name })`                                       |
| `ctx.provide('name', value)` / `ctx.set('name', value)` | `yield* Graft.provide(Key, value)` inside `apply`                            |
| Several services from one plugin                        | Several `Graft.provide` calls, or `Plugin.layer(Layer, { provides: [...] })` |
| An existing Effect `Layer`                              | `Plugin.layer(Layer, { name, inject, provides })`                            |
| Overwriting a service someone else provides             | Not allowed: `ServiceConflict`. Use `Graft.replace` or a realm               |

`[Service.init]` (sync, async or a generator yielding disposers) becomes the
`build` effect, with its cleanup as finalizers:

```ts
export default Plugin.service(
	Database,
	Effect.gen(function* () {
		const pool = yield* Effect.acquireRelease(openPool, (pool) => pool.close)
		return { query: (sql) => pool.query(sql) }
	}),
	{ name: "database" },
)
```

`[Service.check]` (refusing to provide when a condition fails) becomes a failure
or a missing `inject` entry: let `build` fail, or depend on what it checked.

## Consuming

| cordis                             | Graft                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `ctx.database.query(...)`          | `const db = yield* Database` then `yield* db.query(...)`                               |
| `ctx.get('database')`              | `yield* Database` (declared in `inject`)                                               |
| Services read in a disposer        | Safe: a service stays usable until every consumer has stopped                          |
| `ctx.mixin('database', ['query'])` | Plain helper: `const query = (sql) => Effect.flatMap(Database, (db) => db.query(sql))` |
| `ctx.accessor(...)`                | A service, a `Context.Reference`, or a helper function                                 |

A helper that reads `Database` carries it in its requirements, so the caller
must still list `Database` in `inject`. That is the point.

## Teardown order

Both frameworks stop consumers before the provider's resources go. Graft makes
the order explicit and transactional:

1. Stop `apply`, withdraw the services.
2. Drain consumers; they restart as `Pending` or with a fallback.
3. Stop the provider's tasks, then close its scope.

So the cordis habit of guarding against a half-disposed service in consumer
cleanup can be deleted.

## Settings that differ per caller

cordis services read per-consumer settings from intercepts
(`[Service.resolveIntercept]`, `[Service.mergeIntercept]`,
`inject: { x: config }`). In Graft, put the setting in a `Context.Reference` and
read it inside the service method; the method runs in the caller's fiber, so it
sees the caller's intercepts. See [isolation](isolation.md).

## Environment services

Services that live as long as the whole application (filesystem, HTTP client,
platform) come from the environment where `Graft.layer` is built. A plugin lists
them in `inject` like any other key. The stock `graft start` provides Node's
`FileSystem`, `Path` and other platform services through `NodeServices.layer`,
so cordis `fs` plugins have no Graft counterpart to load.
