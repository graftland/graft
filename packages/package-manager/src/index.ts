/** Non-interactive package installation. Provide platform services at the application boundary. */
import {
	Array,
	Cause,
	Data,
	Ref,
	Effect,
	Exit,
	FileSystem,
	HashMap,
	Match,
	Option,
	Path,
	PlatformError,
	Record,
	Schema,
	Semaphore,
	String,
	Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
	PackageManagerDeclaration,
	PackageManagerName,
} from "./PackageManagerDeclaration"
export { PackageManagerDeclaration } from "./PackageManagerDeclaration"
import { terminateProcess } from "./process"
import {
	writeSnapshot,
	withSnapshot,
	type SnapshotCleanupFailure,
	inspectManagedFiles,
	UnsupportedFileTypeError,
	type Contents,
} from "./snapshot"
export {
	UnsupportedFileTypeError,
	type SnapshotCleanupFailure,
} from "./snapshot"
import {
	applyChanges,
	Changes,
	decodeManifest,
	encodeManifest,
	fields,
	type Manifest,
} from "./manifest"
export { Changes, PackageName } from "./manifest"

export const Agent = Schema.Literals([
	"npm",
	"pnpm",
	"yarn-classic",
	"yarn-berry",
])
export type Agent = typeof Agent.Type
export class PackageManagerError extends Schema.TaggedError<
	PackageManagerError,
	{ readonly brand: unique symbol }
>()("PackageManagerError", {
	operation: Schema.Literals(["detect", "install", "recover", "state"]),
	message: Schema.String,
	exitCode: Schema.optionalKey(Schema.Int),
}) {}
export class RecoveryRequiredError extends Schema.TaggedError<
	RecoveryRequiredError,
	{ readonly brand: unique symbol }
>()("RecoveryRequiredError", {
	directory: Schema.String,
	snapshotDirectory: Schema.String,
	operation: Schema.Literals(["install", "recover", "rollback"]),
	processId: Schema.optionalKey(Schema.Int),
	message: Schema.String,
	terminationCause: Schema.optionalKey(
		Schema.Cause(Schema.Unknown, Schema.Unknown),
	),
	recoveryCause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}

type WriterState = Data.TaggedEnum<{
	ManagedWritersIdle: {}
	Running: {}
	FileWrite: {}
	Unconfirmed: {
		readonly operation: "install" | "recover"
		readonly processId: number
		readonly cause: Cause.Cause<PlatformError.PlatformError>
	}
}>

const WriterState = Data.taggedEnum<WriterState>()

type ManagerState = Data.TaggedEnum<{
	Ready: {}
	Active: { readonly writer: WriterState }
	RecoveryRequired: { readonly error: RecoveryRequiredError }
}>

const ManagerState = Data.taggedEnum<ManagerState>()

export type Error =
	| PackageManagerError
	| UnsupportedFileTypeError
	| RecoveryRequiredError
	| PlatformError.PlatformError
	| Schema.SchemaError
export interface Options {
	/** Project directory, containing package.json. Use the workspace root for workspace installs. */
	readonly directory: string
	/** Explicit selection takes precedence over detection. */
	readonly agent?: Agent
	/** Optional npm_config_user_agent supplied by the caller; used only as a fallback. */
	readonly userAgent?: string
}
const lockfiles = [
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
] as const
const backupFiles = [
	"package.json",
	...lockfiles,
	".npmrc",
	"pnpm-workspace.yaml",
	".yarnrc",
	".yarnrc.yml",
	".yarn/install-state.gz",
	".pnp.cjs",
	".pnp.loader.mjs",
]
const strategy = (agent: Agent, operation: "install" | "recover") => {
	const recovery = operation === "recover"
	return Match.value(agent).pipe(
		Match.when("npm", () => ({
			executable: "npm",
			args: [
				"install",
				"--no-audit",
				"--no-fund",
				...(recovery ? ["--prefer-offline"] : []),
			],
			env: { CI: "true" },
			lockfiles: ["package-lock.json", "npm-shrinkwrap.json"],
		})),
		Match.when("pnpm", () => ({
			executable: "pnpm",
			args: [
				"install",
				recovery ? "--frozen-lockfile" : "--no-frozen-lockfile",
				"--config.confirmModulesPurge=false",
			],
			env: { CI: "true" },
			lockfiles: ["pnpm-lock.yaml"],
		})),
		Match.when("yarn-classic", () => ({
			executable: "yarn",
			args: [
				"install",
				"--non-interactive",
				...(recovery ? ["--frozen-lockfile", "--prefer-offline"] : []),
			],
			env: { CI: "true" },
			lockfiles: ["yarn.lock"],
		})),
		Match.when("yarn-berry", () => ({
			executable: "yarn",
			args: ["install", ...(recovery ? ["--immutable"] : [])],
			env: {
				CI: "true",
				YARN_ENABLE_IMMUTABLE_INSTALLS: recovery ? "true" : "false",
				YARN_NODE_LINKER: "node-modules",
			},
			lockfiles: ["yarn.lock"],
		})),
		Match.exhaustive,
	)
}

const readSource = Effect.fnUntraced(function* (
	fs: FileSystem.FileSystem,
	file: string,
) {
	const bytes = yield* fs.readFile(file)
	return yield* Effect.try({
		try: () =>
			new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes),
		catch: (cause) =>
			PlatformError.badArgument({
				module: "FileSystem",
				method: "readManifest",
				description: "The manifest must contain valid UTF-8",
				cause,
			}),
	})
})

