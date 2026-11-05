import {
	Array,
	Cause,
	Effect,
	Equal,
	Exit,
	Option,
	Random,
	Schema,
	Scope,
	type FileSystem,
	type Path,
	type PlatformError,
} from "effect"

/** File writes have completed and the original installer group is stopped or absent. */
export interface ManagedWritersIdle {
	readonly _tag: "ManagedWritersIdle"
}

export interface SnapshotCleanupFailure {
	readonly snapshotDirectory: string
	readonly cause: Cause.Cause<PlatformError.PlatformError>
}

/** Separate the transaction's outcome from disposal of its snapshot. */
export const withSnapshot = <A, E, R>(
	fs: FileSystem.FileSystem,
	canDelete: Effect.Effect<boolean>,
	use: (directory: string) => Effect.Effect<A, E, R>,
) =>
	Effect.uninterruptibleMask((resume) =>
		Effect.gen(function* () {
			const snapshotDirectory = yield* fs.makeTempDirectory({
				prefix: "graft-recovery-",
			})
			const outcome = yield* resume(
				Effect.suspend(() => use(snapshotDirectory)),
			).pipe(Effect.exit)
			const cleanup = (yield* canDelete)
				? yield* Effect.suspend(() =>
						fs.remove(snapshotDirectory, { recursive: true }),
					).pipe(Effect.exit)
				: Exit.void
			if (Exit.isFailure(outcome)) {
				return yield* Effect.failCause(
					Exit.isFailure(cleanup)
						? Cause.combine(outcome.cause, cleanup.cause)
						: outcome.cause,
				)
			}
			return yield* resume(
				Effect.succeed({
					value: outcome.value,
					snapshotCleanupFailure: Exit.isFailure(cleanup)
						? Option.some<SnapshotCleanupFailure>({
								snapshotDirectory,
								cause: cleanup.cause,
							})
						: Option.none<SnapshotCleanupFailure>(),
				}),
			).pipe(
				// Cancellation can prevent delivery, but must not hide a cleanup failure.
				Effect.onExit((exit) =>
					Exit.isFailure(exit) && Exit.isFailure(cleanup)
						? Effect.failCause(cleanup.cause)
						: Effect.void,
				),
			)
		}),
	)

export class UnsupportedFileTypeError extends Schema.TaggedError<
	UnsupportedFileTypeError,
	{ readonly brand: unique symbol }
>()("UnsupportedFileTypeError", {
	path: Schema.String,
	fileType: Schema.String,
	message: Schema.String,
}) {}

interface RegularFileMetadata {
	readonly mode: number
	readonly uid: Option.Option<number>
	readonly gid: Option.Option<number>
}
export interface Contents extends RegularFileMetadata {
	readonly bytes: Uint8Array
}
export interface Backup {
	readonly name: string
	readonly file: string
	readonly contents: Option.Option<Contents>
}

/** lstat distinguishes missing paths from links, including dangling links. */
export const inspectManagedFiles = Effect.fnUntraced(function* (
	fs: FileSystem.FileSystem,
	path: Path.Path,
	directory: string,
	names: ReadonlyArray<string>,
) {
	return yield* Effect.forEach(
		names,
		Effect.fnUntraced(function* (name) {
			const file = path.join(directory, name)
			const metadata = yield* fs.lstat(file).pipe(
				Effect.flatMap((info) =>
					info.type === "File"
						? Effect.succeed<RegularFileMetadata>({
								mode: info.mode & 0o7777,
								uid: info.uid,
								gid: info.gid,
							})
						: Effect.fail(
								UnsupportedFileTypeError.make({
									path: file,
									fileType: info.type,
									message: `Managed paths must be regular files or absent: ${file} is ${info.type}`,
								}),
							),
				),
				Effect.asSome,
				// Only an entirely missing-path failure establishes absence.
				Effect.catchCauseIf(
					(cause) =>
						Array.every(
							cause.reasons,
							(reason) =>
								Cause.isFailReason(reason) &&
								reason.error._tag === "PlatformError" &&
								reason.error.reason.module === "FileSystem" &&
								reason.error.reason.method === "lstat" &&
								reason.error.reason._tag === "NotFound",
						),
					() => Effect.succeedNone,
				),
			)
			return { name, file, metadata }
		}),
	)
})

