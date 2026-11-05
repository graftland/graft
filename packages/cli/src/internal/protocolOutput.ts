import { NodeSink } from "@effect/platform-node"
import { Context, Effect, Logger, Option, PlatformError, Stdio } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a native Writable retains the protocol writer while Node forwards all diagnostic output to stderr.
import { Writable, finished } from "node:stream"
import process from "node:process"

// A peer that stops reading but keeps the pipe open must not hold shutdown forever.
const flushTimeout = 2_000
const flushTimedOut = new Error(
	"The protocol peer stopped reading during shutdown",
)

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
					const error = (cause: Error) => {
						stream.destroy(cause)
					}
					process.stdout.on("error", error)
					process.stderr.on("drain", drain)
					// Node's console and default worker forwarding use this same writer.
					process.stdout.write = process.stderr.write.bind(process.stderr)
					return { original, stream, drain, error }
				}),
				({ original, stream, drain, error }) =>
					Effect.callback<void>((resume) => {
						// @effect-diagnostics-next-line globalTimersInEffect:off -- finalizers are uninterruptible, so only a native timer can bound the flush by destroying the stream.
						const timer = setTimeout(() => {
							stream.destroy(flushTimedOut)
						}, flushTimeout)
						const cleanup = finished(stream, (cause) => {
							clearTimeout(timer)
							cleanup()
							const restore = () => {
								process.stdout.off("error", error)
								process.stderr.off("drain", drain)
								process.stdout.write = original
								// Unflushed bytes for a peer that stopped reading are dropped, not a cleanup failure.
								resume(
									cause == null || cause === flushTimedOut
										? Effect.void
										: Effect.die(cause),
								)
							}
							// Keep the native error listener until every accepted write and delayed error has settled.
							if (process.stdout.destroyed && !process.stdout.closed)
								process.stdout.once("close", restore)
							else restore()
						})
						stream.end()
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