const Executable = PackageManagerName
const Digits = Schema.String.check(Schema.isPattern(/^\d+$/))
const decodePackageManager = Schema.decodeUnknownOption(
	PackageManagerDeclaration,
)
/** `name/version ...`, as package managers set `npm_config_user_agent`. */
const decodeUserAgent = Schema.decodeUnknownOption(
	Schema.TemplateLiteralParser([Executable, "/", Digits, Schema.String]),
)
const agentOf = (name: typeof Executable.Type, major: string): Agent =>
	name === "yarn" ? (major === "1" ? "yarn-classic" : "yarn-berry") : name

/** packageManager, then lockfile, then caller user-agent, then npm. Conflicting lockfiles fail. */
export const detectAgent = Effect.fnUntraced(function* (options: Options) {
	if (options.agent !== undefined)
		return yield* Schema.decodeEffect(Agent)(options.agent)
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const manifest = yield* readSource(
		fs,
		path.join(options.directory, "package.json"),
	).pipe(Effect.flatMap(decodeManifest))
	if (manifest.packageManager !== undefined) {
		return yield* Option.match(decodePackageManager(manifest.packageManager), {
			onNone: () =>
				PackageManagerError.make({
					operation: "detect",
					message: `Unsupported packageManager: ${manifest.packageManager}`,
				}),
			onSome: ([name, , version]) =>
				Effect.succeed(agentOf(name, `${version.major}`)),
		})
	}
	const found = yield* Effect.filter(lockfiles, (file) =>
		fs.exists(path.join(options.directory, file)),
	)
	const kinds = Array.dedupe(
		Array.map(found, (file) =>
			file === "pnpm-lock.yaml"
				? "pnpm"
				: file === "yarn.lock"
					? "yarn"
					: "npm",
		),
	)
	if (kinds.length > 1)
		return yield* PackageManagerError.make({
			operation: "detect",
			message: "Conflicting lockfiles; select an agent explicitly",
		})
	if (kinds[0] === "yarn") {
		const metadata = yield* fs
			.stream(path.join(options.directory, "yarn.lock"))
			.pipe(
				Stream.decodeText(),
				Stream.mapAccum(
					// The initial newline models the start of the file.
					() => "\n",
					(tail, chunk) => {
						const text = tail + chunk
						// Preserve all ECMAScript line terminators, including across chunk boundaries.
						// Eleven characters retain a partial marker and its preceding character.
						return [
							String.slice(-11)(text),
							[/[\n\r\u2028\u2029]__metadata:/.test(text)],
						]
					},
				),
				Stream.filter((found) => found),
				Stream.runHead,
			)
		return Option.isSome(metadata) ? "yarn-berry" : "yarn-classic"
	}
	if (kinds[0] !== undefined) return kinds[0]
	return Option.match(decodeUserAgent(options.userAgent ?? ""), {
		onNone: () => "npm" as const,
		onSome: ([name, , major]) => agentOf(name, major),
	})
})

