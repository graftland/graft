// @effect-diagnostics-next-line nodeBuiltinImport:off -- WebCrypto has no incremental digest API; artifact files are hashed as streams.
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

import {
	Array,
	Cause,
	Effect,
	FileSystem,
	Order,
	Path,
	Schema,
	Stream,
	String,
} from "effect"

import { Manifest } from "@graftland/graft"

export const Identity = Schema.Struct({
	version: Schema.Literal(1),
	algorithm: Schema.Literal("sha256"),
	digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
	entry: Schema.NonEmptyString,
})
export type Identity = typeof Identity.Type
export const Artifact = Schema.Struct({
	identity: Identity,
	directory: Schema.NonEmptyString,
})
export type Artifact = typeof Artifact.Type
export interface CaptureOptions {
	readonly directory: string
	readonly entry: string
	readonly store: string
}
export class ArtifactError extends Schema.TaggedError<
	ArtifactError,
	{ readonly brand: unique symbol }
>()("ArtifactError", {
	detail: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
const invalid = (detail: string) => ArtifactError.make({ detail })

const hashDirectory = Effect.fnUntraced(function* (
	directory: string,
	prefix: string,
	copy?: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const hash = yield* Effect.sync(() => createHash("sha256").update(prefix))
	const visit = Effect.fnUntraced(function* (
		relative: string,
	): Effect.fn.Return<
		void,
		ArtifactError | import("effect").PlatformError.PlatformError
	> {
		const filename = path.join(directory, relative)
		const info = yield* fs.lstat(filename)
		if (info.type !== "File" && info.type !== "Directory")
			return yield* invalid(
				`Unsupported artifact entry (symlinks are not supported): ${relative || "."}`,
			)
		const name = new TextEncoder().encode(relative)
		yield* Effect.sync(() => {
			hash.update(
				`${info.type}:${name.byteLength}:${info.type === "File" ? info.size : 0}:`,
			)
			hash.update(name)
		})
		if (info.type === "Directory") {
			if (copy !== undefined)
				yield* fs.makeDirectory(path.join(copy, relative), { recursive: true })
			const children = yield* fs.readDirectory(filename)
			for (const child of Array.sort(children, Order.String))
				yield* visit(relative === "" ? child : `${relative}/${child}`)
		} else {
			yield* fs.stream(filename).pipe(
				Stream.runForEach((bytes) =>
					Effect.sync(() => {
						hash.update(bytes)
					}),
				),
			)
			if (copy !== undefined)
				yield* fs.copyFile(filename, path.join(copy, relative))
		}
	})
	yield* visit("")
	if ((yield* fs.lstat(path.join(directory, "package.json"))).type !== "File")
		return yield* invalid("The artifact directory must contain package.json")
	return yield* Effect.sync(() => hash.digest("hex"))
})
const inspect = Effect.fnUntraced(function* (
	directory: string,
	entry: string,
	copy?: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	if (
		path.isAbsolute(entry) ||
		entry !== path.normalize(entry) ||
		entry === ".." ||
		String.startsWith("../")(entry)
	)
		return yield* invalid(
			"The implementation entry must be a normalized path inside the artifact",
		)
	if (
		!Array.some([".js", ".mjs", ".cjs"], (extension) =>
			String.endsWith(extension)(entry),
		)
	)
		return yield* invalid(
			"Artifacts require a built JavaScript implementation entry",
		)
	const digest = yield* hashDirectory(
		directory,
		`graft-artifact-sha256-v1\0${entry.length}:${entry}\0`,
		copy,
	)
	if ((yield* fs.lstat(path.join(directory, entry))).type !== "File")
		return yield* invalid("The implementation entry must be a regular file")
	return Identity.make({ version: 1, algorithm: "sha256", entry, digest })
})

const filesystemError = (cause: import("effect").PlatformError.PlatformError) =>
	ArtifactError.make({
		detail: "Reading or writing the artifact failed",
		cause: Cause.fail(cause),
	})

/** Rehashes the captured directory, including its selected entry; performs no import. */
export const verify = Effect.fnUntraced(
	function* (artifact: Artifact) {
		const decoded = yield* Schema.decodeEffect(Artifact)(artifact).pipe(
			Effect.mapError((error) =>
				ArtifactError.make({
					detail: "Invalid artifact identity",
					cause: Cause.fail(error),
				}),
			),
		)
		const actual = yield* inspect(decoded.directory, decoded.identity.entry)
		if (actual.digest !== decoded.identity.digest)
			return yield* invalid("Artifact digest mismatch")
		return actual
	},
	Effect.catchTag("PlatformError", filesystemError),
)

/** Copies a built package into an atomic content-addressed directory. All work is effectful. */
export const capture = Effect.fnUntraced(
	function* (options: CaptureOptions) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = path.resolve(options.directory)
		const store = path.resolve(options.store)
		const relative = path.relative(directory, store)
		if (
			relative === "" ||
			(!String.startsWith("../")(relative) && !path.isAbsolute(relative))
		)
			return yield* invalid(
				"The artifact store must be outside the source directory",
			)
		yield* fs.makeDirectory(store, { recursive: true })
		const realSource = yield* fs.realPath(directory)
		const realStore = yield* fs.realPath(store)
		const realRelative = path.relative(realSource, realStore)
		if (
			realRelative === "" ||
			(!String.startsWith("../")(realRelative) &&
				!path.isAbsolute(realRelative))
		)
			return yield* invalid(
				"The artifact store must be outside the source directory",
			)
		const stage = yield* fs.makeTempDirectoryScoped({
			directory: store,
			prefix: ".capture-",
		})
		const before = yield* inspect(directory, options.entry, stage)
		const copied = yield* inspect(stage, options.entry)
		const after = yield* inspect(directory, options.entry)
		if (before.digest !== copied.digest || before.digest !== after.digest)
			return yield* invalid("The source changed during artifact capture")
		const destination = path.join(store, `sha256-v1-${copied.digest}`)
		const artifact: Artifact = { directory: destination, identity: copied }
		if (yield* fs.exists(destination)) {
			yield* verify(artifact)
		} else {
			yield* fs
				.rename(stage, destination)
				.pipe(
					Effect.catchTag("PlatformError", (error) =>
						fs
							.exists(destination)
							.pipe(
								Effect.flatMap((exists) =>
									exists
										? verify(artifact).pipe(Effect.asVoid)
										: Effect.fail(filesystemError(error)),
								),
							),
					),
				)
		}
		yield* verify(artifact)
		return artifact
	},
	Effect.scoped,
	Effect.catchTag("PlatformError", filesystemError),
)

/** Verifies immediately before selecting the captured implementation for execution. */
export const implementation = Effect.fnUntraced(function* (artifact: Artifact) {
	yield* verify(artifact)
	const path = yield* Path.Path
	return pathToFileURL(path.join(artifact.directory, artifact.identity.entry))
		.href
})

/** Hashes a resolved built package without importing it or creating a captured copy. */
export const identify = Effect.fnUntraced(
	function* (options: { readonly directory: string; readonly entry: string }) {
		return yield* inspect(options.directory, options.entry)
	},
	Effect.catchTag("PlatformError", filesystemError),
)

/** Hashes package bytes independently of any selected module, without importing code. */
export const directoryIdentity = Effect.fnUntraced(
	function* (directory: string) {
		const digest = yield* hashDirectory(
			directory,
			"graft-directory-sha256-v1\0",
		)
		return Manifest.DirectoryIdentity.make({
			version: 1,
			algorithm: "sha256",
			digest,
		})
	},
	Effect.catchTag("PlatformError", filesystemError),
)
