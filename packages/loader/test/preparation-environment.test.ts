import {
	Array,
	Effect,
	FileSystem,
	HashMap,
	Layer,
	Option,
	Path,
	Schema,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel } from "@graftland/graft"
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

import { ModuleResolver, Preparation } from "../src/index"
import { budget } from "./preparation-fixture"

const descriptor = Effect.fnUntraced(function* (
	kind: "Plugin" | "Environment",
	artifact: Artifact.Artifact,
) {
	const path = yield* Path.Path
	const url = yield* path.toFileUrl(
		path.join(artifact.directory, artifact.identity.entry),
	)
	return ModuleResolver.Descriptor.make({
		kind,
		artifact,
		location: url.href,
		suffix: "",
		export: "default",
		base: artifact.directory,
		externalDependencyCoverage: "Declared",
		externalDependencies: {},
		provenance: { specifier: kind, source: url.href },
	})
})
const stage = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = new URL("../.cache/preparation-environment", import.meta.url)
		.pathname
	yield* fs.makeDirectory(root, { recursive: true })
	const directory = yield* fs.makeTempDirectoryScoped({ directory: root })
	const source = path.join(directory, "source")
	yield* fs.makeDirectory(source)
	const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
	const plugin = yield* quote(
		new URL("../../core/dist/Plugin.js", import.meta.url).href,
	)
	const configuration = yield* quote(
		new URL("../../plugin-remote/dist/Configuration.js", import.meta.url).href,
	)
	yield* fs.writeFileString(
		path.join(source, "package.json"),
		'{"name":"preparation-environment","version":"1.0.0","type":"module"}',
	)
	const reference = `const Setting = Context.Reference("loader/preparation-environment/Setting", { defaultValue: () => ({color:"blue",size:12}) });`
	yield* fs.writeFileString(
		path.join(source, "plugin.mjs"),
		`
import { isMainThread } from "node:worker_threads";
import { Context, Effect, FileSystem, Schema } from "effect";
import * as Plugin from ${plugin};
if (isMainThread && process.send === undefined) throw new Error("Plugin evaluated in Loader");
${reference}
const SettingSchema=Schema.Struct({color:Schema.String,size:Schema.Finite});
const Config=Schema.Struct({expected:SettingSchema,actual:SettingSchema.pipe(Schema.withDecodingDefaultKey(Setting)),marker:Schema.optionalKey(Schema.String),fail:Schema.optionalKey(Schema.Boolean)}).check(Schema.makeFilter(value=>value.expected.color===value.actual.color&&value.expected.size===value.actual.size||"Incorrect unit environment"));
export default Plugin.make({name:"prepared-environment",config:Config,apply:config=>Effect.gen(function*(){
 if(config.fail)return yield* Effect.fail("Candidate startup failed");
 if(config.marker!==undefined){const fs=yield* FileSystem.FileSystem;yield* fs.writeFileString(config.marker,config.actual.color+"/"+config.actual.size+"\\n",{flag:"a"});}
})});
`,
	)
	yield* fs.writeFileString(
		path.join(source, "environment.mjs"),
		`
import { isMainThread } from "node:worker_threads";
import { Context, Effect, Layer, Schema } from "effect";
import { Options } from ${configuration};
if (isMainThread && process.send === undefined) throw new Error("Intercept evaluated in Loader");
${reference}
const Patch=Schema.Struct({color:Schema.optionalKey(Schema.Trim),size:Schema.optionalKey(Schema.Finite)});
export default Layer.effect(Setting,Effect.gen(function*(){const patch=yield* Schema.decodeUnknownEffect(Patch)(yield* Options);const outer=yield* Setting;return {...outer,...patch};}));
`,
	)
	const store = path.join(directory, "artifacts")
	const pluginArtifact = yield* Artifact.capture({
		directory: source,
		entry: "plugin.mjs",
		store,
	})
	const environmentArtifact = yield* Artifact.capture({
		directory: source,
		entry: "environment.mjs",
		store,
	})
	return {
		module: yield* descriptor("Plugin", pluginArtifact),
		environment: yield* descriptor("Environment", environmentArtifact),
		marker: path.join(directory, "serving"),
	}
})
const runtime = (target?: Kernel.Target) =>
	Kernel.layer({
		authority: "preparation-environment",
		maxUnits: 3,
		instances: target === undefined ? [] : [{ id: "a", target }],
	}).pipe(Layer.provide(Units.layer))

