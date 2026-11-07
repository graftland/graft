---
title: Design an application
description:
  Split a problem into plugins, services, events, realms and settings by who
  owns each part and how long it lives.
---

A Graft application is easy to change when its shape matches its **lifetimes**:
the parts that can start, stop, change, fail or be replaced on their own. Find
those parts first and give each one an owner; the API calls follow from that.

## Map each part to a building block

Ask these questions of every part of the feature list:

| If the part…                                                       | Make it                                   | Read                                                      |
| ------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------- |
| Can be turned on or off, reconfigured or replaced alone            | A **plugin**, one entry in `graft.yml`    | [Plugins](../../plugins/)                                 |
| Offers a capability that other parts call                          | A **service** that its plugin publishes   | [Services](../../services/)                               |
| Cannot work at all without another part                            | A required key in `inject`                | [Dependencies](../../plugins/#dependencies)               |
| Works better with another part, and still works without it         | `Plugin.optional` in `inject`             | [Dependencies](../../plugins/#dependencies)               |
| Announces something that any number of parts may react to          | An **event**                              | [Events](../../events/)                                   |
| Needs its own instance of a service or its own handlers per tenant | A **realm**, with `isolate`               | [Realms](../../isolation/)                                |
| Is a setting that a shared service reads from its caller           | An **intercept** on a `Context.Reference` | [Intercepts](../../intercepts/)                           |
| Lives as long as the process and nobody configures it              | An **environment service** from the host  | [Services](../../services/#services-from-the-environment) |
| Is a value the operator chooses                                    | A field in the plugin's config schema     | [Config file](../../config-file/)                         |
| Must crash alone, use its own thread or run on another machine     | Still a plugin; its entry uses Remote     | [Remote](../../remote/overview/)                          |

A part that only builds one service, or wraps an existing `Layer`, is still a
plugin; write it with
[`Plugin.service` or `Plugin.layer`](../../plugins/#plugins-from-services-and-layers).

### Service or event

| Question                   | Service                                                           | Event                                                   |
| -------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| How many parts provide it? | One per key per realm. A second publisher gets `ServiceConflict`. | Any number of handlers, including none.                 |
| Must it exist first?       | Yes. A required key keeps the caller `Pending`.                   | No. A dispatch reaches the handlers that exist, if any. |
| Typical use                | A connection, a store, a client.                                  | A notice, a contribution, a filter chain.               |

When many plugins contribute the same kind of thing (commands, routes, menu
items), use an event. A service with a `register` method makes every caller
remember to call `unregister`.

The kind of contribution picks the
[dispatch function](../../events/#dispatch-an-event):

| Handlers…                                      | Dispatch with                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| Only need to hear about it                     | `Event.emit`                                                           |
| Each add a piece to one result (help lines)    | `Event.parallel`                                                       |
| Answer if they recognize the input (a command) | `Event.bail`                                                           |
| Wrap, change or stop a value (filters)         | `Event.waterfall` on an [`Event.middleware`](../../events/#middleware) |

## Where state lives

State belongs to the fork that creates it, inside `apply`. Other forks reach it
only through that fork's services or events:

```ts import.meta.vitest name="best-practices/design: where state lives"
import { Context, Effect, Ref, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

class Visits extends Context.Service<
	Visits,
	{ readonly count: Effect.Effect<number>; readonly add: Effect.Effect<void> }
>()("@acme/graft-plugin-visits/Visits") {}

const visits = Plugin.make({
	name: "app/visits",
	apply: () =>
		Effect.gen(function* () {
			const count = yield* Ref.make(0)
			yield* Graft.provide(Visits, {
				count: Ref.get(count),
				add: Ref.update(count, (n) => n + 1),
			})
		}),
})

const visitor = Plugin.make({
	name: "app/visitor",
	inject: [Visits],
	apply: () =>
		Effect.gen(function* () {
			const visits = yield* Visits
			yield* visits.add
			const count = yield* visits.count
			yield* Effect.log(`Visit ${count}`)
		}),
})

const messages = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(visits)
		yield* (yield* Graft.plugin(visitor)).await
		yield* (yield* Graft.plugin(visitor)).await
		return yield* Graft.logs.pipe(
			Stream.take(2),
			Stream.map((line) => line.message),
			Stream.runCollect,
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
messages // => [["Visit 1"], ["Visit 2"]]
```

| Rule                                                    | Why                                                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create state in `apply`, not at the top of a module     | A module-level value is shared by every fork of the plugin in every realm, and nothing releases it when a fork stops.                              |
| Expect a restart to start clean                         | A restart runs `apply` again in a new `Scope`. To keep state through a config change, return an [update function](../../plugins/#update-in-place). |
| Put durable state behind a plugin                       | Data that must outlive the process belongs in storage that a plugin opens in `apply` and flushes in a finalizer.                                   |
| Expect a Remote plugin to lose state on a config change | It [never updates in place](../../plugins/#update-in-place).                                                                                       |

## Replace bookkeeping with ownership

Every handler, service, resource and child fork belongs to the scope that
created it, so the code that a plugin system usually needs disappears:

| Hand-written approach                       | In Graft                                                                                                    | What goes wrong by hand                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A central registry and an unregister call   | `Event.on` or `Graft.provide` inside `apply`                                                                | A missed unregister leaves a handler that calls a closed part. |
| `if (client)` before using an optional part | `inject: [Client]`, or `Plugin.optional(Client)`                                                            | The check passes, then the client goes away mid-call.          |
| A startup order list                        | Each plugin waits for what it injects                                                                       | The list breaks when an operator adds or disables an entry.    |
| A module-level singleton                    | A service published by a plugin, or an environment service                                                  | It cannot be replaced, isolated or released.                   |
| Feature flags in code                       | `disabled: true` on the entry                                                                               | The disabled feature still holds its resources.                |
| Restarting the process to reconfigure       | A new `config` on the entry; [only that entry](../../config-file/#changes-while-running) updates or reloads | Every other part restarts too.                                 |
| A list kept in sync with what is loaded     | An event that every feature handles, collected on demand                                                    | The list drifts when a feature fails or is unloaded.           |

Code that catches an error only to log it and go on keeps a broken part running.
Recover where you can act, or let the fork fail and retry; see
[Effect in plugins](../effect/).

A helper that registers several things at once, such as a command and its help
line, needs no cleanup of its own: called in `apply`, everything it registers
belongs to the caller's fork.

## Size plugins

One plugin is one lifetime. Split by what changes together.

| Too large                                                                                                                 | Too small                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A config change restarts every part, unless an update function applies it.                                                | One lifetime is spread over entries that are always loaded together.     |
| A failed [background task](../../plugins/#when-a-task-fails) fails the whole activation, so unrelated parts stop with it. | Parts that share private state must publish it as a service to reach it. |
| An operator cannot turn one part off.                                                                                     | Every interaction needs a public token.                                  |

Make a client and the commands that use it two plugins when the commands change
on their own: reconfiguring or disabling a command leaves the client's
connection open. The commands inject the client's service and stop before it
goes away.

### Group entry or composing plugin

Both load several plugins as one unit. They differ in who chooses the members:

```ts import.meta.vitest name="best-practices/design: group entry or composing plugin"
import { Effect, Option, Schema, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

const notes = Plugin.make({ name: "app/notes", apply: () => Effect.void })
const storage = Plugin.make({
	name: "app/storage",
	config: Schema.Struct({ file: Schema.String }),
	apply: () => Effect.void,
})

const tenant = Plugin.make({
	name: "app/tenant",
	config: Schema.Struct({ file: Schema.String }),
	apply: (config) =>
		Effect.gen(function* () {
			yield* Graft.plugin(notes)
			yield* Graft.plugin(storage, config)
		}),
})

const trees = await Effect.runPromise(
	Effect.gen(function* () {
		yield* (yield* Graft.plugin(tenant, { file: "acorn.json" })).stable
		return yield* Stream.runHead(Graft.forks)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
trees // => Option.some([{ id: 1, name: "app/tenant", input: { file: "acorn.json" }, state: Fork.ForkState.Active(), children: [{ id: 2, name: "app/notes", input: undefined, state: Fork.ForkState.Active(), children: [] }, { id: 3, name: "app/storage", input: { file: "acorn.json" }, state: Fork.ForkState.Active(), children: [] }] }])
```

```yaml title="graft.yml"
- id: acorn
  name: acorn
  group: true
  isolate:
    "@acme/graft-plugin-notes/NoteStore": true
  config:
    - name: "@acme/graft-plugin-notes"
    - name: "@acme/graft-plugin-storage"
      config:
        file: acorn.json
```

|                        | Composing plugin                                                                       | Group entry                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Members chosen by      | The plugin's author, in `apply`                                                        | The operator, in `graft.yml`                                                   |
| Changing one member    | A new config restarts the parent and every child, unless an update function applies it | [Only that entry](../../config-file/#changes-while-running) updates or reloads |
| `isolate`, `intercept` | Options of `Graft.plugin`, computed from config                                        | Entry fields                                                                   |
| Use when               | The set is fixed: every tenant runs these two                                          | The members vary between deployments                                           |

## Where a setting belongs

Choose by who sets the value and how long it lives:

| Setting                                                            | Set by                    | Lives as long as | Put it in                                                                                                  |
| ------------------------------------------------------------------ | ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| A value for one plugin: a port, a word list, an API key            | The operator              | The entry        | A config field. Secrets use [`Schema.RedactedFromValue`](../../config-file/#types-and-secrets) and `!env`. |
| A capability every plugin may use: file system, HTTP client        | The host's author         | The process      | An environment service where `Graft.layer` is built.                                                       |
| A value a shared service reads per caller: a plan, log annotations | Whoever loads the subtree | The subtree      | An intercept on a `Context.Reference`.                                                                     |
| A separate instance of a service or handlers: per tenant           | Whoever loads the subtree | The subtree      | A realm, with `isolate`.                                                                                   |

| Pitfall                                                | Rule                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passing a tenant ID through every call                 | Intercept a reference once at the subtree, and read it where it matters.                                                                                          |
| Reading a reference when the service is built          | `apply` runs with the publisher's context. Read it inside the method's Effect, which [runs with the caller's](../../intercepts/#settings-that-follow-the-caller). |
| Setting your own reference from `graft.yml`            | Register it in the host first; [`graft start` registers only two](../../intercepts/#config-file-intercepts).                                                      |
| Expecting a realm to hide an environment service       | Realms isolate published services and events; [consumers fall back to the environment](../../isolation/#environment-fallback-and-inheritance).                    |
| An environment service that operators must reconfigure | Make it a plugin's service instead. The environment lives until the host stops.                                                                                   |

## Declare tokens in a shared module

Put every service key, event token, reference and tagged error that crosses a
plugin boundary in a module that the publisher and its consumers both import:

```ts title="tokens.ts"
import { Context, Schema, type Effect, type Option } from "effect"

import { Event } from "@graftland/graft"

export class ForecastUnavailable extends Schema.TaggedError<
	ForecastUnavailable,
	{ readonly brand: unique symbol }
>()("ForecastUnavailable", { city: Schema.String }) {}

export class Forecasts extends Context.Service<
	Forecasts,
	{
		readonly today: (
			city: string,
		) => Effect.Effect<Option.Option<string>, ForecastUnavailable>
	}
>()("@acme/graft-plugin-weather/Forecasts") {}

export const ForecastIssued = Event.make<[city: string, forecast: string]>(
	"@acme/graft-plugin-weather/ForecastIssued",
)
```

| Rule                                   | Why                                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope key strings to the package       | The string is the key's identity: two keys with the same string are one key. It is also how `graft.yml` names the key in [`inject`, `isolate` and `intercept`](../../config-file/#rules). |
| Keep implementations out of the module | Consumers then depend on the contract only. The publisher can be [replaced](../../replace/) or [moved to another process](../../remote/overview/) without touching them.                  |
| Put expected failures in method types  | Callers see which errors they must handle, and a Remote contract can carry them.                                                                                                          |
| Make remote methods coarse             | Each Remote call crosses a connection. One call that takes a batch costs far less than many small ones; see [What a Remote boundary costs](../production/#what-a-remote-boundary-costs).  |
| Define values only                     | Importing the module must perform no I/O, like any [plugin module](../../plugins/#plugin-modules).                                                                                        |

To ship tokens and plugins as an npm package, see
[Plugin packages](../packaging/).

## Worked example: a chat bot

The
[`chat-bot` sample](https://github.com/graftland/graft/tree/main/samples/chat-bot)
has `/roll`, `/weather <city>`, `/help` that lists the loaded commands, and a
moderation filter with an editable word list:

| Part              | Becomes                                                   | Why                                                                                     |
| ----------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Incoming messages | Middleware event `Inbound`, run with `Event.waterfall`    | Filters can wrap, change or stop a message before any command sees it.                  |
| Commands          | Event `Command`, answered with `Event.bail`               | The first command that recognizes the name answers.                                     |
| Help lines        | Event `Describe`, collected with `Event.parallel`         | Each command contributes its own line, so `/help` is never out of date.                 |
| Moderation        | A plugin with an `Inbound` handler and an update function | A new word list applies in place; an invalid one fails only moderation.                 |
| Weather client    | A plugin that publishes `Forecasts`, run with Remote      | It owns a connection, and a crash in its SDK takes down only its process.               |
| `/weather`        | A plugin with `inject: [Forecasts]`                       | It runs only while a client exists, stops before it, and catches `ForecastUnavailable`. |
| `/roll`, `/help`  | One plugin each                                           | Each is turned on and off on its own.                                                   |

The other two samples apply the same questions:

| Sample                                                                              | Shows                                                                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [`market-feed`](https://github.com/graftland/graft/tree/main/samples/market-feed)   | A pipeline of services. Consumers wait in `Pending`, a failed reader withdraws the chain, and a `retry` schedule rebuilds it.  |
| [`saas-tenants`](https://github.com/graftland/graft/tree/main/samples/saas-tenants) | One composing plugin per tenant, a realm for each tenant's store, and one shared quota service that reads an intercepted plan. |

## Design review

A design is ready when every rule holds:

- Every part maps to a plugin, service, event, realm, intercept, environment
  service or config field.
- Every piece of state has one owning fork. Others reach it through a service or
  an event.
- Every resource has a scope, and every background fiber uses `Plugin.fork`.
- Every interaction between plugins is a token with a package-scoped key, in a
  shared module. No code keeps a registry, checks for a part or orders startup.
- Every expected failure has a place that recovers from it. Every other failure
  fails its fork, with a `retry` schedule where trying again helps.
- Every setting is a config field, an environment service, an intercept or a
  realm, chosen by who sets it and how long it lives.
- Every plugin is one lifetime: its parts change, fail and restart together.
