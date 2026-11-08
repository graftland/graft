import {
	Array,
	Cause,
	Effect,
	Fiber,
	FileSystem,
	HashSet,
	Layer,
	Option,
	Path,
	Schedule,
	Schema,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Kernel } from "@graftland/graft"

import * as Artifact from "../src/Artifact"
import * as Units from "../src/Units"
import { budget, stage } from "./native-unit-fixture"

const configuration = Effect.fnUntraced(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = new URL("../.cache/unit-configuration", import.meta.url).pathname
	yield* fs.makeDirectory(root, { recursive: true })
	const directory = yield* fs.makeTempDirectoryScoped({ directory: root })
	const api = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
		new URL("../dist/Configuration.js", import.meta.url).href,
	)
	yield* fs.writeFileString(
		path.join(directory, "package.json"),
		'{"type":"module"}',
	)
	yield* fs.writeFileString(
		path.join(directory, "index.mjs"),
		`
import { isMainThread } from "node:worker_threads";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { Options } from ${api};
const Setting = Context.Reference("unit-configuration/Setting", { defaultValue: () => "unset" });
export default Layer.effect(Setting, Effect.gen(function* () {
  if (isMainThread && process.send === undefined) return yield* Effect.die("Configuration evaluated on the kernel thread");
  const options = yield* Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.String, expected: Schema.optionalKey(Schema.String), marker: Schema.optionalKey(Schema.String), blocked: Schema.optionalKey(Schema.Boolean) }))(yield* Options);
  if (options.marker !== undefined) { const fs = yield* FileSystem.FileSystem; yield* fs.writeFileString(options.marker, "entered"); }
  if (options.blocked) yield* Effect.sync(() => { while (true) {} });
  const outer = yield* Setting;
  if (options.expected !== undefined && options.expected !== outer) return yield* Effect.die("Incorrect inherited configuration");
  return outer + ":" + options.value;
}));
`,
	)
	return yield* Artifact.capture({
		directory,
		module: "index.mjs",
		store: path.join(root, "artifacts"),
	})
})

