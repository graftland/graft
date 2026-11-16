# Observing the graph

Graft exposes two streams for looking at a running graph without hooking into
internals: `Graft.mounts` for topology and `Graft.logs` for output.

## The mount tree

`Graft.mounts` is a `Stream<ReadonlyArray<Mount.MountTree>>` that emits on every
change:

```ts
const status = Effect.gen(function* () {
	yield* Graft.mounts.pipe(
		Stream.runForEach((roots) =>
			Effect.log(roots.map((node) => `${node.name}: ${node.state._tag}`)),
		),
	)
})
```

`Mount.MountTree` has `id`, `name`, `state` and `children`. Mounts appear when
created and by default remain visible through withdrawal until their leases
release.

Use it for a status screen, a health report or debugging which mount is
`Pending`.

## Logs

`Graft.logs` replays up to 1000 recent entries, then streams live ones:

```ts
const follow = Effect.gen(function* () {
	yield* Graft.logs.pipe(
		Stream.runForEach((entry) => Effect.log(entry.message)),
	)
})
```

Each `LogEntry` has `date`, `level`, `message`, `cause` and `annotations`. Logs
written while building a mount carry `graft.mount` (the id) and `graft.name`.

```ts
const work = effect.pipe(Effect.annotateLogs({ "app.tenant": tenantId }))
```

- Produce entries with ordinary `Effect.log*`; the graph's logger copies them
  into `Graft.logs`.
- Annotate with `Effect.annotateLogs` to tag entries by mount, tenant or
  request.
- Filter by level or annotation in the consumer; the stream is not pre-filtered.

## Mount state vs. observation

For one mount, prefer its own handle: `mount.state` (changes), `mount.await`
(settle once), `mount.stable` (no loading below it). The tree is for whole-graph
views; the handle is for reacting to one mount.

## Health checks

A typical readiness check waits for the mounts the app needs and fails if one
fails:

```ts
const ready = Effect.gen(function* () {
	yield* Effect.forEach(mounts, (mount) => mount.await, { discard: true })
})
```

Remember that `Pending` counts as settled; inspect `state` if "ready" means
`Active`.
