import {
	Array,
	Context,
	Effect,
	FileSystem,
	Layer,
	Path,
	Record,
	Schema,
	String,
} from "effect"
import { NodeServices } from "@effect/platform-node"

import { Kernel } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

export class FixtureDirectory extends Context.Service<
	FixtureDirectory,
	string
>()("@graftland/plugin-otlp/test/module-fixtures/FixtureDirectory") {}

const inspection = Kernel.layer({
	authority: "module-fixtures",
	maxUnits: 16,
	instances: [],
}).pipe(Layer.provide(Units.layer), Layer.provideMerge(NodeServices.layer))

const stageReferences = (text: string) =>
	Effect.reduce(
		Array.fromIterable(String.matchAll(/"@fixture\/([^"\s]+)"/g)(text)),
		() => text,
		Effect.fnUntraced(function* (result, match) {
			const reference = match[1]
			if (reference === undefined) return result
			const [name, ...entry] = String.split("/")(reference)
			const location = new URL(
				`../../${name}/dist/${Array.join(entry, "/")}.js`,
				import.meta.url,
			).href
			const encoded = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.String),
			)(location)
			return String.replace(match[0], encoded)(result)
		}),
	)

const installFixture = Effect.fnUntraced(function* (
	base: string,
	name: string,
	directory: string,
	framework: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const segments = String.split("/")(name)
	const count = String.startsWith("@")(name) ? 2 : 1
	const owner = Array.join(Array.take(segments, count), "/")
	const subpath = Array.join(Array.drop(segments, count), "/")
	const relative =
		subpath === "" ? "fixtures/root" : `fixtures/subpath/${subpath}`
	const root = path.join(base, "node_modules", owner)
	const target = path.join(root, relative)
	yield* fs.makeDirectory(path.dirname(target), { recursive: true })
	yield* fs.copy(directory, target)
	const file = path.join(target, "index.mjs")
	const text = yield* fs
		.readFileString(file)
		.pipe(Effect.flatMap(stageReferences))
	yield* fs.writeFileString(
		file,
		String.replace('"@graftland/loader"', framework)(text),
	)
	const manifest = path.join(root, "package.json")
	const exists = yield* fs.exists(manifest)
	const previous = exists
		? yield* fs.readFileString(manifest).pipe(
				Effect.flatMap(
					Schema.decodeEffect(
						Schema.fromJsonString(
							Schema.Struct({
								exports: Schema.Record(Schema.String, Schema.String),
							}),
						),
					),
				),
			)
		: { exports: {} }
	const metadata = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.Json),
	)({
		name: owner,
		version: "1.0.0",
		type: "module",
		exports: {
			...previous.exports,
			[subpath === "" ? "." : `./${subpath}`]: `./${relative}/index.mjs`,
		},
	})
	yield* fs.writeFileString(manifest, metadata)
})

/** Installs real package files and resolves them through the production public inspection protocol. */
export const moduleLayer = (modules: Readonly<Record<string, string>>) =>
	Layer.effectContext(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const cache = new URL("../.cache/module-fixtures", import.meta.url)
				.pathname
			yield* fs.makeDirectory(cache, { recursive: true })
			const base = yield* fs.makeTempDirectoryScoped({ directory: cache })
			const framework = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.String),
			)(new URL("../../loader/dist/index.js", import.meta.url).href)
			yield* Effect.forEach(
				Record.toEntries(modules),
				([name, directory]) => installFixture(base, name, directory, framework),
				{ discard: true },
			)
			const control = yield* Control.serve()
			const resolver = yield* ModuleResolver.make({ base, control })
			return Context.make(ModuleResolver.ModuleResolver, resolver).pipe(
				Context.add(FixtureDirectory, base),
			)
		}),
	).pipe(Layer.provide(inspection))

export const fixture = (name: string): string =>
	new URL(`../../loader/test/fixtures/${name}`, import.meta.url).pathname
