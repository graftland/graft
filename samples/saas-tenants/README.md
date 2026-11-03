# SaaS tenants

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

A notes service hosts Acorn on a free plan and Northstar on a pro plan in one
process. Every workspace runs the same `storage` and `notes` plugins, written as
if there were only one tenant. Workspaces join and leave while the others keep
serving.

## The problem

Multi-tenancy usually leaks into every layer. Either each tenant gets its own
process, or a `tenantId` is passed through every call so that storage, quota
checks, and logs pick the right tenant. To onboard a tenant at run time, you
must build its services by hand. To offboard a tenant, you must find and stop
everything that belongs to it, in the right order, without disturbing anyone
else.

## What Graft does instead

`src/hosting.ts` loads the same `tenant` plugin once per workspace:

```ts
Graft.plugin(
	tenant,
	{ file: config.file },
	{
		isolate: [NoteStore],
		intercept: [
			Graft.intercept(Tenant, () => config.id),
			Graft.intercept(Plan, () => config.plan),
			Graft.intercept(References.CurrentLogAnnotations, (outer) => ({
				...outer,
				tenant: config.id,
			})),
		],
	},
)
```

- **Isolation follows the tree.** Each tenant's `storage` publishes `NoteStore`
  into a private realm, so its `notes` plugin sees only that store. Both tenants
  can save a note with the ID `launch`, and each reads back its own. Nothing in
  `storage` or `notes` takes a tenant ID.
- **Consumers wait for their provider.** `notes` is loaded first and is
  `Pending` until its tenant's store is published. Then it starts on its own.
- **One shared service, per-tenant settings.** `Quota` is published once, at the
  root. It reads the `Plan` reference when it is called. Event handlers run in
  the context of the plugin that registered them. So the same service allows one
  note for Acorn and three for Northstar. Every log line from a tenant's plugins
  carries `tenant: <id>`.
- **Offboarding is one call.** `fork.dispose` on a tenant removes its request
  handler, stops `notes`, and only then flushes and closes its storage. The
  other tenant keeps its forks, handler, and data.

The request boundary still chooses a tenant. `request(id, command)` dispatches
with `Event.filtered`, matching the handler's `Tenant` reference. That stands in
for an authenticated API adapter. Tenant IDs stay there and in provisioning.
Realms isolate published services. They do not isolate filesystem access or
services in the root environment.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-saas-tenants start
```

The run starts from an empty `data/` directory in this package and leaves one
JSON file per tenant there. What to look for in the output:

- Step 1: `Notes Pending: waiting for this tenant's NoteStore`, then
  `Storage opened` and `Notes ready`, each with `tenant: acorn`.
- Step 2: Northstar reading `launch` gets `Missing`, although Acorn has one.
- Step 3: the second note is rejected for Acorn (`limit: 1`) and saved for
  Northstar (`limit: 3`), by the same quota service.
- Step 4: Acorn's `Notes stopped` comes before its `Storage flushed and closed`.
  Acorn then has no handler, and Northstar still returns its own note.

Storage keeps notes in memory and writes them at shutdown. It is a stand-in, not
a crash-safe database.

`devenv shell -- pnpm --filter @graftland/sample-saas-tenants test` checks each
of these claims. It uses an in-memory file system.

## Files

| File                        | What it is                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `src/services.ts`           | Note schema, service keys, the `Plan` and `Tenant` references, request and reply types. |
| `src/storage.ts`            | A tenant's notes, loaded from and flushed to its JSON file.                             |
| `src/notes.ts`              | Note operations and the request handler.                                                |
| `src/quota.ts`              | The shared quota service, reading the caller's `Plan`.                                  |
| `src/tenant.ts`             | The plugins every tenant runs.                                                          |
| `src/hosting.ts`            | Onboarding with `isolate` and `intercept`, and request routing.                         |
| `src/lifecycle.ts`          | Waits for a fork to become `Active`.                                                    |
| `src/main.ts`               | The scripted run.                                                                       |
| `test/saas-tenants.test.ts` | Tests for the behavior above.                                                           |
