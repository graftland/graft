/**
 * Node transports for remote services. A child process talks over stdio, and a
 * `worker_threads` worker talks over the worker channel. Both sides are thin
 * adapters over the `effect/rpc` protocols, so start and stop belong to the
 * calling scope: nothing here supervises a process or retries a connection.
 *
 * The child program must keep stdout for the protocol. Write diagnostics to
 * stderr instead.
 */

// @effect-diagnostics-next-line nodeBuiltinImport:off -- Spawning the child program is the transport itself.
import { spawn } from "node:child_process"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The child pipes are adapted into a socket, which is the transport itself.
import { Duplex } from "node:stream"
import {
	Worker as WorkerThread,
	type ResourceLimits,
} from "node:worker_threads"

import { Effect, Layer } from "effect"
import * as RpcClient from "effect/rpc/RpcClient"
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import type * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"
import type { WorkerError } from "effect/workers/WorkerError"
import {
	NodeSocket,
	NodeStdio,
	NodeWorker,
	NodeWorkerRunner,
} from "@effect/platform-node"

/** Options for a child process that serves RPC over its standard input and output. */
export interface SubprocessOptions {
	/** Path to the child program, run with the current Node executable unless `execPath` says otherwise. */
	readonly entry: string
	readonly args?: ReadonlyArray<string> | undefined
	/** Node flags placed before `entry`, such as `--import` or `--conditions`. */
	readonly execArgv?: ReadonlyArray<string> | undefined
	readonly execPath?: string | undefined
	readonly cwd?: string | undefined
	readonly env?: NodeJS.ProcessEnv | undefined
	/** Where the child's standard error goes. Inherited from this process by default. */
	readonly stderr?: "inherit" | "ignore" | undefined
}

/**
 * Connects to a child process whose standard input and output carry RPC
 * messages. Spawning happens in the current scope, and closing the scope kills
 * the child.
 */
export const subprocessProtocol = (
	options: SubprocessOptions,
): Effect.Effect<RpcClient.Protocol["Service"], RpcClientError, Scope.Scope> =>
	Effect.gen(function* () {
		const child = yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					spawn(
						options.execPath ?? process.execPath,
						[
							...(options.execArgv ?? []),
							options.entry,
							...(options.args ?? []),
						],
						{
							stdio: ["pipe", "pipe", options.stderr ?? "inherit"],
							...(options.cwd === undefined ? {} : { cwd: options.cwd }),
							...(options.env === undefined ? {} : { env: options.env }),
						},
					),
				catch: (cause) =>
					RpcClientError.make({
						reason: RpcClientDefect.make({
							message: "Failed to spawn the subprocess",
							cause,
						}),
					}),
			}),
			(child) =>
				Effect.sync(() => {
					child.kill()
				}),
		)
		const stdout = child.stdout!
		const stdin = child.stdin!
		const duplex = yield* Effect.try({
			try: () => {
				const stream = new Duplex({
					read: () => {
						stdout.resume()
					},
					write: (chunk, encoding, callback) => {
						stdin.write(chunk, encoding, callback)
					},
					final: (callback) => {
						stdin.end(callback)
					},
					destroy: (error, callback) => {
						stdout.destroy()
						stdin.destroy()
						callback(error)
					},
				})
				stdout.on("data", (chunk: Buffer) => {
					if (!stream.push(chunk)) stdout.pause()
				})
				stdout.on("end", () => {
					stream.push(null)
				})
				stdout.on("error", (cause) => stream.destroy(cause))
				stdin.on("error", (cause) => stream.destroy(cause))
				return stream
			},
			catch: (cause) =>
				RpcClientError.make({
					reason: RpcClientDefect.make({
						message: "Failed to open the subprocess pipes",
						cause,
					}),
				}),
		})
		const socket = yield* NodeSocket.fromDuplex(Effect.succeed(duplex))
		return yield* RpcClient.makeProtocolSocket().pipe(
			Effect.provideService(Socket.Socket, socket),
			// @effect-diagnostics-next-line strictEffectProvide:off -- The transport owns the serialization of its own connection.
			Effect.provide(Layer.fresh(RpcSerialization.layerNdjson)),
		)
	})

/** Options for a `worker_threads` worker that serves RPC over its parent channel. */
export interface WorkerOptions {
	readonly entry: string | URL
	readonly workerData?: unknown
	readonly execArgv?: ReadonlyArray<string> | undefined
	readonly env?: NodeJS.ProcessEnv | undefined
	readonly resourceLimits?: ResourceLimits | undefined
}

/**
 * Connects to a single `worker_threads` worker. Starting the worker belongs to
 * the current scope, and closing the scope terminates it. The worker serves
 * concurrent calls, including long-lived streams, so it is not held by one
 * call at a time.
 */
export const workerProtocol = (
	options: WorkerOptions,
): Effect.Effect<RpcClient.Protocol["Service"], WorkerError, Scope.Scope> =>
	RpcClient.makeProtocolWorker({ size: 1, concurrency: 1024 }).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- The transport owns its worker and serialization for the connection it builds.
		Effect.provide(
			Layer.merge(
				Layer.fresh(
					NodeWorker.layer(
						() =>
							new WorkerThread(options.entry, {
								...(options.workerData === undefined
									? {}
									: { workerData: options.workerData }),
								...(options.execArgv === undefined
									? {}
									: { execArgv: [...options.execArgv] }),
								...(options.env === undefined ? {} : { env: options.env }),
								...(options.resourceLimits === undefined
									? {}
									: { resourceLimits: options.resourceLimits }),
							}),
					),
				),
				Layer.fresh(RpcSerialization.layerNdjson),
			),
		),
	)

/**
 * Server protocol for a child process whose standard input and output carry
 * RPC messages.
 */
export const layerProtocolStdio: Layer.Layer<RpcServer.Protocol> =
	Layer.provide(
		Layer.provide(RpcServer.layerProtocolStdio, NodeStdio.layer),
		RpcSerialization.layerNdjson,
	)

/** Server protocol for code running inside a `worker_threads` worker. */
export const layerProtocolWorker: Layer.Layer<RpcServer.Protocol, WorkerError> =
	Layer.provide(
		Layer.provide(RpcServer.layerProtocolWorkerRunner, NodeWorkerRunner.layer),
		RpcSerialization.layerNdjson,
	)
