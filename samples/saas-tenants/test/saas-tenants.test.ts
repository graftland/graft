import { assert, describe, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import {
	Array,
	Effect,
	FileSystem,
	HashMap,
	Layer,
	Option,
	Ref,
	Schema,
	Stream,
	type Scope,
} from "effect"
import { onboard, request } from "../src/hosting.ts"
import { ready } from "../src/lifecycle.ts"
import { notes } from "../src/notes.ts"
import { quota } from "../src/quota.ts"
import { NoteStore, NotesFile, Plan } from "../src/services.ts"

interface Disk {
	readonly files: Ref.Ref<HashMap.HashMap<string, string>>
	readonly writes: Ref.Ref<ReadonlyArray<string>>
}

const run = <A, E>(
	body: (disk: Disk) => Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
) =>
	Effect.gen(function* () {
		const files = yield* Ref.make(HashMap.empty<string, string>())
		const writes = yield* Ref.make<ReadonlyArray<string>>([])
		const filesystem = FileSystem.layerNoop({
			exists: (file) => Ref.get(files).pipe(Effect.map(HashMap.has(file))),
			readFileString: (file) =>
				Ref.get(files).pipe(
					Effect.map((entries) =>
						Option.getOrThrow(HashMap.get(entries, file)),
					),
				),
			writeFileString: (file, contents) =>
				Ref.update(files, HashMap.set(file, contents)).pipe(
					Effect.andThen(Ref.update(writes, Array.append(file))),
				),
		})
		return yield* body({ files, writes }).pipe(
			Effect.scoped,
			Effect.provide(Layer.fresh(Layer.provide(Graft.layer, filesystem))),
		)
	})

const startQuota = Effect.gen(function* () {
	const fork = yield* Graft.plugin(quota)
	yield* ready(fork)
})

const save = (tenant: string, id: string, text = "Editorial checklist") =>
	request(tenant, { _tag: "Save", note: { id, text } })

const hasMessage = (entry: Graft.LogEntry, message: string) =>
	Array.isArray(entry.message) && Array.contains(entry.message, message)

const history = Effect.gen(function* () {
	yield* Effect.log("Test observation complete")
	return yield* Graft.logs.pipe(
		Stream.takeUntil((entry) => hasMessage(entry, "Test observation complete")),
		Stream.runCollect,
	)
})

const tree = Graft.forks.pipe(Stream.runHead, Effect.map(Option.getOrThrow))

describe("SaaS tenant plugin trees", () => {
	it.effect("onboards tenants at runtime and isolates identical note IDs", () =>
		run(() =>
			Effect.gen(function* () {
				yield* startQuota
				const acorn = yield* onboard({
					id: "acorn",
					plan: "free",
					file: "acorn.json",
				})
				yield* save("acorn", "launch", "Acorn's private launch")
				const before = yield* tree
				yield* onboard({ id: "northstar", plan: "pro", file: "northstar.json" })
				const hidden = yield* request("northstar", {
					_tag: "Read",
					id: "launch",
				})
				assert.deepStrictEqual(hidden, Option.some({ _tag: "Missing" }))
				yield* save("northstar", "launch", "Northstar's private launch")
				const first = yield* request("acorn", { _tag: "Read", id: "launch" })
				const second = yield* request("northstar", {
					_tag: "Read",
					id: "launch",
				})
				assert.deepStrictEqual(
					first,
					Option.some({
						_tag: "Found",
						note: { id: "launch", text: "Acorn's private launch" },
					}),
				)
				assert.deepStrictEqual(
					second,
					Option.some({
						_tag: "Found",
						note: { id: "launch", text: "Northstar's private launch" },
					}),
				)
				const after = yield* tree
				assert.deepStrictEqual(
					Array.findFirst(after, (fork) => fork.id === acorn.id),
					Array.findFirst(before, (fork) => fork.id === acorn.id),
				)
				assert.strictEqual(after.length, 3)
				for (const fork of Array.filter(
					after,
					(fork) => fork.name === "tenant",
				)) {
					assert.deepStrictEqual(
						Array.map(fork.children, (child) => [child.name, child.state._tag]),
						[
							["notes", "Active"],
							["storage", "Active"],
						],
					)
				}
			}),
		),
	)

	it.effect(
		"keeps a root consumer Pending despite stores in tenant realms",
		() =>
			run(() =>
				Effect.gen(function* () {
					yield* startQuota
					yield* onboard({ id: "acorn", plan: "free", file: "acorn.json" })
					const outside = yield* Graft.plugin(notes)
					yield* outside.await
					const state = yield* Stream.runHead(outside.state)
					assert.deepStrictEqual(
						state,
						Option.some({ _tag: "Pending", missing: [NoteStore.key] }),
					)
					const entries = yield* history
					const lifecycle = Array.filter(
						entries,
						(entry) => entry.annotations["tenant"] === "acorn",
					)
					assert.deepStrictEqual(
						Array.map(lifecycle, (entry) =>
							Array.isArray(entry.message) ? entry.message[0] : entry.message,
						),
						[
							"Notes Pending: waiting for this tenant's NoteStore",
							"Storage opened",
							"Notes ready",
						],
					)
				}),
			),
	)

	it.effect(
		"uses one quota service with each handler's Plan and tenant log annotations",
		() =>
			run(() =>
				Effect.gen(function* () {
					yield* startQuota
					yield* onboard({ id: "acorn", plan: "free", file: "acorn.json" })
					yield* onboard({
						id: "northstar",
						plan: "pro",
						file: "northstar.json",
					})
					yield* save("acorn", "launch")
					// A pro dispatcher must not override the free handler's registration context.
					const denied = yield* save("acorn", "handoff").pipe(
						Effect.provideService(Plan, "pro"),
					)
					assert.deepStrictEqual(
						denied,
						Option.some({ _tag: "QuotaExceeded", limit: 1 }),
					)
					const edited = yield* save("acorn", "launch", "Revised checklist")
					assert.deepStrictEqual(edited, Option.some({ _tag: "Saved" }))
					for (const id of ["launch", "handoff", "support"]) {
						const reply = yield* save("northstar", id).pipe(
							Effect.provideService(Plan, "free"),
						)
						assert.deepStrictEqual(reply, Option.some({ _tag: "Saved" }))
					}
					const exhausted = yield* save("northstar", "budget")
					assert.deepStrictEqual(
						exhausted,
						Option.some({ _tag: "QuotaExceeded", limit: 3 }),
					)
					const entries = yield* history
					assert.strictEqual(
						Array.filter(entries, (entry) =>
							hasMessage(entry, "Shared quota service started"),
						).length,
						1,
					)
					const checks = Array.filter(entries, (entry) =>
						hasMessage(entry, "Quota checked"),
					)
					assert.strictEqual(checks.length, 7)
					for (const entry of checks) {
						assert.strictEqual(entry.annotations["graft.plugin"], "notes")
						const free = entry.annotations["tenant"] === "acorn"
						assert.deepStrictEqual(entry.message, [
							"Quota checked",
							{ plan: free ? "free" : "pro", limit: free ? 1 : 3 },
						])
					}
					const snapshot = yield* tree
					assert.strictEqual(
						Array.filter(snapshot, (fork) => fork.name === "quota").length,
						1,
					)
				}),
			),
	)

	it.effect(
		"offboards one tenant, removes its handler, and flushes after its consumer stops",
		() =>
			run((disk) =>
				Effect.gen(function* () {
					yield* startQuota
					const acorn = yield* onboard({
						id: "acorn",
						plan: "free",
						file: "acorn.json",
					})
					const northstar = yield* onboard({
						id: "northstar",
						plan: "pro",
						file: "northstar.json",
					})
					yield* save("acorn", "launch", "Acorn's private launch")
					yield* save("northstar", "launch", "Northstar's private launch")
					const buffered = yield* Ref.get(disk.writes)
					assert.deepStrictEqual(buffered, [])
					const before = yield* tree
					yield* acorn.dispose
					const offline = yield* request("acorn", {
						_tag: "Read",
						id: "launch",
					})
					assert.deepStrictEqual(offline, Option.none())
					const accepted = yield* save("northstar", "handoff")
					assert.deepStrictEqual(accepted, Option.some({ _tag: "Saved" }))
					const stillServing = yield* request("northstar", {
						_tag: "Read",
						id: "launch",
					})
					assert.deepStrictEqual(
						stillServing,
						Option.some({
							_tag: "Found",
							note: { id: "launch", text: "Northstar's private launch" },
						}),
					)
					const writes = yield* Ref.get(disk.writes)
					assert.deepStrictEqual(writes, ["acorn.json"])
					const files = yield* Ref.get(disk.files)
					const persisted = yield* Schema.decodeEffect(NotesFile)(
						Option.getOrThrow(HashMap.get(files, "acorn.json")),
					)
					assert.deepStrictEqual(persisted, [
						{ id: "launch", text: "Acorn's private launch" },
					])
					const after = yield* tree
					assert.deepStrictEqual(
						after,
						Array.filter(before, (fork) => fork.id !== acorn.id),
					)
					const entries = yield* history
					const stopped = Array.filter(
						entries,
						(entry) =>
							hasMessage(entry, "Notes stopped") ||
							hasMessage(entry, "Storage flushed and closed"),
					)
					assert.deepStrictEqual(
						Array.map(stopped, (entry) => [
							entry.annotations["tenant"],
							Array.isArray(entry.message) ? entry.message[0] : entry.message,
						]),
						[
							["acorn", "Notes stopped"],
							["acorn", "Storage flushed and closed"],
						],
					)
					assert.strictEqual(
						Array.filter(
							entries,
							(entry) =>
								entry.annotations["tenant"] === "northstar" &&
								hasMessage(entry, "Notes ready"),
						).length,
						1,
					)
					yield* northstar.dispose
					const finalWrites = yield* Ref.get(disk.writes)
					assert.deepStrictEqual(finalWrites, ["acorn.json", "northstar.json"])
				}),
			),
	)

	it.effect("reloads flushed notes into a new tenant fork", () =>
		run(() =>
			Effect.gen(function* () {
				yield* startQuota
				const first = yield* onboard({
					id: "acorn",
					plan: "free",
					file: "acorn.json",
				})
				yield* save("acorn", "launch", "Persisted editorial checklist")
				yield* first.dispose
				const second = yield* onboard({
					id: "acorn",
					plan: "free",
					file: "acorn.json",
				})
				assert.notStrictEqual(second.id, first.id)
				const restored = yield* request("acorn", { _tag: "Read", id: "launch" })
				assert.deepStrictEqual(
					restored,
					Option.some({
						_tag: "Found",
						note: { id: "launch", text: "Persisted editorial checklist" },
					}),
				)
			}),
		),
	)
})
