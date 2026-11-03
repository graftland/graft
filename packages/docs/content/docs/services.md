---
title: Services
description: Publish services at run time, and how Graft withdraws them safely.
---

A service in Graft is an ordinary Effect `Context` key with a value. Graft adds
two things. Services can be published and withdrawn while the application runs.
And plugins that use a service are stopped before the service goes away.

## Publish a service

Call `Graft.provide` inside `apply`:

```ts
import { Graft, Plugin } from "@graftland/graft"
import { Context, Effect } from "effect"

class Clock extends Context.Service<
	Clock,
	{ readonly now: Effect.Effect<number> }
>()("app/Clock") {}

const clock = Plugin.make({
	name: "clock",
	apply: () => Graft.provide(Clock, { now: Effect.sync(() => Date.now()) }),
})
```

The service belongs to the fork that published it. It stays available until that
fork is unloaded or restarted. A fork can publish any number of services.

Only one fork can publish a key in the same [realm](../isolation/). A second
`Graft.provide` for the same key fails with `ServiceConflict`. To swap a service
implementation, replace the plugin that publishes it, or use
[`Graft.replace`](../lifecycle/#replace-plugins).

## Use a service

List the key in `inject` and read it with `yield*`:

```ts
const uptime = Plugin.make({
	name: "uptime",
	inject: [Clock],
	apply: () =>
		Effect.gen(function* () {
			const clock = yield* Clock
			const started = yield* clock.now
			yield* Effect.addFinalizer(() =>
				Effect.flatMap(clock.now, (now) =>
					Effect.log(`Ran for ${now - started} ms`),
				),
			)
		}),
})
```

The finalizer above calls `clock` while the plugin stops. This is safe: a
service stays usable until every plugin that injects it has stopped.

## How withdrawal works

When a fork that publishes services stops, Graft follows this order:

1. Stop `apply` if it is still running.
2. In one transaction, close publication and withdraw the fork's services. No
   new consumer can lease them. This activation cannot publish again.
3. Wait until every existing consumer releases its leases. Healthy `Plugin.fork`
   tasks and their resources stay available to the finalizers of the consumers.
   Then the consumers restart. If an environment fallback exists, a consumer
   restarts with it. If not, a consumer with a required dependency becomes
   `Pending`, and a consumer with an optional dependency restarts without the
   service.
4. Stop the remaining supervised tasks and close their scopes. Wait for the
   cancellation cleanup.
5. Close the activation scope: run finalizers, stop child plugins, and remove
   event handlers.
6. Release the services the fork itself was using.

The same order applies when a task failure starts the teardown. The failed task
has already stopped. Healthy tasks continue until the consumers drain. Graft
collects any further task failures during draining, and logs them with their
complete Cause, including cleanup defects. A teardown that a failure started
includes them in the final `Failed` state. Failures of resource finalizers are
included too. They do not stop the remaining cleanup phases or the release of
dependency leases. An explicit `dispose` reports a cleanup failure as
`Fork.CleanupError`. Its `cause` keeps the original failure reasons.

During shutdown, the resources of healthy tasks and of the activation stay alive
until the leased consumers finish. The order in which the finalizers were
registered does not matter. If step 3 takes more than 10 seconds, Graft logs a
warning: two plugins may be waiting for each other.

A plugin that starts using a service holds it until the plugin stops. Graft
counts these uses in the same transaction that checks the plugin's dependencies.
So a service is never withdrawn while a plugin is half started.

## Services from the environment

Services in the environment where `Graft.layer` is built are visible to every
plugin. They can satisfy `inject`, and they live as long as that environment:

```ts
import { NodeServices } from "@effect/platform-node"

const layer = Layer.provideMerge(Graft.layer, NodeServices.layer)
```

With this layer, a plugin can inject `FileSystem.FileSystem` or `Path.Path`
directly. Use the environment for services that live as long as the whole
application.

For every key in `inject`, Graft first checks the registry in the consumer's
realm. If it finds nothing, it falls back to this environment. This applies to
required and optional dependencies alike. A consumer that uses the fallback
still watches its realm. When a new provision appears, the consumer restarts
with the published value. When the provision is withdrawn, the consumer restarts
with the environment value again. So consumers loaded before and after
publication end up with the same value. Publication does not wait for existing
consumers to finish restarting.

Use `inject` when you want this lookup and restart behavior. Reading an
undeclared key with `Effect.serviceOption` only reads the activation's context.
It does not subscribe to registry changes, and it does not take the lease of a
provision.

A `Context.Reference` in `inject` always has a fallback, so it never leaves a
plugin `Pending`. A provision in the consumer's realm wins. Otherwise Graft uses
the inherited reference value, including intercepts, or the reference's default.
It watches publication and withdrawal just like other injected keys.

## Publication cycles

Graft rejects a publication that would restart its own provider. It checks this
in the same transaction that publishes the service. First it finds the running
consumers that watch that realm and key, through an ambient fallback or an
absent optional dependency. Then it follows their descendants and the consumers
of every affected provider, until no more forks would be stopped. If the
publisher is among them, the registry stays unchanged and `Graft.provide` fails
with `ServiceConflict`. Required dependencies of `Pending` forks are waiting to
start, so they do not count as restart watchers.

The error has `reason: "SelfDependency"` for a direct self-dependency, or
`reason: "DependencyCycle"` for an indirect cycle. It also carries the
publisher's `fork` ID and the service's `realm`. When you wrap an environment
service, use separate input and output keys. A provider whose resolution a
dependency change has already invalidated also cannot publish. That error has
`reason: "Invalidated"`.

If a cycle error escapes `apply` or a `Plugin.fork` task, Graft cleans up the
publisher and it enters `Failed`. It then waits for a change in configuration,
dependencies or the graph. It does not follow its retry schedule again and again
into the same cycle. Before it retries, Graft checks the graph with the failed
fork's expected dependencies put back. Releasing the fork's leases during
cleanup does not by itself break the cycle.

Rejection does not publish a value or restart existing watchers. Normal failure
propagation still applies. A plugin that awaits a child's failure may fail
itself. Withdrawing services that the failed fork had already published affects
their consumers as usual.