const encodeInventory = Schema.encodeEffect(
	Schema.fromJsonString(
		Schema.Struct({
			directory: Schema.String,
			agent: Schema.String,
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
		{ space: 2 },
	),
)

/** Persist every byte before allowing the installer to modify the project. */
export const writeSnapshot = Effect.fnUntraced(function* (
	fs: FileSystem.FileSystem,
	path: Path.Path,
	snapshotDirectory: string,
	directory: string,
	agent: string,
	backups: ReadonlyArray<Backup>,
) {
	const files = yield* Effect.forEach(
		backups,
		Effect.fnUntraced(function* (entry, index) {
			if (Option.isNone(entry.contents))
				return {
					name: entry.name,
					backup: null,
					mode: null,
					uid: null,
					gid: null,
				}
			const { bytes, mode, uid, gid } = entry.contents.value
			const backup = `${index}.bin`
			yield* fs.writeFile(path.join(snapshotDirectory, backup), bytes, {
				mode: 0o600,
			})
			return {
				name: entry.name,
				backup,
				mode,
				uid: Option.getOrNull(uid),
				gid: Option.getOrNull(gid),
			}
		}),
	)
	const inventory = yield* encodeInventory({ directory, agent, files })
	yield* fs.writeFileString(
		path.join(snapshotDirectory, "snapshot.json"),
		inventory,
		{ mode: 0o600 },
	)
	return {
		// The caller must establish that file writes and the original process group have stopped.
		restore: (_idle: ManagedWritersIdle) =>
			Array.reduce<Backup, Effect.Effect<void, PlatformError.PlatformError>>(
				backups,
				Effect.void,
				(previous, { file, contents }) =>
					previous.pipe(
						Effect.onExit(() =>
							Option.match(contents, {
								onNone: () => fs.remove(file, { force: true }),
								onSome: (contents) => restoreFile(fs, path, file, contents),
							}),
						),
					),
			),
	}
}, Effect.uninterruptible)

/** Create privately and restore metadata before making the replacement visible. */
const restoreFile = Effect.fnUntraced(function* (
	fs: FileSystem.FileSystem,
	path: Path.Path,
	target: string,
	contents: Contents,
) {
	yield* fs.makeDirectory(path.dirname(target), { recursive: true })
	const suffix = yield* Random.nextIntBetween(0, 0xffffffff)
	const temporary = `${target}.${suffix.toString(16)}.tmp`
	yield* Effect.acquireUseRelease(
		Scope.make(),
		(scope) =>
			Effect.acquireUseRelease(
				fs
					.open(temporary, { flag: "wx", mode: 0o600 })
					.pipe(Effect.provideService(Scope.Scope, scope)),
				Effect.fnUntraced(function* (file) {
					yield* file.writeAll(contents.bytes)
					const current = yield* file.stat
					const { uid, gid } = contents
					if (
						Option.isSome(uid) &&
						Option.isSome(gid) &&
						(!Equal.equals(uid, current.uid) || !Equal.equals(gid, current.gid))
					) {
						yield* fs.chown(temporary, uid.value, gid.value)
					}
					yield* fs.chmod(temporary, contents.mode)
					yield* file.sync
					yield* Scope.close(scope, Exit.void)
					yield* fs.rename(temporary, target)
				}),
				(_, exit) =>
					Exit.isSuccess(exit)
						? Effect.void
						: Scope.close(scope, exit).pipe(
								Effect.onExit(() => fs.remove(temporary, { force: true })),
							),
			),
		(scope, exit) => Scope.close(scope, exit),
	)
})
