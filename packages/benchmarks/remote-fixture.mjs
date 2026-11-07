import { createHash } from "node:crypto"
import {
	cp,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
	Cause,
	Console,
	Context,
	Effect,
	Exit,
	Layer,
	Logger,
	Option,
	Scope,
	Stream,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { NodeServices } from "@effect/platform-node"

import { Graft, Plugin } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import * as Remote from "@graftland/plugin-remote"
import noneHost from "@graftland/plugin-remote/host/auth/none"
import localHost from "@graftland/plugin-remote/host/local"
import unixHost from "@graftland/plugin-remote/host/unix"
import websocketHost from "@graftland/plugin-remote/host/websocket"
import workerHost from "@graftland/plugin-remote/host/worker"
import runner from "@graftland/plugin-remote/runner"
import none from "@graftland/plugin-remote/runner/auth/none"
import unix from "@graftland/plugin-remote/runner/unix"
import websocket from "@graftland/plugin-remote/runner/websocket"

import { withCleanup } from "./cleanup.mjs"
import { Api, contract, Signals } from "./dist/remote-contract.js"
import implementation from "./dist/remote-implementation.js"
import { completed } from "./remote-native.mjs"

const Unrelated = Context.Service("@graftland/benchmarks/Unrelated")
const directory = fileURLToPath(new URL(".", import.meta.url))
export const prepareRemote = async () => {
	const names = ["remote-contract.js", "remote-implementation.js"]
	const contents = await completed(
		names.map((name) => readFile(resolve(directory, "dist", name))),
	)
	const digest = createHash("sha256")
	for (const content of contents) digest.update(content)
	digest.update("package-exports-v2")
	const root = resolve(
		directory,
		`.cache/remote-install-${digest.digest("hex")}`,
	)
	try {
		await readFile(resolve(root, "ready"))
		return root
	} catch (error) {
		if (error.code !== "ENOENT") throw error
	}
	const stage = await mkdtemp(
		resolve(directory, ".cache/remote-install-stage-"),
	)
	try {
		const target = resolve(stage, "node_modules/benchmark-remote")
		await mkdir(target, { recursive: true })
		for (const name of names)
			await cp(resolve(directory, "dist", name), resolve(target, name))
		await writeFile(
			resolve(target, "package.json"),
			JSON.stringify({
				name: "benchmark-remote",
				version: "1.0.0",
				type: "module",
				exports: {
					".": "./remote-contract.js",
					"./implementation": "./remote-implementation.js",
				},
			}),
		)
		await writeFile(resolve(stage, "ready"), "complete")
		try {
			await rename(stage, root)
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error
		}
	} finally {
		await rm(stage, { recursive: true, force: true })
	}
	return root
}

const active = (fork) =>
	Effect.gen(function* () {
		yield* fork.stable
		yield* fork.await
		const state = yield* Stream.runHead(fork.state)
		if (Option.isNone(state) || state.value._tag !== "Active")
			return yield* Effect.die(new Error("Remote benchmark fork is not Active"))
	})
export const makeRemote = async (connection, probe, hooks = {}) => {
	const scope = await Effect.runPromise(Scope.make())
	const observer = {
		logs: 0,
		dropped: 0,
		warnings: 0,
		console: [],
		notices: [],
		activations: 0,
		finalizers: 0,
		causes: [],
		diagnostics: [],
	}
	const logger = Logger.make((entry) => {
		const messages = Array.isArray(entry.message)
			? entry.message
			: [entry.message]
		if (messages.includes("benchmark remote log")) observer.logs++
		if (
			["Warn", "Error", "Fatal"].includes(entry.logLevel) &&
			!messages.includes("Remote logs were dropped")
		)
			observer.diagnostics.push({
				level: entry.logLevel,
				message: entry.message,
				causeData: entry.cause,
			})
		if (messages.includes("Remote logs were dropped")) {
			observer.warnings++
			const annotations = entry.fiber.getRef(
				(Logger.CurrentLoggers,
				/* annotations are a Context reference, read below */ logAnnotations),
			)
			observer.dropped += Number(annotations["remote.logs.dropped"] ?? 0)
		}
	})
	const { CurrentLogAnnotations: logAnnotations } =
		await import("effect/References")
	const quiet = {
		...Console.Console.defaultValue(),
		log: (...args) => observer.console.push(args),
	}
	const modules = ModuleResolver.fromRecord({
		"@graftland/plugin-remote/host/local": localHost,
		"@graftland/plugin-remote/host/worker": workerHost,
		"@graftland/plugin-remote/host/unix": unixHost,
		"@graftland/plugin-remote/host/websocket": websocketHost,
		"@graftland/plugin-remote/host/auth/none": noneHost,
		"@graftland/plugin-remote/runner/unix": unix,
		"@graftland/plugin-remote/runner/websocket": websocket,
		"@graftland/plugin-remote/runner/auth/none": none,
	})
	const platform = Layer.mergeAll(
		NodeServices.layer,
		SecureRandom.layerWebCrypto,
		Digest.layerWebCrypto,
		Logger.layer([logger]),
		Layer.succeed(Console.Console, quiet),
		modules,
	)
	let context
	let folder
	let socketDirectory
	const entries = []
	let unrelated
	const run = (effect) =>
		Effect.runPromise(
			effect.pipe(Effect.provide(context), Scope.provide(scope)),
		)
	const closeScope = () => Effect.runPromise(Scope.close(scope, Exit.void))
	const destroy = async (capture = false) =>
		withCleanup(
			capture
				? () => Effect.runPromise(Effect.exit(Scope.close(scope, Exit.void)))
				: closeScope,
			async () => {
				if (socketDirectory) await socketDirectory.close()
				if (folder) await rm(folder, { recursive: true, force: true })
			},
		)
	try {
		context = await Effect.runPromise(
			Layer.buildWithScope(
				Layer.fresh(Graft.layer.pipe(Layer.provideMerge(platform))),
				scope,
			),
		)
		await run(
			Effect.gen(function* () {
				const resolver = yield* ModuleResolver.ModuleResolver
				yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
				yield* Graft.provide(Signals, {
					notice: (kind) =>
						Effect.sync(() => {
							const timestamp = performance.now()
							observer.notices.push({ kind, timestamp })
							hooks.notice?.(kind, timestamp)
						}),
				})
			}),
		)
		const unrelatedProvider = await run(
			Graft.plugin(
				Plugin.make({
					name: "unrelated service",
					apply: () =>
						Graft.provide(Unrelated, { ping: () => Effect.succeed(42) }),
				}),
			),
		)
		await run(active(unrelatedProvider))
		const unrelatedConsumer = await run(
			Graft.plugin(
				Plugin.make({
					name: "unrelated consumer",
					inject: [Unrelated],
					apply: () =>
						Effect.gen(function* () {
							unrelated = yield* Unrelated
						}),
				}),
			),
		)
		await run(active(unrelatedConsumer))
		let connect =
			connection === "remote-local"
				? { local: {} }
				: { worker: { execArgv: [] } }
		let contractModule = fileURLToPath(
			new URL("./dist/remote-contract.js", import.meta.url),
		)
		let implementationModule = fileURLToPath(
			new URL("./dist/remote-implementation.js", import.meta.url),
		)
		if (connection === "remote-unix" || connection === "remote-ws") {
			const root = await prepareRemote()
			folder = await mkdtemp(resolve(directory, ".cache/remote-run-"))
			let listen
			if (connection === "remote-unix") {
				// The actual socket inode stays inside this worktree despite its long absolute path.
				socketDirectory = await open(folder, "r")
				const path = `/proc/self/fd/${socketDirectory.fd}/runner.sock`
				listen = { unix: path }
				connect = { unix: path, instance: `benchmark-${entries.length}` }
			} else {
				listen = { url: "ws://127.0.0.1:0", auth: { none: {} } }
				connect = {}
			}
			const server = await run(
				Graft.plugin(runner, {
					root,
					state: resolve(folder, "state"),
					...(hooks.testLease ? { lease: hooks.testLease } : {}),
					listen: [listen],
				}),
			)
			await run(active(server))
			if (connection === "remote-ws") {
				const listening = observer.console
					.flat()
					.map((s) => {
						try {
							return JSON.parse(s)
						} catch {
							return null
						}
					})
					.find((s) => s?.event === "Listening")
				if (!listening?.port)
					throw new Error(
						`Runner did not report its bound loopback port: ${JSON.stringify(observer.console)}`,
					)
				connect = {
					url: `ws://127.0.0.1:${listening.port}`,
					instance: `benchmark-${entries.length}`,
					auth: { none: {} },
				}
			}
			contractModule = "benchmark-remote"
			implementationModule = "benchmark-remote/implementation"
		}
		return {
			observer,
			run,
			unrelated: () => run(unrelated.ping()),
			connection,
			async load(value = 1) {
				let api
				const plugin =
					connection === "in-process"
						? implementation
						: Remote.plugin(contract, {
								contractModule,
								implementation: implementationModule,
								connect:
									connection === "remote-unix" || connection === "remote-ws"
										? { ...connect, instance: `benchmark-${entries.length}` }
										: connect,
							})
				const isolation = { isolate: [[Api, `benchmark-${entries.length}`]] }
				const fork = await run(Graft.plugin(plugin, { value }, isolation))
				const entry = {
					fork,
					consumer: undefined,
					api: undefined,
					getApi: () => api,
					expectedValue: value,
					info: undefined,
					execution: undefined,
				}
				entries.push(entry)
				await run(active(fork))
				entry.consumer = await run(
					Graft.plugin(
						Plugin.make({
							name: "benchmark remote consumer",
							inject: [Api],
							apply: () =>
								Effect.gen(function* () {
									api = yield* Api
									const ready = yield* api.echo("ready")
									if (
										ready.text !== "ready" ||
										ready.value !== entry.expectedValue
									)
										return yield* Effect.die(
											new Error("Consumer observed an invalid service"),
										)
									observer.activations++
									yield* Effect.addFinalizer(() =>
										Effect.sync(() => {
											observer.finalizers++
										}),
									)
								}),
						}),
						undefined,
						isolation,
					),
				)
				await run(active(entry.consumer))
				entry.api = api
				entry.info = await run(api.info)
				if (connection !== "in-process") {
					entry.execution = probe.find(entry.info)
					if (!entry.execution)
						throw new Error(
							`Native execution was not observed: ${JSON.stringify(entry.info)}`,
						)
				}
				return entry
			},
			async stop(entry) {
				await run(entry.fork.dispose)
				if (entry.execution) {
					await entry.execution.exited
					if (
						!(connection === "remote-worker" ? [0] : [0, 130]).includes(
							entry.execution.code,
						)
					)
						throw new Error(
							`Graceful execution exited with code ${entry.execution.code}`,
						)
				}
				await run(entry.consumer.stable)
			},
			async update(entry, value) {
				const before = entry.execution
				entry.expectedValue = value
				await run(entry.fork.update({ value }))
				await run(active(entry.fork))
				await run(active(entry.consumer))
				// The restarted consumer obtains a fresh service reference.
				const observed = entry.getApi()
				entry.api = observed
				entry.info = await run(entry.api.info)
				if (connection !== "in-process") {
					if (before) await before.exited
					entry.execution = probe.find(entry.info)
					if (!entry.execution || entry.execution === before)
						throw new Error(
							"Remote config update did not create a new execution",
						)
				}
				if (connection === "in-process") await run(entry.api.echo("ready"))
				const result = await run(entry.api.echo("updated"))
				if (result.value !== value)
					throw new Error("Consumer did not observe new config")
				return result
			},
			async failed(entry) {
				const state = await run(
					entry.fork.state.pipe(
						Stream.filter((s) => s._tag === "Failed"),
						Stream.runHead,
					),
				)
				const failedAt = performance.now()
				observer.causes.push({
					pretty: Cause.pretty(state.value.cause),
					causeData: state.value.cause,
				})
				await run(
					entry.consumer.state.pipe(
						Stream.filter((s) => s._tag === "Pending"),
						Stream.runHead,
					),
				)
				const stoppedAt = performance.now()
				await entry.execution.exited
				return {
					failedAt,
					stoppedAt,
					exitedAt: entry.execution.exitedAt,
					code: entry.execution.code,
				}
			},
			async closeObserved() {
				return await destroy(true)
			},
			async close() {
				await destroy()
			},
		}
	} catch (error) {
		return await withCleanup(() => {
			throw error
		}, destroy)
	}
}