export interface PackageState {
	readonly spec: string
	/** Missing optional or not-yet-installed dependencies have no version/path. */
	readonly version: string | undefined
	readonly path: string | undefined
}
/** Direct dependencies only, keyed by their manifest names (including aliases). */
export type State = HashMap.HashMap<string, PackageState>
export interface PackageChange {
	readonly name: string
	readonly before: PackageState | undefined
	readonly after: PackageState | undefined
}
export interface StateDiff {
	readonly added: ReadonlyArray<PackageChange>
	readonly removed: ReadonlyArray<PackageChange>
	readonly updated: ReadonlyArray<PackageChange>
}
export const diffState = (before: State, after: State): StateDiff => {
	const changes = Array.map(
		Array.sort(
			Array.dedupe([...HashMap.keys(before), ...HashMap.keys(after)]),
			String.Order,
		),
		(name) => ({
			name,
			before: Option.getOrUndefined(HashMap.get(before, name)),
			after: Option.getOrUndefined(HashMap.get(after, name)),
		}),
	)
	return {
		added: Array.filter(changes, (change) => change.before === undefined),
		removed: Array.filter(changes, (change) => change.after === undefined),
		updated: Array.filter(
			changes,
			({ before, after }) =>
				before !== undefined &&
				after !== undefined &&
				(before.spec !== after.spec ||
					before.version !== after.version ||
					before.path !== after.path),
		),
	}
}
export interface InstallResult extends StateDiff {
	readonly agent: Agent
	/** The install committed; retry only snapshot deletion, not installation. */
	readonly snapshotCleanupFailure: Option.Option<SnapshotCleanupFailure>
}
export interface PackageManager {
	readonly directory: string
	readonly agent: Agent
	readonly readState: Effect.Effect<State, Error>
	/** Present when manual recovery is required; the manager cannot be reused. */
	readonly recoveryRequired: Effect.Effect<Option.Option<RecoveryRequiredError>>
	/** Serialized per manager. Empty changes installs the current manifest, including first installs. */
	readonly install: (changes: Changes) => Effect.Effect<InstallResult, Error>
}

/**
 * Own one manager per project. The caller must give this manager and its child
 * processes exclusive write access to the project for each install, including
 * recovery. Do not edit project files or run another installer concurrently.
 * Calls are serialized only within this manager; no cross-process lock is taken.
 * Managed paths must be regular files or absent. make and install reject symbolic
 * links and other file types with UnsupportedFileTypeError before any write.
 *
 * Accepted file writes finish before cancellation can start rollback or release
 * the lock. File writes and the original process group participate in the transaction.
 * Scripts must not create escaped writers in independent groups or daemons.
 * Failed or interrupted installs before commit restore backed-up package files byte-for-byte
 * with recorded permissions and ownership, and remove tracked files that did not
 * exist before installation. Writes made
 * during installation are overwritten by rollback, never merged. When a lockfile
 * existed, recovery also attempts to repair node_modules. Recovery failures are
 * combined with the original cause. If process termination cannot be confirmed,
 * no further restoration or recovery runs. Any failed rollback step also requires
 * manual recovery, even if all writers stopped. Only successful installation or
 * complete rollback permits snapshot deletion and reuse. RecoveryRequiredError
 * and recoveryRequired expose the retained snapshot directory and complete cause;
 * this manager rejects
 * all later installs. Complete manual recovery before making a new manager.
 * Committed installs report snapshot deletion failures in snapshotCleanupFailure
 * rather than failing or rolling back. No crash recovery is promised.
 */
