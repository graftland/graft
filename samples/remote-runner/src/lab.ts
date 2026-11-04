/**
 * Stands in for the runner machine, on this machine. It creates certificates,
 * installs packages the way a deployment would, and starts `graft-remote serve`
 * on 127.0.0.1. Closing the scope stops the runner.
 */
import {
	Deferred,
	Effect,
	FileSystem,
	Option,
	Path,
	Schema,
	Stream,
} from "effect"
import type { PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import process from "node:process"

export class LabFailed extends Schema.TaggedError<
	LabFailed,
	{ readonly brand: unique symbol }
>()("LabFailed", {
	reason: Schema.String,
}) {}

/** A built package to install under the runner's installation root. */
export interface Package {
	readonly name: string
	/** The build output, copied to the package's `dist` directory. */
	readonly dist: string
	readonly exports: Readonly<Record<string, string>>
}

export interface Options {
	/** Recreated on every start. Must sit inside this sample, so installed packages resolve `effect`. */
	readonly directory: string
	readonly certificates: string
	readonly packages: ReadonlyArray<Package>
}

const PackageJson = Schema.fromJsonString(
	Schema.Struct({
		name: Schema.String,
		version: Schema.String,
		type: Schema.Literal("module"),
		exports: Schema.Record(Schema.String, Schema.String),
	}),
)
const Listening = Schema.fromJsonString(
	Schema.Struct({ event: Schema.Literal("Listening"), port: Schema.Int }),
)

export const start = Effect.fn("Lab.start")(function* (options: Options) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	yield* fs.remove(options.directory, { recursive: true, force: true })

	const certificates = path.join(options.directory, "certificates")
	const code = yield* spawner.exitCode(
		ChildProcess.make("sh", [options.certificates, certificates], {
			stdout: "inherit",
			stderr: "inherit",
		}),
	)
	if (code !== 0)
		return yield* LabFailed.make({
			reason: `The certificate script exited with ${code}`,
		})

	const root = path.join(options.directory, "install")
	// The root's own manifest keeps Node from resolving this sample's package
	// name to the enclosing workspace package instead of the installed copy.
	yield* fs.makeDirectory(root, { recursive: true })
	yield* fs.writeFileString(
		path.join(root, "package.json"),
		'{ "private": true }\n',
	)
	yield* Effect.forEach(options.packages, (pkg) =>
		Effect.gen(function* () {
			const directory = path.join(root, "node_modules", pkg.name)
			yield* fs.makeDirectory(directory, { recursive: true })
			yield* fs.copy(pkg.dist, path.join(directory, "dist"))
			const manifest = yield* Schema.encodeEffect(PackageJson)({
				name: pkg.name,
				version: "0.0.0",
				type: "module",
				exports: pkg.exports,
			})
			yield* fs.writeFileString(path.join(directory, "package.json"), manifest)
		}),
	)

	const runner = yield* ChildProcess.make(
		process.execPath,
		[
			path.join(root, "node_modules/@graftland/remote/dist/bin.js"),
			"serve",
			...["--host", "127.0.0.1", "--port", "0"],
			...["--root", root, "--state", path.join(options.directory, "state")],
			...["--cert", path.join(certificates, "server.crt")],
			...["--key", path.join(certificates, "server.key")],
			...["--ca", path.join(certificates, "ca.crt")],
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "inherit" },
	)
	// The runner announces its port on stdout. Keep reading so it never blocks on a full pipe.
	const ready = yield* Deferred.make<number, PlatformError.PlatformError>()
	yield* runner.stdout.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.runForEach((line) =>
			Option.match(Schema.decodeOption(Listening)(line), {
				onNone: () => Effect.void,
				onSome: ({ port }) => Deferred.succeed(ready, port),
			}),
		),
		Effect.onError((cause) => Deferred.failCause(ready, cause)),
		Effect.forkScoped,
	)
	const port = yield* Deferred.await(ready).pipe(
		Effect.raceFirst(
			runner.exitCode.pipe(
				Effect.flatMap((code) =>
					LabFailed.make({ reason: `The runner exited with ${code}` }),
				),
			),
		),
		Effect.timeoutOrElse({
			duration: "30 seconds",
			orElse: () => LabFailed.make({ reason: "The runner did not start" }),
		}),
	)

	// The host reads these as environment variables: where the runner is, and where the ledger lives.
	return {
		RUNNER_HOST: "127.0.0.1",
		RUNNER_PORT: `${port}`,
		RUNNER_SERVERNAME: "localhost",
		RUNNER_CA: path.join(certificates, "ca.crt"),
		RUNNER_CERT: path.join(certificates, "client.crt"),
		RUNNER_KEY: path.join(certificates, "client.key"),
		LEDGER_FILE: path.join(options.directory, "ledger.json"),
	}
})