it.live(
	"binds native configuration code and order into the target's authorization identity (F2)",
	() =>
		Effect.gen(function* () {
			const artifact = yield* stage("none")
			const module = yield* configuration()
			const base = {
				artifact,
				input: { mode: "test" },
				placement: "Worker",
			} satisfies Units.TargetOptions
			const first = {
				artifact: module,
				export: "default",
				options: { value: "one" },
			}
			const second = { artifact, export: "default", options: { value: "two" } }
			assert.notEqual(
				Units.target(base).identity,
				Units.target({ ...base, environment: [first] }).identity,
			)
			assert.notEqual(
				Units.target({ ...base, environment: [first] }).identity,
				Units.target({ ...base, environment: [second] }).identity,
			)
			assert.notEqual(
				Units.target({ ...base, environment: [first, second] }).identity,
				Units.target({ ...base, environment: [second, first] }).identity,
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)

it.live(
	"constructs ordered unit-local configuration modules and includes options in validation identity (F2)",
	() =>
		Effect.gen(function* () {
			const artifact = yield* stage("none")
			const module = yield* configuration()
			const target = Units.target({
				artifact,
				input: { mode: "test" },
				placement: "Worker",
				environment: [
					{ artifact: module, export: "default", options: { value: "parent" } },
					{
						artifact: module,
						export: "default",
						options: { value: "child", expected: "unset:parent" },
					},
				],
			})
			yield* Effect.gen(function* () {
				const kernel = yield* Kernel.Kernel
				const baseline = yield* kernel.inspect({
					instance: "a",
					target: Units.target({
						artifact,
						input: { mode: "test" },
						placement: "Worker",
					}),
					budget,
				})
				const inspected = yield* kernel.inspect({
					instance: "a",
					target,
					budget,
				})
				assert.equal(inspected.exitEvidence, "Exited")
				assert.isTrue(
					Option.isSome(inspected.result),
					Cause.pretty(inspected.cause),
				)
				if (
					Option.isSome(baseline.result) &&
					baseline.result.value._tag === "Described" &&
					Option.isSome(inspected.result) &&
					inspected.result.value._tag === "Described"
				) {
					assert.notEqual(
						inspected.result.value.description.environment,
						baseline.result.value.description.environment,
					)
				}
				const units = yield* kernel.units
				assert.isTrue(Array.every(units, (unit) => unit.evidence === "Exited"))
			}).pipe(
				Effect.provide(
					Kernel.layer({
						authority: "configuration",
						maxUnits: 3,
						instances: [{ id: "a", target }],
					}).pipe(Layer.provide(Units.layer)),
				),
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)

it.live(
	"rejects an invalid unit-local patch before admission and retains native exit evidence (F2)",
	() =>
		Effect.gen(function* () {
			const artifact = yield* stage("none")
			const module = yield* configuration()
			const target = Units.target({
				artifact,
				input: { mode: "test" },
				placement: "Worker",
				environment: [
					{ artifact: module, export: "default", options: { value: 42 } },
				],
			})
			yield* Effect.gen(function* () {
				const kernel = yield* Kernel.Kernel
				const result = yield* kernel
					.inspect({ instance: "a", target, budget })
					.pipe(Effect.exit)
				assert.equal(result._tag, "Failure")
				const preparations = yield* kernel.inspections
				assert.lengthOf(preparations, 1)
				assert.isTrue(
					Array.every(
						preparations,
						(p) => p.exitEvidence === "Exited" && Option.isSome(p.result),
					),
				)
			}).pipe(
				Effect.provide(
					Kernel.layer({
						authority: "invalid-configuration",
						maxUnits: 3,
						instances: [{ id: "a", target }],
					}).pipe(Layer.provide(Units.layer)),
				),
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)

for (const placement of [
	"Worker",
	"Process",
] satisfies ReadonlyArray<Kernel.Placement>) {
	it.live(
		`terminates a ${placement} blocked in an intercept Layer while public kernel queries remain responsive (I1, F2)`,
		() =>
			Effect.gen(function* () {
				const artifact = yield* stage("none")
				const module = yield* configuration()
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped({
					directory: new URL("../.cache/unit-configuration", import.meta.url)
						.pathname,
				})
				const marker = `${directory}/entered`
				const target = Units.target({
					artifact,
					input: { mode: "test" },
					placement,
					environment: [
						{
							artifact: module,
							export: "default",
							options: { value: "child", marker, blocked: true },
						},
					],
				})
				yield* Effect.gen(function* () {
					const kernel = yield* Kernel.Kernel
					const pending = yield* kernel
						.inspect({
							instance: "a",
							target,
							budget: { ...budget, startup: 2000 },
						})
						.pipe(Effect.exit, Effect.forkScoped)
					yield* fs.exists(marker).pipe(
						Effect.repeat({
							while: (exists) => !exists,
							schedule: Schedule.spaced("10 millis"),
						}),
						Effect.timeout("5 seconds"),
					)
					const unknown = yield* kernel.get("unrelated")
					assert.isTrue(Option.isNone(unknown))
					const result = yield* Fiber.join(pending)
					assert.equal(result._tag, "Failure")
					const preparations = yield* kernel.inspections
					assert.lengthOf(preparations, 1)
					assert.equal(preparations[0]?.exitEvidence, "Exited")
					assert.equal(
						HashSet.size(
							preparations[0]?.unconfirmedUnits ?? HashSet.make("missing"),
						),
						0,
					)
					const units = yield* kernel.units
					assert.lengthOf(units, 1)
					assert.equal(units[0]?.progress, "DescribeEnvironment")
					assert.equal(units[0]?.evidence, "Exited")
				}).pipe(
					Effect.provide(
						Kernel.layer({
							authority: "blocked-configuration",
							maxUnits: 3,
							instances: [{ id: "a", target }],
						}).pipe(Layer.provide(Units.layer)),
					),
				)
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		15000,
	)
}
