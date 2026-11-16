---
title: Observability
description: Follow the mount tree and read the logs Graft collects.
---

Graft exposes the graph as two streams: the mount tree and the logs.

## The mount tree

`Graft.mounts` emits the whole tree whenever it changes. Each node has the
mount's ID, name, current state and children.

```ts import.meta.vitest name="observability: read the mount tree"
import { Context, Effect, Layer, Option, Stream } from "effect"

import { Graft, Mount } from "@graftland/graft"

class Greeting extends Context.Service<Greeting, string>()("app/Greeting") {}

const greeting = Layer.effect(Greeting, Effect.succeed("hello"))

const tree = await Effect.runPromise(
	Effect.gen(function* () {
		const mount = yield* Graft.mount(greeting, { name: "greeting" })
		yield* mount.await
		return yield* Stream.runHead(Graft.mounts)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
tree // => Option.some([{ id: 1, name: "greeting", state: Mount.MountState.Active(), children: [] }])
```

| Field      | Use                                                      |
| ---------- | -------------------------------------------------------- |
| `id`       | Identifies the mount in logs and errors.                 |
| `name`     | The `name` option, or `"layer"` for a mount without one. |
| `state`    | The same state the mount handle exposes.                 |
| `children` | Mounts created inside this mount's layer.                |

Emit the tree to a status page, a health endpoint or a debug log. A rebuild
emits a new tree with the new states.

## Logs

`Graft.logs` collects logs from the environment that uses `Graft.layer`,
including logs from the host application and from every mount.

| Behavior    | Detail                                                                          |
| ----------- | ------------------------------------------------------------------------------- |
| Replay      | A new subscriber first receives the last 1000 entries.                          |
| Annotations | Logs written while a mount builds or runs carry `graft.mount` and `graft.name`. |
| Host logs   | Keep their own annotations; the mount annotations may be absent.                |
| Levels      | The level, message, cause and annotations are all preserved.                    |

```ts
import { Effect, Stream } from "effect"

import { Graft } from "@graftland/graft"

export const recent = Graft.logs.pipe(
	Stream.map((entry) => ({
		level: entry.level,
		message: entry.message,
		mount: entry.annotations["graft.mount"],
	})),
)
```

Read logs without subscribing forever by taking what you need:

```ts
import { Effect, Stream } from "effect"

import { Graft } from "@graftland/graft"

export const errors = Stream.runCollect(
	Stream.filter(Graft.logs, (entry) => entry.level === "Error").pipe(
		Stream.take(10),
	),
).pipe(Effect.map((entries) => entries.length))
```

## Traces

Every build and every running mount is a span named `graft.mount <name>`. The
span wraps the layer's build and the work it does, so your own spans appear
under it. Log annotations use the same names, which keeps a slow build and its
log lines together in a trace viewer.

## What to watch

| Symptom                  | Where to look                                         |
| ------------------------ | ----------------------------------------------------- |
| A mount never starts     | `state` shows `Pending` with the missing keys.        |
| A mount keeps rebuilding | `state` changes and the log lines between them.       |
| A mount failed           | `state` shows `Failed`; read its `cause` in the logs. |
| Teardown is slow         | The warning about consumers still waiting.            |
