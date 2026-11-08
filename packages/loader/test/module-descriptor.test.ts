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
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

import { ConfigDirectory, ModuleResolver } from "../src/index"

const platform = Kernel.layer({
	authority: "loader-descriptors",
	maxUnits: 3,
	instances: [],
}).pipe(Layer.provide(Units.layer), Layer.provideMerge(NodeServices.layer))
const setup = Effect.gen(function* () {
	const control = yield* Control.serve()
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const cache = new URL("../.cache/descriptors", import.meta.url).pathname
	yield* fs.makeDirectory(cache, { recursive: true })
	const base = yield* fs.makeTempDirectoryScoped({ directory: cache })
	const plugin = new URL("../../core/dist/Plugin.js", import.meta.url).href
	const write = (name: string, body?: string) =>
		Effect.gen(function* () {
			const directory = path.join(base, "node_modules", name)
			const metadata = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Json),
			)({ name, type: "module", exports: "./index.mjs", version: "1.0.0" })
			const pluginUrl = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.String),
			)(plugin)
			const label = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.String),
			)(name)
			yield* fs.makeDirectory(directory, { recursive: true })
			yield* fs.writeFileString(path.join(directory, "package.json"), metadata)
			yield* fs.writeFileString(
				path.join(directory, "index.mjs"),
				body ??
					`import { isMainThread } from "node:worker_threads"; import { Effect, Schema } from "effect"; import * as Plugin from ${pluginUrl}; if (isMainThread) throw new Error("Candidate evaluated on the Loader thread"); export default Plugin.make({name:${label},config:Schema.Struct({required:Schema.String}),apply:() => Effect.die("Describe activated the plugin")});`,
			)
		})
	return { fs, path, base, write, control }
})

