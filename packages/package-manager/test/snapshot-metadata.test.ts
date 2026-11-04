import { assert, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Effect,
	Exit,
	Option,
	PlatformError,
	Ref,
	Schema,
	String,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { run, setup } from "./fixtures.ts"

for (const mode of [0o600, 0o640, 0o755]) {
	it.effect(
		`restores configuration bytes, ownership and mode ${mode.toString(8)}`,
		() =>
			Effect.gen(function* () {
				const { fs, path, directory, write, manager } = yield* setup
				yield* write("package.json", "{}")
				const config = path.join(directory, ".npmrc")
				yield* fs.writeFileString(config, "private config")
				yield* fs.chmod(config, mode)
				const before = yield* fs.stat(config)
				const pm = yield* manager(() =>
					fs.remove(config).pipe(Effect.as(ChildProcessSpawner.ExitCode(7))),
				)
				const result = yield* Effect.exit(pm.install({ added: "1" }))
				assert(Exit.isFailure(result))
				const after = yield* fs.stat(config)
				assert.strictEqual(after.mode & 0o7777, mode)
				assert.deepStrictEqual(after.uid, before.uid)
				assert.deepStrictEqual(after.gid, before.gid)
				const text = yield* fs.readFileString(config)
				assert.strictEqual(text, "private config")
				const status = yield* pm.recoveryRequired
				assert(Option.isNone(status))
			}).pipe(run),
	)
}

for (const stage of ["chmod", "chown", "cleanup"] as const) {
	it.effect(
		`keeps the snapshot and all causes when metadata ${stage} fails`,
		() =>
			Effect.gen(function* () {
				const { fs, path, directory, write, manager } = yield* setup
				yield* write("package.json", "{}")
				const config = path.join(directory, ".npmrc")
				yield* fs.writeFileString(config, "private config", { mode: 0o600 })
				const previous = yield* fs.stat(config)
				const denied = PlatformError.systemError({
					_tag: "PermissionDenied",
					module: "FileSystem",
					method: stage,
				})
				const cleanupFailure = PlatformError.systemError({
					_tag: "Unknown",
					module: "FileSystem",
					method: "remove",
				})
				const targetTemporary = (file: string) =>
					String.startsWith(`${config}.`)(file) && String.endsWith(".tmp")(file)
				const pm = yield* manager(
					() =>
						fs.remove(config).pipe(Effect.as(ChildProcessSpawner.ExitCode(7))),
					{
						...fs,
						lstat: (file) =>
							fs
								.lstat(file)
								.pipe(
									Effect.map((info) =>
										file === config && stage === "chown"
											? { ...info, uid: Option.map(info.uid, (uid) => uid + 1) }
											: info,
									),
								),
						chmod: (file, mode) =>
							targetTemporary(file) && stage !== "chown"
								? fs.stat(file).pipe(
										Effect.flatMap((info) => {
											assert.strictEqual(
												info.mode & 0o777,
												0o600,
												"Temporary contents must remain private",
											)
											return Effect.fail(denied)
										}),
									)
								: fs.chmod(file, mode),
						chown: (file, uid, gid) =>
							targetTemporary(file) && stage === "chown"
								? Effect.fail(denied)
								: fs.chown(file, uid, gid),
						remove: (file, options) =>
							targetTemporary(file) && stage === "cleanup"
								? Effect.fail(cleanupFailure)
								: fs.remove(file, options),
					},
				)
				const result = yield* Effect.exit(pm.install({ added: "1" }))
				assert(Exit.isFailure(result))
				assert(
					Array.some(
						result.cause.reasons,
						(reason) => Cause.isFailReason(reason) && reason.error === denied,
					),
				)
				if (stage === "cleanup")
					assert(
						Array.some(
							result.cause.reasons,
							(reason) =>
								Cause.isFailReason(reason) && reason.error === cleanupFailure,
						),
					)
				const status = yield* pm.recoveryRequired
				assert(Option.isSome(status))
				const visible = yield* fs.exists(config)
				assert.strictEqual(
					visible,
					false,
					"An incomplete replacement must never become visible",
				)
				const inventory = yield* fs
					.readFileString(
						path.join(status.value.snapshotDirectory, "snapshot.json"),
					)
					.pipe(
						Effect.flatMap(
							Schema.decodeEffect(
								Schema.fromJsonString(
									Schema.Struct({
										files: Schema.Array(
											Schema.Struct({
												name: Schema.String,
												backup: Schema.NullOr(Schema.String),
												mode: Schema.NullOr(Schema.Int),
												uid: Schema.NullOr(Schema.Int),
												gid: Schema.NullOr(Schema.Int),
											}),
										),
									}),
								),
							),
						),
					)
				const entry = Option.getOrThrow(
					Array.findFirst(inventory.files, (entry) => entry.name === ".npmrc"),
				)
				assert.strictEqual(entry.mode, 0o600)
				assert.strictEqual(
					entry.uid,
					Option.getOrThrow(previous.uid) + (stage === "chown" ? 1 : 0),
				)
				assert.strictEqual(entry.gid, Option.getOrThrow(previous.gid))
				assert(entry.backup !== null)
				const saved = yield* fs.readFileString(
					path.join(status.value.snapshotDirectory, entry.backup),
				)
				assert.strictEqual(saved, "private config")
				const retry = yield* Effect.exit(pm.install({}))
				assert(Exit.isFailure(retry))
				const names = yield* fs.readDirectory(directory)
				const temporary = Array.filter(names, String.endsWith(".tmp"))
				assert.strictEqual(temporary.length, stage === "cleanup" ? 1 : 0)
			}).pipe(run),
	)
}

it.effect(
	"does not overwrite or remove a temporary path that it failed to acquire",
	() =>
		Effect.gen(function* () {
			const { fs, write, manager } = yield* setup
			yield* write("package.json", "{}")
			const collision = yield* Ref.make(Option.none<string>())
			const pm = yield* manager(
				() => Effect.succeed(ChildProcessSpawner.ExitCode(7)),
				{
					...fs,
					open: Effect.fnUntraced(function* (file, options) {
						assert.strictEqual(options?.flag, "wx")
						assert.strictEqual(options?.mode, 0o600)
						yield* fs.writeFileString(file, "owned by someone else")
						yield* Ref.set(collision, Option.some(file))
						return yield* fs.open(file, options)
					}),
				},
			)
			const result = yield* Effect.exit(pm.install({ added: "1" }))
			assert(Exit.isFailure(result))
			const collided = yield* Ref.get(collision)
			const savedPath = Option.getOrThrow(collided)
			const text = yield* fs.readFileString(savedPath)
			assert.strictEqual(text, "owned by someone else")
			const status = yield* pm.recoveryRequired
			assert(Option.isSome(status))
		}).pipe(run),
)
