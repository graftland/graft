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
import type { PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- WebCrypto has no incremental digest API; package files are hashed as streams without buffering the directory.
import { createHash } from "node:crypto"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { failure, type CodeIdentity, type SessionError } from "./model"

const Manifest = Schema.Struct({ name: Schema.String, version: Schema.String })
export interface Expected {
	readonly version?: string
	readonly digest?: string
}
export const verify = (actual: CodeIdentity, expected: Expected = {}) =>
	expected.version !== undefined && actual.version !== expected.version
		? Effect.fail(
				failure(
					"InvalidRequest",
					`Package version mismatch: expected ${expected.version}, received ${actual.version}`,
				),
			)
		: expected.digest !== undefined && actual.digest !== expected.digest
			? Effect.fail(
					failure(
						"InvalidRequest",
						`Package digest mismatch: expected ${expected.digest}, received ${actual.digest}`,
					),
				)
			: Effect.void

/** A path-sensitive SHA-256 of sorted entries and bytes, excluding every node_modules subtree. */
export const digest = Effect.fnUntraced(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const hash = yield* Effect.sync(() =>
		createHash("sha256").update("graft-package-sha256-v1\0"),
	)
	const visit = (
		relative: string,
	): Effect.Effect<void, SessionError | PlatformError.PlatformError> =>
		Effect.gen(function* () {
			const filename = path.join(directory, relative)
			const info = yield* fs.lstat(filename)
			if (info.type !== "File" && info.type !== "Directory")
				return yield* failure(
					"InvalidRequest",
					`Unsupported package entry: ${relative}`,
				)
			const name = new TextEncoder().encode(relative)
			yield* Effect.sync(() => {
				hash.update(
					`${info.type}:${name.byteLength}:${info.type === "File" ? info.size : 0}:`,
				)
				hash.update(name)
			})
			if (info.type === "File") {
				let size = 0n
				yield* fs.stream(filename).pipe(
					Stream.runForEach((bytes) =>
						Effect.sync(() => {
							size += BigInt(bytes.byteLength)
							hash.update(bytes)
						}),
					),
				)
				if (size !== info.size)
					return yield* failure(
						"Conflict",
						"Package changed while its digest was being computed",
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
 * A realpath check prevents ancestor installations or exports from escaping the selected package.
 */
export const resolve = Effect.fnUntraced(
	function* (root: string, specifier: string, expected: Expected = {}) {
		const segments = String.split(specifier, "/")
		const scoped = String.startsWith("@")(specifier)
		const name = scoped ? `${segments[0]}/${segments[1] ?? ""}` : segments[0]!
		if (
			!/^(?:@[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(
				name,
			) ||
			Array.some(
				segments,
				(segment) =>
					segment === "" ||
					segment === "." ||
					segment === ".." ||
					/[\\:%?#\x00-\x20]/.test(segment),
			)
		)
			return yield* failure(
				"InvalidRequest",
				"A bare installed package specifier is required",
			)
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const installation = yield* fs.realPath(root)
		const directory = yield* fs.realPath(
			path.join(installation, "node_modules", name),
		)
		const manifest = yield* fs
			.readFileString(path.join(directory, "package.json"))
			.pipe(
				Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Manifest))),
			)
		if (manifest.name !== name)
			return yield* failure(
				"InvalidRequest",
				"The installed package name does not match its specifier",
			)
		const resolved = yield* Effect.scoped(
			Effect.gen(function* () {
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
					return yield* failure(
						"InvalidRequest",
						`Package resolution failed: ${stderr}`,
					)
				return stdout
			}),
		)
		const filename = yield* Effect.try({
			try: () => fileURLToPath(resolved),
			catch: (error) =>
				failure(
					"InvalidRequest",
					"The package export is not a file URL",
					Cause.die(error),
				),
		})
		const entry = yield* fs.realPath(filename)
		const relative = path.relative(directory, entry)
		if (
			relative === ".." ||
			String.startsWith(`..${path.sep}`)(relative) ||
			path.isAbsolute(relative)
		)
			return yield* failure(
				"InvalidRequest",
				"The package export resolves outside its installed directory",
			)
		const identity: CodeIdentity = {
			...manifest,
			digest: yield* digest(directory),
		}
		yield* verify(identity, expected)
		return { directory, entry, identity }
	},
	Effect.catchCause((cause) =>
		Effect.fail(
			failure("Execution", "Resolving the installed package failed", cause),
		),
	),
)
