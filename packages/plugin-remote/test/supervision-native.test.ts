import {
	Array,
	Effect,
	FileSystem,
	HashMap,
	Layer,
	Option,
	Path,
	Schedule,
	String,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel } from "@graftland/graft"

import * as Artifact from "../src/Artifact"
import * as Units from "../src/Units"

const budget = {
	total: 20000,
	startup: 3000,
	probe: 500,
	drain: 500,
	stop: 500,
	terminate: 1000,
}

it.live(
	"redeploys a crashed native unit through a supervisor Change and records the attempt (C8)",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const cache = new URL("../.cache/supervision-tests/", import.meta.url)
				.pathname
			yield* fs.makeDirectory(cache, { recursive: true })
			const directory = yield* fs.makeTempDirectoryScoped({ directory: cache })
			const artifact = yield* Artifact.capture({
				directory: new URL("./fixtures/group/", import.meta.url).pathname,
				entry: "crashing.mjs",
				store: path.join(directory, "artifacts"),
			})
			const target = Units.target({
				artifact,
				input: { directory },
				placement: "Worker",
			})
			yield* Effect.gen(function* () {
				const kernel = yield* Kernel.Kernel
				const first = yield* Change.run({
					operations: [{ _tag: "Deploy", instance: "crashing", target }],
					budget,
				})
				assert.equal(first.outcome, "Accepted")
				const restarted = yield* fs.readDirectory(directory).pipe(
					Effect.map(Array.filter(String.startsWith("started-"))),
					Effect.repeat({
						schedule: Schedule.spaced("50 millis"),
						until: (names) => names.length >= 2,
					}),
					Effect.timeout("15 seconds"),
				)
				assert.lengthOf(restarted, 2)
				const facts = yield* kernel.supervision
				const fact = Option.getOrThrow(
					Array.findFirst(facts, (f) => f.instance === "crashing"),
				)
				assert.lengthOf(fact.attempts, 1)
				assert.isFalse(fact.escalated)
				const serving = yield* kernel.units.pipe(
					Effect.map(
						Array.filter(
							(u) =>
								u.kind === "Execution" &&
								u.evidence === "Missing" &&
								HashMap.size(u.members) > 0,
						),
					),
					Effect.repeat({
						schedule: Schedule.spaced("50 millis"),
						until: (units) => units.length === 1,
					}),
					Effect.timeout("10 seconds"),
				)
				assert.lengthOf(serving, 1)
			}).pipe(
				Effect.provide(
					Kernel.layer({
						authority: "native-supervision",
						maxUnits: 4,
						instances: [{ id: "crashing", target }],
					}).pipe(Layer.provide(Units.layer)),
				),
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)