it.live(
	"resolves exact names to serializable captured descriptors without evaluating candidates in Loader (I1, F2)",
	() =>
		Effect.gen(function* () {
			const { base, write, control } = yield* setup
			yield* write("chosen")
			yield* write("@graftland/plugin-chosen")
			const resolver = yield* ModuleResolver.make({ base, control })
			const descriptor = yield* resolver.resolve("chosen")
			assert.equal(descriptor.provenance.specifier, "chosen")
			const encoded = yield* Schema.encodeEffect(
				Schema.fromJsonString(ModuleResolver.Descriptor),
			)(descriptor)
			const decoded = yield* Schema.decodeEffect(
				Schema.fromJsonString(ModuleResolver.Descriptor),
			)(encoded)
			assert.deepEqual(decoded, descriptor)
			assert.equal(descriptor.export, "default")
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

it.live(
	"rejects equal-rank short-name ambiguity through real module inspection (F2)",
	() =>
		Effect.gen(function* () {
			const { base, write, control } = yield* setup
			yield* write("@graftland/plugin-shared")
			yield* write("graft-plugin-shared")
			const resolver = yield* ModuleResolver.make({ base, control })
			const error = yield* Effect.flip(resolver.resolve("shared"))
			assert.equal(error._tag, "AmbiguousPluginName")
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

it.live(
	"keeps missing modules distinct from broken imported dependencies (F2)",
	() =>
		Effect.gen(function* () {
			const { base, write, control } = yield* setup
			yield* write("broken", 'import "./missing.mjs"; export default {}')
			const resolver = yield* ModuleResolver.make({ base, control })
			const missing = yield* Effect.flip(resolver.resolve("absent"))
			assert.equal(missing._tag, "ModuleNotFound")
			const broken = yield* Effect.flip(resolver.resolve("broken"))
			assert.equal(broken._tag, "ModuleInvalid")
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

it.live(
	"uses each include directory as the relative module base (F2)",
	() =>
		Effect.gen(function* () {
			const { base, write, path, control } = yield* setup
			yield* write("first")
			yield* write("second")
			const resolver = yield* ModuleResolver.make({ base, control })
			const first = yield* resolver
				.resolve("./index.mjs")
				.pipe(
					Effect.provideService(
						ConfigDirectory,
						Option.some(path.join(base, "node_modules/first")),
					),
				)
			const second = yield* resolver
				.resolve("./index.mjs")
				.pipe(
					Effect.provideService(
						ConfigDirectory,
						Option.some(path.join(base, "node_modules/second")),
					),
				)
			assert.notEqual(first.provenance.package, second.provenance.package)
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

it.live(
	"falls back from a real non-plugin exact module without importing it in Loader (F2)",
	() =>
		Effect.gen(function* () {
			const { base, control, write } = yield* setup
			yield* write("fallback", "export default {}")
			yield* write("graft-plugin-fallback")
			const resolver = yield* ModuleResolver.make({ base, control })
			const descriptor = yield* resolver.resolve("fallback")
			assert.equal(descriptor.provenance.specifier, "graft-plugin-fallback")
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

for (const kind of [
	"relative path",
	"absolute path",
	"file URL",
	"file URL with suffix",
]) {
	it.live(
		`classifies a missing ${kind} as ModuleNotFound using filesystem evidence (F2)`,
		() =>
			Effect.gen(function* () {
				const { base, control, path } = yield* setup
				const file = path.join(base, "missing space #%.mjs")
				const url = yield* path.toFileUrl(file)
				const name =
					kind === "relative path"
						? "./missing space #%.mjs"
						: kind === "absolute path"
							? file
							: url.href +
								(kind === "file URL with suffix" ? "?revision=1#plugin" : "")
				const resolver = yield* ModuleResolver.make({ base, control })
				const error = yield* Effect.flip(resolver.resolve(name))
				assert.equal(error._tag, "ModuleNotFound")
			}).pipe(Effect.scoped, Effect.provide(platform)),
		15000,
	)
}

for (const name of ["file://[", "file:///invalid%2Fpath.mjs"]) {
	it.live(
		`rejects invalid descriptor location ${name} before importing (F2)`,
		() =>
			Effect.gen(function* () {
				const { base, control } = yield* setup
				const resolver = yield* ModuleResolver.make({ base, control })
				const error = yield* Effect.flip(resolver.resolve(name))
				assert.equal(error._tag, "ModuleInvalid")
				const kernel = yield* Kernel.Kernel
				const units = yield* kernel.units
				assert.lengthOf(units, 0)
			}).pipe(Effect.scoped, Effect.provide(platform)),
		15000,
	)
}

it.live(
	"preserves an encoded file location and its suffix in the transferable descriptor (F2)",
	() =>
		Effect.gen(function* () {
			const { base, control, fs, path, write } = yield* setup
			yield* write("file-location")
			const source = path.join(base, "node_modules/file-location/index.mjs")
			const file = path.join(base, "node_modules/file-location/space #%.mjs")
			yield* fs.copyFile(source, file)
			const url = yield* path.toFileUrl(file)
			const resolver = yield* ModuleResolver.make({ base, control })
			const descriptor = yield* resolver.resolve(url.href + "?revision=2#entry")
			assert.equal(descriptor.suffix, "?revision=2#entry")
			assert.equal(descriptor.provenance.source, url.href + "?revision=2#entry")
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

it.live(
	"uses fresh package bytes after an earlier resolution and missing-name rejection (F2)",
	() =>
		Effect.gen(function* () {
			const { base, control, fs, path, write } = yield* setup
			const resolver = yield* ModuleResolver.make({ base, control })
			const missing = yield* Effect.flip(resolver.resolve("fresh"))
			assert.equal(missing._tag, "ModuleNotFound")
			yield* write("fresh")
			const first = yield* resolver.resolve("fresh")
			const file = path.join(base, "node_modules/fresh/index.mjs")
			const text = yield* fs.readFileString(file)
			yield* fs.writeFileString(file, text + "\nexport const revision = 2\n")
			const next = yield* resolver.resolve("fresh")
			assert.notEqual(
				first.artifact.identity.digest,
				next.artifact.identity.digest,
			)
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

it.live(
	"resolves an environment Layer to immutable data without constructing it in Loader (F2)",
	() =>
		Effect.gen(function* () {
			const { base, write, control } = yield* setup
			yield* write(
				"environment",
				'import { isMainThread } from "node:worker_threads"; import { Effect, Layer } from "effect"; if (isMainThread) throw new Error("Environment imported on Loader thread"); export default Layer.effectDiscard(Effect.die("Metadata inspection constructed environment"));',
			)
			const resolver = yield* ModuleResolver.make({ base, control })
			const descriptor = yield* resolver.resolve("environment", {
				kind: "Environment",
			})
			assert.equal(descriptor.kind, "Environment")
			assert.equal(descriptor.export, "default")
			const codec = Schema.fromJsonString(ModuleResolver.Descriptor)
			const encoded = yield* Schema.encodeEffect(codec)(descriptor)
			const decoded = yield* Schema.decodeEffect(codec)(encoded)
			assert.deepEqual(decoded, descriptor)
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

it.live(
	"resolves package exports with the native unit's execution conditions rather than Loader development conditions (F2)",
	() =>
		Effect.gen(function* () {
			const { base, write, control, fs, path } = yield* setup
			yield* write("conditional")
			const metadata = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Json),
			)({
				name: "conditional",
				type: "module",
				exports: { source: "./source.ts", default: "./index.mjs" },
			})
			yield* fs.writeFileString(
				path.join(base, "node_modules/conditional/package.json"),
				metadata,
			)
			yield* fs.writeFileString(
				path.join(base, "node_modules/conditional/source.ts"),
				"throw new Error('Development entry must not execute')",
			)
			const resolver = yield* ModuleResolver.make({ base, control })
			const descriptor = yield* resolver.resolve("conditional")
			assert.equal(descriptor.artifact.identity.module, "index.mjs")
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

const resolverModule = Effect.fnUntraced(function* (body: string) {
	const fixture = yield* setup
	const configuration = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.String),
	)(new URL("../../plugin-remote/dist/Configuration.js", import.meta.url).href)
	yield* fixture.write(
		"custom-resolver",
		`import { isMainThread } from "node:worker_threads"; import { Effect, FileSystem } from "effect"; import { Options } from ${configuration}; if(isMainThread&&process.send===undefined)throw new Error("Custom resolver evaluated in Loader"); ${body}`,
	)
	const artifact = yield* Artifact.capture({
		directory: fixture.path.join(fixture.base, "node_modules/custom-resolver"),
		module: "index.mjs",
		store: fixture.path.join(fixture.base, "artifacts"),
	})
	return { ...fixture, artifact }
})

it.live(
	"executes a custom resolver in a disposable unit and transfers only its validated descriptor (I1, F2)",
	() =>
		Effect.gen(function* () {
			const fixture = yield* resolverModule(
				"export default Effect.map(Options,input=>input.options.selected);",
			)
			yield* fixture.write("candidate")
			const ordinary = yield* ModuleResolver.make({
				base: fixture.base,
				control: fixture.control,
			})
			const selected = yield* ordinary.resolve("candidate")
			const custom = yield* ModuleResolver.make({
				base: fixture.base,
				control: fixture.control,
				resolver: { artifact: fixture.artifact, options: { selected } },
			})
			const result = yield* custom.resolve("custom-name")
			assert.deepEqual(result, selected)
			const kernel = yield* Kernel.Kernel
			const units = yield* kernel.units
			assert.lengthOf(units, 3)
			assert.isTrue(
				Array.every(
					units,
					(unit) => unit.kind === "Inspection" && unit.evidence === "Exited",
				),
			)
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

it.live(
	"rejects executable custom resolver results and preserves their settled preparation (F2)",
	() =>
		Effect.gen(function* () {
			const fixture = yield* resolverModule(
				"export default Effect.succeed(() => Effect.void);",
			)
			const custom = yield* ModuleResolver.make({
				base: fixture.base,
				control: fixture.control,
				resolver: { artifact: fixture.artifact, options: {} },
			})
			const failure = yield* custom.resolve("custom-name").pipe(Effect.flip)
			assert.equal(failure._tag, "ModuleInvalid")
			const kernel = yield* Kernel.Kernel
			const preparations = yield* kernel.inspections
			assert.lengthOf(preparations, 1)
			assert.equal(preparations[0]?.exitEvidence, "Exited")
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

it.live(
	"terminates a custom resolver that blocks after an entry barrier while kernel queries remain responsive (I1, F2)",
	() =>
		Effect.gen(function* () {
			const fixture = yield* resolverModule(
				'export default Effect.gen(function*(){const input=yield* Options;const fs=yield* FileSystem.FileSystem;yield* fs.writeFileString(input.options.marker,"entered");yield* Effect.sync(()=>{while(true){}});return {};});',
			)
			const marker = fixture.path.join(fixture.base, "entered")
			const custom = yield* ModuleResolver.make({
				base: fixture.base,
				control: fixture.control,
				budget: { startup: 2000 },
				resolver: { artifact: fixture.artifact, options: { marker } },
			})
			const pending = yield* custom
				.resolve("custom-name")
				.pipe(Effect.exit, Effect.forkScoped)
			yield* fixture.fs.exists(marker).pipe(
				Effect.repeat({
					while: (exists) => !exists,
					schedule: Schedule.spaced("10 millis"),
				}),
				Effect.timeout("5 seconds"),
			)
			const kernel = yield* Kernel.Kernel
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
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

for (const finalizer of ["complete", "defect", "blocked"]) {
	it.live(
		`settles custom resolver ${finalizer} cleanup through owned native exit evidence (F2)`,
		() =>
			Effect.gen(function* () {
				const fixture = yield* resolverModule(
					`export default Effect.gen(function*(){const input=yield* Options;const fs=yield* FileSystem.FileSystem;yield* Effect.addFinalizer(()=>fs.writeFileString(input.options.marker,"released").pipe(Effect.andThen(${finalizer === "complete" ? "Effect.void" : finalizer === "defect" ? 'Effect.die("resolver-cleanup-defect")' : "Effect.never"})));return input.options.selected;});`,
				)
				yield* fixture.write("candidate")
				const ordinary = yield* ModuleResolver.make({
					base: fixture.base,
					control: fixture.control,
				})
				const selected = yield* ordinary.resolve("candidate")
				const marker = fixture.path.join(fixture.base, "released")
				const custom = yield* ModuleResolver.make({
					base: fixture.base,
					control: fixture.control,
					budget: { stop: 100 },
					resolver: {
						artifact: fixture.artifact,
						options: { selected, marker },
					},
				})
				const result = yield* custom.resolve("custom-name").pipe(Effect.exit)
				const released = yield* fixture.fs.readFileString(marker)
				assert.equal(released, "released")
				assert.equal(
					result._tag,
					finalizer === "complete" ? "Success" : "Failure",
				)
				const kernel = yield* Kernel.Kernel
				const inspections = yield* kernel.inspections
				assert.isTrue(
					Array.every(
						inspections,
						(entry) =>
							entry.exitEvidence === "Exited" &&
							HashSet.size(entry.unconfirmedUnits) === 0,
					),
				)
				if (finalizer === "defect")
					assert.include(
						Array.join(
							Array.map(inspections, (entry) => Cause.pretty(entry.cause)),
							"\n",
						),
						"resolver-cleanup-defect",
					)
			}).pipe(Effect.scoped, Effect.provide(platform)),
		15000,
	)
}

it.live(
	"records resolved versions and locations of declared uncaptured runtime dependencies (F2)",
	() =>
		Effect.gen(function* () {
			const { base, write, control, fs, path } = yield* setup
			yield* write("dependencies")
			const metadata = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Json),
			)({
				name: "dependencies",
				version: "1.0.0",
				type: "module",
				exports: "./index.mjs",
				dependencies: { effect: "4.1.*" },
				optionalDependencies: { "absent-optional": "^1.0.0" },
			})
			yield* fs.writeFileString(
				path.join(base, "node_modules/dependencies/package.json"),
				metadata,
			)
			const resolver = yield* ModuleResolver.make({ base, control })
			const result = yield* resolver.resolve("dependencies")
			assert.equal(result.externalDependencyCoverage, "Declared")
			assert.equal(result.externalDependencies["effect"]?.version, "4.1.2")
			assert.equal(result.externalDependencies["effect"]?.requested, "4.1.*")
			assert.equal(result.externalDependencies["effect"]?.captured, false)
			assert.isString(result.externalDependencies["effect"]?.source)
			assert.equal(
				result.externalDependencies["absent-optional"]?.requested,
				"^1.0.0",
			)
			assert.isUndefined(result.externalDependencies["absent-optional"]?.source)
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

it.live(
	"keeps the resolver's infrastructure separate from a later include's resolution base (F2)",
	() =>
		Effect.gen(function* () {
			const { base, write, control, path } = yield* setup
			yield* write("parent")
			yield* write("child")
			const resolver = yield* ModuleResolver.make({ base, control }).pipe(
				Effect.provideService(
					ConfigDirectory,
					Option.some(path.join(base, "node_modules/parent")),
				),
			)
			const result = yield* resolver
				.resolve("./index.mjs")
				.pipe(
					Effect.provideService(
						ConfigDirectory,
						Option.some(path.join(base, "node_modules/child")),
					),
				)
			assert.equal(result.base, path.join(base, "node_modules/child"))
			assert.include(result.provenance.source, "/child/index.mjs")
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)

for (const kind of ["relative path", "file URL", "file URL with suffix"]) {
	it.live(
		`preserves a broken dependency Cause for a captured ${kind} (F2)`,
		() =>
			Effect.gen(function* () {
				const { base, write, control, path } = yield* setup
				yield* write(
					"broken-path",
					'import "./missing-dependency.mjs"; export default {}',
				)
				const resolver = yield* ModuleResolver.make({ base, control })
				const file = path.join(base, "node_modules/broken-path/index.mjs")
				const name =
					kind === "relative path"
						? "./node_modules/broken-path/index.mjs"
						: new URL(`file://${file}`).href +
							(kind === "file URL with suffix" ? "?revision=2#entry" : "")
				const result = yield* resolver.resolve(name).pipe(Effect.flip)
				assert.equal(result._tag, "ModuleInvalid")
				assert.include(
					Cause.pretty(Cause.fail(result)),
					"missing-dependency.mjs",
				)
			}).pipe(Effect.scoped, Effect.provide(platform)),
		15000,
	)
}
it.live(
	"resolves a third-party convention alone and rejects an exact non-plugin without a fallback (F2)",
	() =>
		Effect.gen(function* () {
			const { base, write, control } = yield* setup
			yield* write("graft-plugin-third-party")
			yield* write("not-plugin", "export default {}")
			const resolver = yield* ModuleResolver.make({ base, control })
			const third = yield* resolver.resolve("third-party")
			assert.equal(third.provenance.specifier, "graft-plugin-third-party")
			const invalid = yield* resolver.resolve("not-plugin").pipe(Effect.flip)
			assert.equal(invalid._tag, "ModuleInvalid")
		}).pipe(Effect.scoped, Effect.provide(platform)),
	15000,
)
