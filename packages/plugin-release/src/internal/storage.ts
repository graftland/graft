import {
	Array,
	Cause,
	Config,
	Effect,
	FileSystem,
	Path,
	Record,
	Schema,
} from "effect"

import { Manifest } from "@graftland/graft"
import { Artifact, Publication } from "@graftland/plugin-remote"

import { parseDocument } from "yaml"

import { Build, Id, Release, ReleaseError, SourceEntry } from "../Model"
import { resolveContract } from "./contract"

export const failure = (code: string, message: string) =>
	ReleaseError.make({ code, message })
export const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.mapError((error) =>
			Schema.is(ReleaseError)(error)
				? error
				: ReleaseError.make({
						code: "Storage",
						message: "Release operation failed; inspect the in-memory cause",
						cause: Cause.fail(error),
					}),
		),
	)
export const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
export const equal = (a: Schema.Json, b: Schema.Json) =>
	Effect.all([
		json(Publication.canonical(a)),
		json(Publication.canonical(b)),
	]).pipe(Effect.map(([a, b]) => a === b))
const isArray = (value: Schema.Json): value is Schema.JsonArray =>
	Array.isArray(value)
export const references = (value: Schema.Json): ReadonlyArray<string> => {
	if (isArray(value)) return Array.flatMap(value, references)
	if (value !== null && typeof value === "object") {
		if (typeof value["$env"] === "string") return ["env:" + value["$env"]]
		return Array.flatMap(Record.values(value), references)
	}
	return []
}
export const resolveInput = Effect.fnUntraced(function* (
	value: Schema.Json,
): Effect.fn.Return<Schema.Json, ReleaseError> {
	if (isArray(value)) return yield* Effect.forEach(value, resolveInput)
	if (value !== null && typeof value === "object") {
		if (typeof value["$env"] === "string") {
			if (Record.keys<string, Schema.Json>(value).length !== 1)
				return yield* failure(
					"Reference",
					"An environment reference must contain only $env",
				)
			return yield* Config.String(value["$env"]).pipe(
				Effect.mapError(() =>
					failure(
						"Reference",
						"Missing environment reference " + value["$env"],
					),
				),
			)
		}
		const entries = yield* Effect.forEach(
			Record.toEntries(value),
			Effect.fnUntraced(function* ([key, child]) {
				return [key, yield* resolveInput(child)] as const
			}),
		)
		return Record.fromEntries(entries)
	}
	return value
})
export const write = Effect.fnUntraced(function* (
	file: string,
	value: Schema.Json,
) {
	const fs = yield* FileSystem.FileSystem
	const text = yield* json(Publication.canonical(value))
	yield* fs.writeFileString(file, text)
})
export const read = <
	S extends Schema.Top & { readonly DecodingServices: never },
>(
	file: string,
	schema: S,
) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs
			.readFileString(file)
			.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(Schema.fromJsonString(schema)),
				),
			),
	)
/** Atomic replacement plus file and parent-directory sync; one writer owns a store. */
export const durable = Effect.fnUntraced(function* (
	file: string,
	value: Schema.Json,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const text = yield* json(value)
	const temporary = file + ".next"
	yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* fs.open(temporary, { flag: "w", mode: 0o600 })
			yield* handle.writeAll(new TextEncoder().encode(text))
			yield* handle.sync
		}),
	)
	yield* fs.rename(temporary, file)
	yield* Effect.scoped(
		Effect.gen(function* () {
			const directory = yield* fs.open(path.dirname(file))
			yield* directory.sync
		}),
	)
}, Effect.uninterruptible)

