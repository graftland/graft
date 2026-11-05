// @effect-diagnostics-next-line nodeBuiltinImport:off -- WebCrypto has no incremental digest API; package files are hashed as streams without buffering the directory.
import { createHash } from "node:crypto"
import process from "node:process"
import { fileURLToPath } from "node:url"

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
	type PlatformError,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { PackageError, type CodeIdentity } from "./model"

const Manifest = Schema.Struct({ name: Schema.String, version: Schema.String })
export interface Expected {
	readonly version?: string
	readonly digest?: string
}
export const verify = (actual: CodeIdentity, expected: Expected = {}) =>
	expected.version !== undefined && actual.version !== expected.version
		? Effect.fail(
				PackageError.make({
					detail: `Package version mismatch: expected ${expected.version}, received ${actual.version}`,
				}),
			)
		: expected.digest !== undefined && actual.digest !== expected.digest
			? Effect.fail(
					PackageError.make({
						detail: `Package digest mismatch: expected ${expected.digest}, received ${actual.digest}`,
					}),
				)
			: Effect.void

/** A path-sensitive SHA-256 of sorted entries and bytes, excluding every node_modules subtree. */
export const digest = Effect.fnUntraced(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const hash = yield* Effect.sync(() =>
		createHash("sha256").update("graft-package-sha256-v1\0"),
	)
	const visit = Effect.fnUntraced(function* (
		relative: string,
	): Effect.fn.Return<void, PackageError | PlatformError.PlatformError> {
		const filename = path.join(directory, relative)
		const info = yield* fs.stat(filename)
		if (info.type !== "File" && info.type !== "Directory")
			return yield* PackageError.make({
				detail: `Unsupported package entry: ${relative}`,
			})
		const name = new TextEncoder().encode(relative)
		yield* Effect.sync(() => {
			hash.update(
				`${info.type}:${name.byteLength}:${info.type === "File" ? info.size : 0}:`,
			)
			hash.update(name)
		})
		if (info.type === "File") {
			yield* fs.stream(filename).pipe(
				Stream.runForEach((bytes) =>
					Effect.sync(() => {
						hash.update(bytes)
					}),
				),
			)
		} else {
			const entries = yield* fs.readDirectory(filename)
			for (const entry of Array.sort(entries, Order.String)) {
				if (entry === "node_modules") continue
				yield* visit(relative === "" ? entry : `${relative}/${entry}`)
			}
		}
	})
	yield* visit("")
	return yield* Effect.sync(() => hash.digest("hex"))
})

/**
 * Resolve using Node's import conditions without importing executable package code.
 * The helper's cwd is the installation root and it inherits no NODE_OPTIONS/loaders.
 * The installation directory and its package exports are trusted.
 */
export const resolve = Effect.fnUntraced(
	function* (root: string, specifier: string, includeDigest: boolean = false) {
		const segments = String.split(specifier, "/")
		const scoped = String.startsWith("@")(specifier)
		const name = Array.join(Array.take(segments, scoped ? 2 : 1), "/")
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const installation = yield* fs.realPath(root)
		const directory = yield* fs.realPath(
			path.join(installation, "node_modules", name),
		)
		const manifest = yield* fs
			.readFileString(path.join(directory, "package.json"))
			.pipe(
				Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Manifest))),
			)
		const resolved = yield* resolveEntry(installation, specifier)
		const filename = yield* Effect.try({
			try: () => fileURLToPath(resolved),
			catch: (error) =>
				PackageError.make({
					detail: "The package export is not a file URL",
					cause: Cause.die(error),
				}),
		})
		const entry = yield* fs.realPath(filename)
		const identity: CodeIdentity = {
			...manifest,
			...(includeDigest ? { digest: yield* digest(directory) } : {}),
		}
		return { directory, entry, identity }
	},
	Effect.catchTags({
		PlatformError: (error) =>
			Effect.fail(
				PackageError.make({
					detail: "Reading the installed package failed",
					cause: Cause.fail(error),
				}),
			),
		SchemaError: (error) =>
			Effect.fail(
				PackageError.make({
					detail: "Reading the package manifest failed",
					cause: Cause.fail(error),
				}),
			),
	}),
)

export const resolveEntry = Effect.fnUntraced(function* (
	installation: string,
	specifier: string,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const child = yield* spawner.spawn(
		ChildProcess.make(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				"process.stdout.write(import.meta.resolve(process.argv[1]))",
				"--",
				specifier,
			],
			{
				cwd: installation,
				env: {},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		),
	)
	const [code, stdout, stderr] = yield* Effect.all(
		[
			child.exitCode,
			child.stdout.pipe(Stream.decodeText(), Stream.mkString),
			child.stderr.pipe(Stream.decodeText(), Stream.mkString),
		],
		{ concurrency: "unbounded" },
	)
	if (code !== 0)
		return yield* PackageError.make({
			detail: `Package resolution failed: ${stderr}`,
		})
	return stdout
}, Effect.scoped)