it.live(
	"inherits ordered intercept modules during disposable preparation and isolates a sibling's defaults (I1, F2)",
	() =>
		Effect.gen(function* () {
			const fixture = yield* stage
			yield* Effect.gen(function* () {
				const control = yield* Control.serve()
				const prepare = yield* Preparation.make({
					control,
					budget,
					intercepts: HashMap.make(["settings", fixture.environment]),
				})
				const nested = yield* prepare.inspect({
					instance: "nested",
					module: fixture.module,
					input: { expected: { color: "red", size: 24 } },
					intercept: [
						{ key: "settings", patch: { color: " red " } },
						{ key: "settings", patch: { size: 24 } },
					],
				})
				const sibling = yield* prepare.inspect({
					instance: "sibling",
					module: fixture.module,
					input: { expected: { color: "blue", size: 12 } },
				})
				assert.notEqual(
					nested.description.environment,
					sibling.description.environment,
				)
				const kernel = yield* Kernel.Kernel
				const units = yield* kernel.units
				assert.lengthOf(units, 2)
				assert.isTrue(
					Array.every(
						units,
						(unit) => unit.kind === "Inspection" && unit.evidence === "Exited",
					),
				)
			}).pipe(Effect.provide(runtime()))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)

it.live(
	"rejects an invalid inherited patch without applying the plugin and retains settled inspection evidence (F2)",
	() =>
		Effect.gen(function* () {
			const fixture = yield* stage
			const fs = yield* FileSystem.FileSystem
			yield* Effect.gen(function* () {
				const control = yield* Control.serve()
				const prepare = yield* Preparation.make({
					control,
					budget,
					intercepts: HashMap.make(["settings", fixture.environment]),
				})
				const failure = yield* prepare
					.inspect({
						instance: "invalid",
						module: fixture.module,
						input: {
							marker: fixture.marker,
							expected: { color: "red", size: 24 },
						},
						intercept: [
							{ key: "settings", patch: { color: "red" } },
							{ key: "settings", patch: { size: "large" } },
						],
					})
					.pipe(Effect.flip)
				assert.equal(failure.reason, "InspectionFailed")
				const started = yield* fs.exists(fixture.marker)
				assert.isFalse(started)
				const kernel = yield* Kernel.Kernel
				const preparations = yield* kernel.inspections
				assert.lengthOf(preparations, 1)
				assert.equal(preparations[0]?.exitEvidence, "Exited")
			}).pipe(Effect.provide(runtime()))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)

it.live(
	"rebuilds unit environments and resolves raw references again during real Restart recovery (F2)",
	() =>
		Effect.gen(function* () {
			const fixture = yield* stage
			const fs = yield* FileSystem.FileSystem
			const input = {
				expected: { color: { $reference: "COLOR" }, size: 12 },
				marker: fixture.marker,
			}
			const environment = [
				{
					artifact: fixture.environment.artifact,
					export: "default",
					options: { color: { $reference: "COLOR" } },
				},
			]
			const target = Units.target({
				artifact: fixture.module.artifact,
				placement: "Worker",
				input,
				environment,
			})
			const failed = Units.target({
				artifact: fixture.module.artifact,
				placement: "Worker",
				input: { ...input, fail: true },
				environment,
			})
			yield* Effect.gen(function* () {
				const kernel = yield* Kernel.Kernel
				yield* kernel.setPolicy({
					instance: "a",
					allowed: [target.identity],
					values: { COLOR: "red" },
				})
				const initial = yield* Change.run({
					instance: "a",
					target,
					strategy: "Restart",
					budget,
				})
				assert.equal(initial.outcome, "Accepted")
				const before = yield* fs.readFileString(fixture.marker)
				assert.equal(before, "red/12\n")
				yield* kernel.setPolicy({
					instance: "a",
					allowed: [target.identity],
					values: { COLOR: "green" },
				})
				const recovered = yield* Change.run({
					instance: "a",
					target: failed,
					strategy: "Restart",
					budget,
				})
				assert.equal(recovered.outcome, "Recovered")
				const after = yield* fs.readFileString(fixture.marker)
				assert.equal(after, "red/12\ngreen/12\n")
				const units = yield* kernel.units
				assert.equal(
					Array.filter(
						units,
						(unit) => unit.kind === "Execution" && unit.evidence === "Missing",
					).length,
					1,
				)
				assert.isTrue(
					Option.getOrThrow(HashMap.get(recovered.members, "a")).healthy,
				)
				assert.isFalse(
					Option.getOrThrow(HashMap.get(recovered.members, "a")).matchesTarget,
				)
				assert.isTrue(
					Option.isSome(
						Option.getOrThrow(HashMap.get(recovered.members, "a")).actual,
					),
				)
			}).pipe(Effect.provide(runtime(target)))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)
