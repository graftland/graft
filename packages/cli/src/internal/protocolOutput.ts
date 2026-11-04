import { NodeSink } from "@effect/platform-node"
import { Context, Effect, Logger, Option, PlatformError, Stdio } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a native Writable retains the protocol writer while Node forwards all diagnostic output to stderr.
import { Writable } from "node:stream"
import process from "node:process"

export const ProtocolStdio = Context.Reference(
	"@graftland/cli/internal/ProtocolStdio",
	{ defaultValue: (): Option.Option<Stdio.Stdio> => Option.none() },
)

/** Reserve the original stdout writer for Stdio; all process diagnostics use stderr. */
export const reserve = <A, E, R>(program: Effect.Effect<A, E, R>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const stdio = yield* Stdio.Stdio
			const protocol = yield* Effect.acquireRelease(
				Effect.sync(() => {
					const original = process.stdout.write
					const write = original.bind(process.stdout)
					const stream = new Writable({
						write: (chunk, encoding, done) => {
							write(chunk, encoding, done)
						},
					})
					// Default worker forwarding waits for stdout's drain after write returns false.
					const drain = () => {
						process.stdout.emit("drain")
					}
					process.stderr.on("drain", drain)
					// Node's console and default worker forwarding use this same writer.
					process.stdout.write = process.stderr.write.bind(process.stderr)
					return { original, stream, drain }
				}),
				({ original, stream, drain }) =>
					Effect.sync(() => {
						process.stderr.off("drain", drain)
						process.stdout.write = original
						stream.destroy()
					}),
			)
			const reserved = {
				...stdio,
				stdout: (options?: { readonly endOnDone?: boolean }) =>
					NodeSink.fromWritable({
						evaluate: () => protocol.stream,
						onError: (cause) =>
							PlatformError.systemError({
								module: "Stdio",
								method: "stdout",
								_tag: "Unknown",
								cause,
							}),
						endOnDone: options?.endOnDone ?? false,
					}),
			}
			return yield* program.pipe(
				Effect.provideService(Logger.LogToStderr, true),
				Effect.provideService(Stdio.Stdio, reserved),
				Effect.provideService(ProtocolStdio, Option.some(reserved)),
			)
		}),
	)
