import { Effect, Option, Stream } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Group } from "../src/index"
import { fixture, run } from "./utils"

it.effect(
	"loads anonymous embedded entries and keeps existing activations on insertion",
	() =>
		run({ worker: fixture("worker"), other: fixture("other") })((journal) =>
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
			const start = run({ worker: fixture("identity"), host: fixture("host") })(
				(journal) =>
					Effect.gen(function* () {
						const fork = yield* Graft.plugin(Group.Group, [{ name: "worker" }])
						yield* fork.stable
						return yield* journal.events
					}),
			)
			const first = yield* start
			const second = yield* start
			assert.lengthOf(first, 1)
			assert.deepEqual(first, second)
			const all = yield* run({
				worker: fixture("identity"),
				host: fixture("host"),
			})((journal) =>
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
					return yield* journal.events
				}),
			)
			assert.lengthOf(all, 3)
			assert.notEqual(all[0], all[1])
			assert.notEqual(all[1], all[2])
		}),
)

it.effect(
	"assigns missing ids while rejecting duplicate explicit ids at the embedded group boundary",
	() =>
		run()(() =>
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
	run({ host: fixture("host"), child: fixture("child") })((journal) =>
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