export const make = (
	options: Options,
): Effect.Effect<
	PackageManager,
	Error,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const directory = path.resolve(options.directory)
		yield* inspectManagedFiles(fs, path, directory, backupFiles)
		const agent = yield* detectAgent({ ...options, directory })
		const lock = yield* Semaphore.make(1)
		const transaction = yield* Ref.make<ManagerState>(ManagerState.Ready())
		const manifestFile = path.join(directory, "package.json")
		const readManifest = readSource(fs, manifestFile).pipe(
			Effect.flatMap(decodeManifest),
		)
		const installed = Schema.decodeUnknownEffect(
			Schema.fromJsonString(
				Schema.Struct({ version: Schema.optionalKey(Schema.String) }),
			),
		)
		const stateOf = Effect.fnUntraced(function* (manifest: Manifest) {
			if (yield* fs.exists(path.join(directory, ".pnp.cjs")))
				return yield* PackageManagerError.make({
					operation: "state",
					message:
						"Plug'n'Play is not supported; configure Yarn with nodeLinker: node-modules",
				})
			const deps = Array.reduce(
				fields,
				{} as Readonly<Record<string, string>>,
				(all, field) => ({ ...all, ...manifest[field] }),
			)
			const entries = yield* Effect.forEach(
				Record.toEntries(deps),
				([name, spec]) =>
					Effect.gen(function* () {
						const file = path.join(
							directory,
							"node_modules",
							name,
							"package.json",
						)
						const source = yield* fs.readFileString(file).pipe(
							Effect.asSome,
							Effect.catchCauseIf(
								(cause) =>
									Array.every(
										cause.reasons,
										(reason) =>
											Cause.isFailReason(reason) &&
											reason.error.reason.module === "FileSystem" &&
											reason.error.reason._tag === "NotFound",
									),
								() => Effect.succeedNone,
							),
						)
						if (Option.isNone(source))
							return [
								name,
								{ spec, version: undefined, path: undefined },
							] as const
						const pkg = yield* installed(source.value)
						return [
							name,
							{
								spec,
								version: pkg.version,
								path: yield* fs.realPath(path.dirname(file)),
							},
						] as const
					}),
				{ concurrency: 16 },
			)
			return HashMap.fromIterable<string, PackageState>(entries)
		})
		const readState = Effect.flatMap(readManifest, stateOf)
		const termination: ChildProcess.KillOptions = {
			forceKillAfter: "5 seconds",
		}
		const run = Effect.fnUntraced(function* (operation: "install" | "recover") {
			const command = strategy(agent, operation)
			// Acquire and install the release handler atomically, then wait interruptibly.
			return yield* Effect.acquireUseRelease(
				spawner
					.spawn(
						ChildProcess.make(command.executable, command.args, {
							cwd: directory,
							extendEnv: true,
							stdin: "ignore",
							stdout: "inherit",
							stderr: "inherit",
							detached: true,
							...termination,
							env: command.env,
						}),
					)
					.pipe(
						Effect.tap(() =>
							Ref.set(
								transaction,
								ManagerState.Active({ writer: WriterState.Running() }),
							),
						),
					),
				(process) =>
					Effect.gen(function* () {
						const code = yield* process.exitCode.pipe(
							Effect.timeoutOrElse({
								duration: "10 minutes",
								orElse: () =>
									PackageManagerError.make({
										operation,
										message: `${command.executable} ${operation} timed out`,
									}),
							}),
						)
						if (code !== 0)
							return yield* PackageManagerError.make({
								operation,
								exitCode: code,
								message: `${command.executable} ${operation} exited with code ${code}`,
							})
					}),
				// The command owns its group; a stopped leader may leave live descendants.
				// Observe kill failures here rather than relying on best-effort scope cleanup.
				(process) =>
					Effect.gen(function* () {
						const result = yield* terminateProcess(process, termination)
						yield* Ref.set(
							transaction,
							ManagerState.Active({
								writer:
									result._tag === "OriginalGroupStopped"
										? WriterState.ManagedWritersIdle()
										: WriterState.Unconfirmed({
												operation,
												processId: process.pid,
												cause: result.cause,
											}),
							}),
						)
						if (result._tag === "Unconfirmed")
							return yield* Effect.failCause(result.cause)
					}),
			)
		}, Effect.scoped)
		// AbortSignal does not join accepted OS writes. Keep the writer owned until completion.
		const withFileWriter = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.acquireUseRelease(
				Ref.set(
					transaction,
					ManagerState.Active({ writer: WriterState.FileWrite() }),
				),
				() => effect,
				() =>
					Ref.set(
						transaction,
						ManagerState.Active({ writer: WriterState.ManagedWritersIdle() }),
					),
			).pipe(Effect.uninterruptible)

		const install = (changes: Changes) =>
			lock.withPermits(1)(
				Effect.gen(function* () {
					const state = yield* Ref.get(transaction)
					if (state._tag === "RecoveryRequired") return yield* state.error
					const validated = yield* Schema.decodeEffect(Changes)(changes)
					const inspected = yield* inspectManagedFiles(
						fs,
						path,
						directory,
						backupFiles,
					)
					const backups = yield* Effect.forEach(
						inspected,
						({ name, file, metadata }) =>
							Effect.gen(function* () {
								const contents = yield* Option.match(metadata, {
									onNone: () => Effect.succeedNone,
									onSome: (info) =>
										fs
											.readFile(file)
											.pipe(
												Effect.map((bytes) =>
													Option.some<Contents>({ ...info, bytes }),
												),
											),
								})
								return { name, file, contents }
							}),
					)
					const original = yield* readSource(fs, manifestFile)
					const manifest = yield* decodeManifest(original)
					const before = yield* stateOf(manifest)
					const text = yield* encodeManifest(
						applyChanges(manifest, validated),
						original,
					)

					const agentLocks = strategy(agent, "install").lockfiles
					const hasLock = Array.some(
						backups,
						({ name, contents }) =>
							Array.contains(agentLocks, name) && Option.isSome(contents),
					)
					const completed = yield* withSnapshot(
						fs,
						Ref.get(transaction).pipe(
							Effect.map((state) => state._tag === "Ready"),
						),
						(snapshotDirectory) =>
							Effect.gen(function* () {
								const snapshot = yield* writeSnapshot(
									fs,
									path,
									snapshotDirectory,
									directory,
									agent,
									backups,
								)
								const restore = Effect.flatMap(Ref.get(transaction), (state) =>
									state._tag === "Active" &&
									state.writer._tag === "ManagedWritersIdle"
										? withFileWriter(snapshot.restore(state.writer))
										: Effect.void,
								)
								return yield* Effect.acquireUseRelease(
									Ref.set(
										transaction,
										ManagerState.Active({
											writer: WriterState.ManagedWritersIdle(),
										}),
									),
									() =>
										Effect.gen(function* () {
											yield* withFileWriter(
												fs.writeFileString(manifestFile, text),
											)
											yield* run("install")
											const after = yield* readState
											return { agent, ...diffState(before, after) }
										}),
									(_, exit) =>
										Effect.gen(function* () {
											if (Exit.isFailure(exit)) {
												const state = yield* Ref.get(transaction)
												if (
													state._tag !== "Active" ||
													state.writer._tag !== "ManagedWritersIdle"
												)
													return
												yield* withFileWriter(snapshot.restore(state.writer))
												if (hasLock)
													yield* run("recover").pipe(
														// Even a failed recovery must restore files, once its writer has stopped.
														Effect.onExit(() => restore),
													)
											}
											// Idle managed writers alone do not prove that the transaction completed.
											yield* Ref.set(transaction, ManagerState.Ready())
										}),
								).pipe(
									Effect.onExit((exit) =>
										Effect.gen(function* () {
											const state = yield* Ref.get(transaction)
											if (Exit.isSuccess(exit) || state._tag !== "Active")
												return
											const writer = state.writer
											const error = RecoveryRequiredError.make({
												directory,
												snapshotDirectory,
												operation:
													writer._tag === "Unconfirmed"
														? writer.operation
														: "rollback",
												...(writer._tag === "Unconfirmed"
													? {
															processId: writer.processId,
															terminationCause: writer.cause,
														}
													: {}),
												message: `Manual recovery is required. Stop all writers before restoring the snapshot at ${snapshotDirectory}`,
												recoveryCause: exit.cause,
											})
											yield* Ref.set(
												transaction,
												ManagerState.RecoveryRequired({ error }),
											)
											return yield* error
										}),
									),
								)
							}),
					)
					return {
						...completed.value,
						snapshotCleanupFailure: completed.snapshotCleanupFailure,
					}
				}),
			)
		return {
			directory,
			agent,
			recoveryRequired: Ref.get(transaction).pipe(
				Effect.map((state) =>
					state._tag === "RecoveryRequired"
						? Option.some(state.error)
						: Option.none(),
				),
			),
			readState: lock.withPermits(1)(readState),
			install,
		}
	})
