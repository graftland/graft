import { Effect, Option, Ref, Schema, Stream } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Entry, Group } from "../src/index"
import { run } from "./utils"

it.effect(
	"loads anonymous embedded entries and keeps existing activations on insertion",
	() =>
		run((journal) => ({
			worker: Plugin.make({
				name: "worker",
				apply: () => journal.record("worker"),
			}),
			other: Plugin.make({
				name: "other",
				apply: () => journal.record("other"),
			}),
		}))((journal) =>
			Effect.gen(function* () {
				const fork = yield* Graft.plugin(Group.Group, [{ name: "worker" }])
				yield* fork.stable
				yield* journal.expect(["worker"])
				yield* fork.update([{ name: "other" }, { name: "worker" }])
				yield* fork.stable
				yield* journal.expect(["worker", "other"])
			}),
		),
)

it.effect(
	"derives the same CurrentId in separate runtimes and distinct ids under two hosts",
	() =>
		Effect.gen(function* () {
			const ids = yield* Ref.make<ReadonlyArray<string>>([])
			const worker = Plugin.make({
				name: "worker",
				apply: () =>
					Effect.flatMap(Entry.CurrentId, (id) =>
						Ref.update(ids, (values) => [...values, Option.getOrThrow(id)]),
					),
			})
			const host = Plugin.make({
				name: "host",
				config: Schema.Struct({ plugins: Entry.Entries }),
				apply: ({ plugins }) =>
					Graft.plugin(Group.Group, plugins).pipe(Effect.asVoid),
			})
			const start = run(() => ({ worker, host }))(() =>
				Effect.gen(function* () {
					const fork = yield* Graft.plugin(Group.Group, [{ name: "worker" }])
					yield* fork.stable
				}),
			)
			yield* start
			yield* start
			const first = yield* Ref.get(ids)
			assert.equal(first[0], first[1])
			yield* run(() => ({ worker, host }))(() =>
				Effect.gen(function* () {
					const fork = yield* Graft.plugin(Group.Group, [
						{
							id: "one",
							name: "host",
							config: { plugins: [{ name: "worker" }] },
						},
						{
							id: "two",
							name: "host",
							config: { plugins: [{ name: "worker" }] },
						},
						{
							id: "group",
							name: "group",
							group: true,
							config: [{ name: "worker" }],
						},
					])
					yield* fork.stable
				}),
			)
			const all = yield* Ref.get(ids)
			assert.lengthOf(all, 5)
			assert.notEqual(all[2], all[3])
			assert.notEqual(all[3], all[4])
		}),
)

it.effect(
	"assigns missing ids while rejecting duplicate explicit ids at the embedded group boundary",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const fork = yield* Graft.plugin(Group.Group, [
					{ id: "same", name: "one" },
					{ id: "same", name: "two" },
				])
				yield* fork.stable
				const state = yield* Stream.runHead(fork.state)
				assert.equal(Option.getOrThrow(state)._tag, "Failed")
			}),
		),
)

it.effect("uses each hosted child's config schema", () =>
	run((journal) => ({
		host: Plugin.make({
			name: "host",
			config: Schema.Struct({ plugins: Entry.Entries }),
			apply: ({ plugins }) =>
				Graft.plugin(Group.Group, plugins).pipe(Effect.asVoid),
		}),
		child: Plugin.make({
			name: "child",
			config: Schema.Struct({ message: Schema.String }),
			apply: ({ message }) => journal.record(message),
		}),
	}))((journal) =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(Group.Group, [
				{
					name: "host",
					config: {
						plugins: [
							{ name: "child", config: { message: "valid" } },
							{ name: "child", config: { message: 42 } },
						],
					},
				},
			])
			yield* fork.stable
			yield* journal.expect(["valid"])
			const failed = yield* Graft.logs.pipe(
				Stream.filter(
					(entry) =>
						entry.annotations["graft.plugin"] === "child" &&
						entry.level === "Error",
				),
				Stream.runHead,
			)
			assert.isTrue(Option.isSome(failed))
		}),
	),
)
