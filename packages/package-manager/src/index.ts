/** Non-interactive package installation. Provide platform services at the application boundary. */
import {
	Array as Arr,
	Effect,
	Exit,
	FileSystem,
	HashMap,
	Option,
	Path,
	Record,
	Schema,
	Semaphore,
	String as Str,
} from "effect"
import type { PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
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
export type Error =
	PackageManagerError | PlatformError.PlatformError | Schema.SchemaError
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
const executable = (agent: Agent) =>
	Str.startsWith("yarn")(agent) ? "yarn" : agent

/** packageManager, then lockfile, then caller user-agent, then npm. Conflicting lockfiles fail. */
export const detectAgent = Effect.fnUntraced(function* (options: Options) {
	if (options.agent !== undefined)
		return yield* Schema.decodeEffect(Agent)(options.agent)
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const manifest = yield* fs
		.readFileString(path.join(options.directory, "package.json"))
		.pipe(Effect.flatMap(decodeManifest))
	if (manifest.packageManager !== undefined) {
		const match = /^(npm|pnpm|yarn)@(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(
			manifest.packageManager,
		)
		if (match === null)
			return yield* PackageManagerError.make({
				operation: "detect",
				message: `Unsupported packageManager: ${manifest.packageManager}`,
			})
		return match[1] === "yarn"
			? match[2] === "1"
				? "yarn-classic"
				: "yarn-berry"
			: (match[1] as "npm" | "pnpm")
	}
	const found = yield* Effect.filter(lockfiles, (file) =>
		fs.exists(path.join(options.directory, file)),
	)
	const kinds = Arr.dedupe(
		Arr.map(found, (file) =>
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
		const lock = yield* fs.readFileString(
			path.join(options.directory, "yarn.lock"),
		)
		return /^__metadata:/m.test(lock) ? "yarn-berry" : "yarn-classic"
	}
	if (kinds[0] !== undefined) return kinds[0]
	const caller = /^(npm|pnpm|yarn)\/(\d+)/.exec(options.userAgent ?? "")
	return caller?.[1] === "yarn"
		? caller[2] === "1"
			? "yarn-classic"
			: "yarn-berry"
		: caller?.[1] === "pnpm"
			? "pnpm"
			: "npm"
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
	const changes = Arr.map(
		Arr.sort(
			Arr.dedupe([...HashMap.keys(before), ...HashMap.keys(after)]),
			Str.Order,
		),
		(name) => ({
			name,
			before: Option.getOrUndefined(HashMap.get(before, name)),
			after: Option.getOrUndefined(HashMap.get(after, name)),
		}),
	)
	return {
		added: Arr.filter(changes, (change) => change.before === undefined),
		removed: Arr.filter(changes, (change) => change.after === undefined),
		updated: Arr.filter(
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
}
export interface PackageManager {
	readonly directory: string
	readonly agent: Agent
	readonly readState: Effect.Effect<State, Error>
	/** Serialized per manager. Empty changes installs the current manifest, including first installs. */
	readonly install: (changes: Changes) => Effect.Effect<InstallResult, Error>
}

/**
 * Own one manager per project. Failed or interrupted installs restore the exact
 * manifest/lockfiles, then attempt to repair node_modules when a lockfile existed.
 * Recovery failures are combined with the original cause. No crash recovery is promised.
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
		const agent = yield* detectAgent({ ...options, directory })
		const lock = yield* Semaphore.make(1)
		const manifestFile = path.join(directory, "package.json")
		const readManifest = fs
			.readFileString(manifestFile)
			.pipe(Effect.flatMap(decodeManifest))
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
			const deps = Arr.reduce(
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
						if (!(yield* fs.exists(file)))
							return [
								name,
								{ spec, version: undefined, path: undefined },
							] as const
						const pkg = yield* fs
							.readFileString(file)
							.pipe(Effect.flatMap(installed))
						return [
							name,
							{
								spec,
								version: pkg.version,
								path: yield* fs.realPath(path.dirname(file)),
							},
						] as const
					}),
			)
			return HashMap.fromIterable<string, PackageState>(entries)
		})
		const readState = Effect.flatMap(readManifest, stateOf)
		const run = Effect.fnUntraced(function* (operation: "install" | "recover") {
			const recovery = operation === "recover"
			const args =
				agent === "npm"
					? [
							"install",
							"--no-audit",
							"--no-fund",
							...(recovery ? ["--prefer-offline"] : []),
						]
					: agent === "pnpm"
						? [
								"install",
								recovery ? "--frozen-lockfile" : "--no-frozen-lockfile",
								"--config.confirmModulesPurge=false",
							]
						: agent === "yarn-classic"
							? [
									"install",
									"--non-interactive",
									...(recovery
										? ["--frozen-lockfile", "--prefer-offline"]
										: []),
								]
							: ["install", ...(recovery ? ["--immutable"] : [])]
			const code = yield* spawner
				.exitCode(
					ChildProcess.make(executable(agent), args, {
						cwd: directory,
						extendEnv: true,
						stdin: "ignore",
						stdout: "inherit",
						stderr: "inherit",
						env: {
							CI: "true",
							...(agent === "yarn-berry"
								? {
										YARN_ENABLE_IMMUTABLE_INSTALLS: recovery ? "true" : "false",
										YARN_NODE_LINKER: "node-modules",
									}
								: {}),
						},
					}),
				)
				.pipe(
					Effect.timeoutOrElse({
						duration: "10 minutes",
						orElse: () =>
							PackageManagerError.make({
								operation,
								message: `${executable(agent)} ${operation} timed out`,
							}),
					}),
				)
			if (code !== 0)
				return yield* PackageManagerError.make({
					operation,
					exitCode: code,
					message: `${executable(agent)} ${operation} exited with code ${code}`,
				})
		})
		const install = (changes: Changes) =>
			lock.withPermits(1)(
				Effect.gen(function* () {
					const validated = yield* Schema.decodeEffect(Changes)(changes)
					const original = yield* fs.readFileString(manifestFile)
					const manifest = yield* decodeManifest(original)
					const before = yield* stateOf(manifest)
					const text = yield* encodeManifest(
						applyChanges(manifest, validated),
						original,
					)
					const backups = yield* Effect.forEach(backupFiles, (name) =>
						Effect.gen(function* () {
							const file = path.join(directory, name)
							return {
								name,
								file,
								bytes: (yield* fs.exists(file))
									? yield* fs.readFile(file).pipe(Effect.asSome)
									: Option.none<Uint8Array>(),
							}
						}),
					)
					// Every file gets a restoration attempt; onExit combines failures.
					const restore = Arr.reduce<
						(typeof backups)[number],
						Effect.Effect<void, PlatformError.PlatformError>
					>(backups, Effect.void, (previous, { file, bytes }) =>
						previous.pipe(
							Effect.onExit(() =>
								Option.match(bytes, {
									onNone: () => fs.remove(file, { force: true }),
									onSome: (bytes) => fs.writeFile(file, bytes),
								}),
							),
						),
					)
					const agentLocks =
						agent === "npm"
							? ["package-lock.json", "npm-shrinkwrap.json"]
							: agent === "pnpm"
								? ["pnpm-lock.yaml"]
								: ["yarn.lock"]
					const hasLock = Arr.some(
						backups,
						({ name, bytes }) =>
							Arr.contains(agentLocks, name) && Option.isSome(bytes),
					)
					return yield* Effect.acquireUseRelease(
						Effect.void,
						() =>
							Effect.gen(function* () {
								yield* fs.writeFileString(manifestFile, text)
								yield* run("install")
								const after = yield* readState
								return { agent, ...diffState(before, after) }
							}),
						(_, exit) =>
							Exit.isSuccess(exit)
								? Effect.void
								: restore.pipe(
										Effect.andThen(hasLock ? run("recover") : Effect.void),
										// Recovery itself may rewrite the manifest or lockfile, including on failure.
										Effect.onExit(() => restore),
									),
					)
				}),
			)
		return {
			directory,
			agent,
			readState: lock.withPermits(1)(readState),
			install,
		}
	})
