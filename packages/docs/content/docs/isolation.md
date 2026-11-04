---
title: Realms and isolation
description: Give part of the plugin tree its own services and events.
---

Realms control which services and events a fork can see. Use them to run
separate instances side by side, such as one set of services per tenant. To
change a setting instead, see [Intercepts](../intercepts/).

The `isolate` option of `Graft.plugin` applies to the fork and everything below
it.

Realms are a **visibility** boundary inside one process: they decide what a fork
can see, not where its code runs. To move a plugin's code into a child process,
a worker or another machine, use [Remote](../remote/overview/), which draws an
**execution** boundary instead. Neither limits what the plugin's code may do;
for that, run a Remote runner in a container or a VM.

## Realms

Every service key and event belongs to a **realm**. By default, the whole
application is one realm: a service published anywhere is visible everywhere,
and an event reaches every handler.

The `isolate` option gives a fork, and everything below it, its own realm for
some keys:

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

Here, each `tenant` fork can publish its own `Database`.

- Plugins inside each fork see only that fork's `Database`.
- A `Database` published outside is not visible inside, and the other way round.
- Keys that are not isolated are shared as usual.

`isolate` takes anything with a `key`: a service key such as `Database`, or an
[event](../events/).

### Shared realms

A label puts forks into one shared realm instead of a private one:

```ts
const staging = Effect.gen(function* () {
	yield* Graft.plugin(api, undefined, { isolate: [[Database, "staging"]] })
	yield* Graft.plugin(worker, undefined, { isolate: [[Database, "staging"]] })
})
```

`api` and `worker` share the `Database` of the `staging` realm, wherever they
are in the tree. They do not see a `Database` published in any other realm.

Rules for labels:

- A label and a service or event key are separate parts of identity. Graft
  treats each as a complete string, including embedded NUL characters.
- A label that begins with `#` or `@` does not address a private realm.
- The empty label names a shared realm. It is different from the default root
  realm.

### Environment fallback and inheritance

Realms isolate published services. They do not isolate ambient services from the
environment where `Graft.layer` was built.

| Question                                                          | Answer                                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A realm has no provision for an injected key. What happens?       | Its consumers may use the ambient value.                                                                                      |
| Does publishing in realm A restart ambient consumers in realm B?  | No. Neither does withdrawing.                                                                                                 |
| Do a parent's provisions pass to children through Effect context? | No. Each child must declare its own `inject` to get provisions in its own realm.                                              |
| Do values inherited from the environment stay available?          | Yes. If a parent's provision hid a root environment value, the child can use that fallback again, across several generations. |
