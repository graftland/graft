import { Effect, Layer, Option } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Kernel } from "@graftland/graft"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

import * as Preparation from "../src/Preparation"
import { budget, stage } from "./preparation-fixture"

const platform = Kernel.layer({
	authority: "loader-preparation",
	maxUnits: 3,
	instances: [],
}).pipe(Layer.provide(Units.layer), Layer.provideMerge(NodeServices.layer))

it.live(
	"prepares native local-only data without Loader imports or serving authority (F2)",
	() =>
		Effect.gen(function* () {
			const artifact = yield* stage()
			const control = yield* Control.serve()
			const prepare = yield* Preparation.make({ control, budget })
			const result = yield* prepare.inspect({
				instance: "new",
				module: {
					kind: "Plugin",
					artifact,
					location: new URL(
						artifact.identity.entry,
						`file://${artifact.directory}/`,
					).href,
					suffix: "",
					export: "default",
					base: artifact.directory,
					externalDependencyCoverage: "Declared",
					externalDependencies: {},
					provenance: {
						specifier: "fixture",
						source: new URL(
							artifact.identity.entry,
							`file://${artifact.directory}/`,
						).href,
					},
				},
				input: { mode: "test" },
			})
			assert.equal(result.description.artifact, artifact.identity.digest)
			assert.isUndefined(result.target.deployment?.inspection)
			const kernel = yield* Kernel.Kernel
			const units = yield* kernel.units
			assert.lengthOf(units, 1)
			assert.equal(units[0]?.kind, "Inspection")
			assert.equal(units[0]?.evidence, "Exited")
			const status = yield* kernel.get("new")
			assert.isTrue(Option.isNone(status))
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

it.live(
	"rejects executable input and unregistered intercept keys without importing application modules (F2)",
	() =>
		Effect.gen(function* () {
			const artifact = yield* stage()
			const control = yield* Control.serve()
			const prepare = yield* Preparation.make({ control, budget })
			const module = {
				kind: "Plugin",
				artifact,
				location: new URL(
					artifact.identity.entry,
					`file://${artifact.directory}/`,
				).href,
				suffix: "",
				export: "default",
				base: artifact.directory,
				externalDependencyCoverage: "Declared",
				externalDependencies: {},
				provenance: {
					specifier: "fixture",
					source: new URL(
						artifact.identity.entry,
						`file://${artifact.directory}/`,
					).href,
				},
			} satisfies Preparation.Input["module"]
			const executable = yield* prepare
				.inspect({
					instance: "new",
					module,
					input: { action: () => Effect.void },
				})
				.pipe(Effect.flip)
			assert.equal(executable._tag, "PreparationFailed")
			const unregistered = yield* prepare
				.inspect({
					instance: "new",
					module,
					input: {},
					intercept: [{ key: "missing", patch: true }],
				})
				.pipe(Effect.flip)
			assert.equal(unregistered._tag, "PreparationFailed")
			assert.equal(unregistered.reason, "UnregisteredIntercept")
			const kernel = yield* Kernel.Kernel
			const units = yield* kernel.units
			assert.lengthOf(units, 0)
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)