const syncDirectory = Effect.fnUntraced(function* (
	directory: string,
): Effect.fn.Return<
	void,
	import("effect").PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	for (const name of yield* fs.readDirectory(directory)) {
		const file = path.join(directory, name)
		if ((yield* fs.stat(file)).type === "Directory") yield* syncDirectory(file)
		else
			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* fs.open(file)
					yield* handle.sync
				}),
			)
	}
	yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* fs.open(directory)
			yield* handle.sync
		}),
	)
})
/** Verifies immutable bytes and decodes stored metadata without importing implementations. */
export const verify = Effect.fnUntraced(function* (store: string, id: string) {
	yield* Schema.decodeEffect(Id)(id)
	const path = yield* Path.Path
	const directory = path.join(store, id)
	if ((yield* Artifact.directoryIdentity(directory)).digest !== id)
		return yield* failure("Integrity", "Release directory digest mismatch")
	const release = yield* read(path.join(directory, "release.json"), Release)
	for (const entry of release.entries) {
		if (!/^artifacts\/sha256-v1-[a-f0-9]{64}$/.test(entry.artifact.directory))
			return yield* failure(
				"Integrity",
				"Artifact path must remain inside the release",
			)
		yield* Artifact.verify({
			...entry.artifact,
			directory: path.join(directory, entry.artifact.directory),
		})
	}
	return release
}, protect)
/** Inspects runtime availability and current provenance only for a selected deployment. */
export const load = Effect.fnUntraced(function* (
	store: string,
	id: string,
	metadataOnly: boolean = false,
) {
	const release = yield* verify(store, id)
	if (metadataOnly) return release
	const path = yield* Path.Path
	const directory = path.join(store, id)
	for (const entry of release.entries) {
		const generated = yield* Publication.generate(
			path.join(directory, entry.artifact.directory),
		)
		if (!(yield* equal(generated, entry.package)))
			return yield* failure(
				"Provenance",
				"Publication or external contract provenance changed for " +
					entry.id +
					"; rebuild and plan a new release",
			)
	}
	return release
}, protect)
/** Builds without activating plugins; all source locations are relative to the source configuration. */
export const build = Effect.fnUntraced(
	function* (
		store: string,
		request: Build,
		retained: ReadonlyArray<string> = [],
	) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const file = path.resolve(request.file)
		const text = yield* fs.readFileString(file)
		const raw = yield* Effect.try({
			try: () => {
				const document = parseDocument(text, {
					customTags: [
						{ tag: "!env", resolve: (name: string) => ({ $env: name }) },
					],
				})
				if (document.errors.length > 0) throw document.errors[0]
				if (document.warnings.length > 0) throw document.warnings[0]
				return document.toJS()
			},
			catch: (cause) =>
				ReleaseError.make({
					code: "Configuration",
					message: "Invalid release source YAML",
					cause: Cause.fail(cause),
				}),
		})
		const source = yield* Schema.decodeUnknownEffect(Schema.Array(SourceEntry))(
			raw,
		).pipe(
			Effect.mapError((cause) =>
				ReleaseError.make({
					code: "Configuration",
					message: "Release sources require named managed Remote entries only",
					cause: Cause.fail(cause),
				}),
			),
		)
		if (
			Array.dedupe(Array.map(source, (entry) => entry.id)).length !==
			source.length
		)
			return yield* failure("Configuration", "Release entry ids must be unique")
		yield* fs.makeDirectory(store, { recursive: true })
		const stage = yield* fs.makeTempDirectoryScoped({
			directory: store,
			prefix: ".build-",
		})
		const entries = yield* Effect.forEach(
			source,
			Effect.fnUntraced(function* (entry) {
				const directory = path.resolve(path.dirname(file), entry.config.package)
				const generated = yield* request.metadataOnly === true
					? read(path.join(directory, "package.json"), Manifest.Package)
					: Publication.generate(directory)
				const selected = generated.graft.entries[entry.config.entry]
				if (selected === undefined)
					return yield* failure(
						"Manifest",
						"Missing public package entry for " + entry.id,
					)
				const artifact = yield* Artifact.capture({
					directory,
					entry: selected.implementation,
					store: path.join(stage, "artifacts"),
				})
				const captured = yield* request.metadataOnly === true
					? read(
							path.join(artifact.directory, "package.json"),
							Manifest.Package,
						)
					: Publication.generate(artifact.directory)
				if (!(yield* equal(generated, captured)))
					return yield* failure(
						"Integrity",
						"Publication changed during capture",
					)
				return {
					id: entry.id,
					contract: yield* resolveContract(file, entry.config.contract),
					target: entry.config.target,
					input: entry.config.config,
					probes: entry.config.probes,
					artifact: {
						...artifact,
						directory: path.relative(stage, artifact.directory),
					},
					package: captured,
					entry: entry.config.entry,
					provenance: {
						package: { name: captured.name, version: captured.version },
						entry: entry.config.entry,
						artifact: artifact.identity,
						operations: selected.operations,
					},
				}
			}),
		)
		const release: Release = {
			version: 1,
			entries,
			references: Array.dedupe([
				...request.references,
				...Array.flatMap(entries, (entry) => references(entry.input)),
			]),
			revocations: Array.dedupe([...retained, ...request.revocations]),
		}
		yield* write(path.join(stage, "package.json"), {
			name: "graft-release",
			version: "1.0.0",
			private: true,
		})
		yield* write(path.join(stage, "release.json"), release)
		yield* write(
			path.join(stage, "manifests.json"),
			Array.map(entries, (entry) => ({
				id: entry.id,
				package: entry.package,
				provenance: entry.provenance,
			})),
		)
		yield* write(
			path.join(stage, "graft.yml"),
			Array.map(entries, (entry) => ({
				id: entry.id,
				name: "@graftland/plugin-remote",
				config: {
					contract: entry.contract,
					artifact: entry.artifact,
					target: entry.target,
					config: entry.input,
					probes: entry.probes,
				},
			})),
		)
		const id = (yield* Artifact.directoryIdentity(stage)).digest
		const destination = path.join(store, id)
		if (yield* fs.exists(destination)) yield* verify(store, id)
		else {
			yield* syncDirectory(stage)
			yield* fs.rename(stage, destination)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* fs.open(store)
					yield* handle.sync
				}),
			)
		}
		return id
	},
	Effect.scoped,
	protect,
)
