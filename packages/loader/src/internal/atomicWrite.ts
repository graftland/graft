import { isOnlyFailure } from "./recovery"
import {
	Effect,
	Equal,
	Exit,
	FileSystem,
	Option,
	Random,
	Schema,
	Scope,
	type PlatformError,
} from "effect"

/** The file changed while a replacement was being prepared. Contains no configuration data. */
export class WriteConflict extends Schema.TaggedError<
	WriteConflict,
	{ readonly brand: unique symbol }
>()("WriteConflict", { path: Schema.String }) {}

/** Replace a file without widening its permissions or leaving an unowned temporary file. */
export const atomicWrite = Effect.fnUntraced(function* (
	target: string,
	text: string,
	expected?: Option.Option<string>,
	verifyTarget?: Effect.Effect<
		void,
		WriteConflict | PlatformError.PlatformError
	>,
) {
	const fs = yield* FileSystem.FileSystem
	const previous = yield* fs.stat(target).pipe(
		Effect.asSome,
		Effect.catchCauseIf(
			(cause) =>
				isOnlyFailure(cause, (error) => error.reason._tag === "NotFound"),
			() => Effect.succeedNone,
		),
	)
	const suffix = yield* Random.nextIntBetween(0, 0xffffffff)
	const temporary = `${target}.${suffix.toString(16)}.tmp`
	yield* Effect.acquireUseRelease(
		Scope.make(),
		(scope) =>
			Effect.acquireUseRelease(
				// Exclusive creation also rejects an existing symlink. Failed acquisition
				// never removes a path owned by someone else.
				fs
					.open(temporary, { flag: "wx", mode: 0o600 })
					.pipe(Effect.provideService(Scope.Scope, scope)),
				(file) =>
					Effect.gen(function* () {
						// Native writes must settle before cancellation closes the file or removes its path.
						yield* file
							.writeAll(new TextEncoder().encode(text))
							.pipe(Effect.uninterruptible)
						if (Option.isSome(previous)) {
							const current = yield* file.stat
							const { uid, gid } = previous.value
							if (
								Option.isSome(uid) &&
								Option.isSome(gid) &&
								(!Equal.equals(uid, current.uid) ||
									!Equal.equals(gid, current.gid))
							) {
								yield* fs
									.chown(temporary, uid.value, gid.value)
									.pipe(Effect.uninterruptible)
							}
						}
						const mode = Option.match(previous, {
							onNone: () => 0o600,
							onSome: (info) => info.mode & 0o7777,
						})
						yield* fs.chmod(temporary, mode).pipe(Effect.uninterruptible)
						yield* file.sync.pipe(Effect.uninterruptible)
						// Close the handle before committing; no fallible cleanup follows rename.
						yield* Scope.close(scope, Exit.void)
						if (expected !== undefined) {
							const current = yield* fs.readFileString(target).pipe(
								Effect.asSome,
								Effect.catchCauseIf(
									(cause) =>
										isOnlyFailure(
											cause,
											(error) => error.reason._tag === "NotFound",
										),
									() => Effect.succeedNone,
								),
							)
							if (!Equal.equals(current, expected))
								return yield* WriteConflict.make({ path: target })
						}
						// Recheck the configured path too: a link may have changed targets
						// while the temporary file was being prepared.
						if (verifyTarget !== undefined) yield* verifyTarget
						// Editors do not share our lock: checking and renaming cannot be atomic.
						yield* fs.rename(temporary, target).pipe(Effect.uninterruptible)
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
