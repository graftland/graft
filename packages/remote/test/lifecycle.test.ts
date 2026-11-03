import { underlying } from "./errors"
import { ProcessExited } from "../src/Errors"
import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Graft } from "@graftland/graft"
import {
	Array,
	Cause,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Option,
	Schedule,
	Schema,
	Scope,
	Stream,
	String,
	Predicate,
	HashSet,
} from "effect"
import process from "node:process"
import * as Remote from "../src/index"
import { contract, Rejected } from "./fixtures/contract"

const contractModule = new URL(
	"../.cache/integration/contract.js",
	import.meta.url,
).href
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(Layer.provideMerge(Graft.layer, NodeServices.layer)),
	)
const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const directory = yield* fs.makeTempDirectoryScoped()
	yield* fs.writeFileString(`${directory}/release`, "release")
	return { fs, directory }
})
const waitFor = (directory: string, prefix: string, count = 1) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const files = yield* fs.readDirectory(directory).pipe(
			Effect.map((files) =>
				Array.filter(files, (file) => String.startsWith(prefix)(file)),
			),
			Effect.repeat({
				schedule: Schedule.spaced("10 millis"),
				until: (files) => files.length >= count,
			}),
			Effect.timeout("5 seconds"),
		)
		return Array.map(files, (file) => Number(String.slice(prefix.length)(file)))
	})
const gone = (pid: number) =>
	Effect.sync(() => assert.throws(() => process.kill(pid, 0)))
const dies = (cause: Cause.Cause<unknown>): ReadonlyArray<unknown> =>
	Array.flatMap(cause.reasons, (reason) =>
		reason._tag === "Die"
			? Cause.isCause(reason.defect)
				? dies(reason.defect)
				: [reason.defect]
			: [],
	)

describe("local remote lifecycle", () => {
	it.live("keeps the host Loading until the remote plugin is Active", () =>
		Effect.gen(function* () {
			const { fs, directory } = yield* setup
			const fork = yield* Graft.plugin(
				Remote.plugin(contract, { contractModule }),
				{
					directory,
					mode: "wait",
					value: 1,
				},
			)
			yield* waitFor(directory, "started-")
			assert.equal(
				(yield* Stream.runHead(fork.state)).pipe(Option.getOrThrow)._tag,
				"Loading",
			)
			yield* fs.writeFileString(`${directory}/activate`, "activate")
			yield* fork.await
			assert.equal(
				(yield* Stream.runHead(fork.state)).pipe(Option.getOrThrow)._tag,
				"Active",
			)
			yield* fork.dispose
		}).pipe(run),
	)
	it.live("preserves typed errors and defects with stacks from apply", () =>
		Effect.gen(function* () {
			const { directory } = yield* setup
			const fork = yield* Graft.plugin(
				Remote.plugin(contract, { contractModule }),
				{
					directory,
					mode: "fail",
					value: 7,
				},
			)
			const exit = yield* Effect.exit(fork.await)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit)) {
				assert.isTrue(
					Array.some(
						underlying(exit.cause).reasons,
						(reason) =>
							reason._tag === "Fail" &&
							Schema.is(Rejected)(reason.error) &&
							reason.error.value === 7,
					),
				)
				assert.isTrue(
					Array.some(
						dies(exit.cause),
						(error) =>
							error instanceof Error &&
							error.message === "Remote apply defect" &&
							error.stack !== undefined &&
							String.includes("plugin")(error.stack),
					),
				)
			}
			const state = yield* Stream.runHead(fork.state)
			assert.equal(Option.getOrThrow(state)._tag, "Failed")
			const [pid] = yield* waitFor(directory, "started-")
			yield* gone(pid!)
		}).pipe(run),
	)
	it.live("retries a failed activation in a new process", () =>
		Effect.gen(function* () {
			const { fs, directory } = yield* setup
			const fork = yield* Graft.plugin(
				Remote.plugin(contract, { contractModule, retry: Schedule.recurs(1) }),
				{ directory, mode: "retry", value: 1 },
			)
			const active = yield* Stream.runHead(
				fork.state.pipe(Stream.filter((state) => state._tag === "Active")),
			)
			assert.isTrue(Option.isSome(active))
			const pids = yield* waitFor(directory, "started-", 2)
			const attempted = yield* fs.readFileString(`${directory}/attempted`)
			const first = Number(attempted)
			assert.equal(HashSet.size(HashSet.fromIterable(pids)), 2)
			yield* gone(first)
			yield* fork.dispose
			for (const pid of pids) yield* gone(pid)
		}).pipe(run),
	)
	it.live("reports exit code and stderr when a child exits during apply", () =>
		Effect.gen(function* () {
			const { directory } = yield* setup
			const fork = yield* Graft.plugin(
				Remote.plugin(contract, { contractModule }),
				{
					directory,
					mode: "crash",
					value: 1,
				},
			)
			const exit = yield* Effect.exit(fork.await)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.isTrue(
					Array.some(
						underlying(exit.cause).reasons,
						(reason) =>
							reason._tag === "Fail" &&
							Schema.is(ProcessExited)(reason.error) &&
							reason.error.exitCode === 23 &&
							String.includes("Crash diagnostic tail")(reason.error.stderr),
					),
				)
		}).pipe(run),
	)
	it.live(
		"waits for remote finalizers and process exit before dispose returns",
		() =>
			Effect.gen(function* () {
				const { fs, directory } = yield* setup
				yield* fs.remove(`${directory}/release`)
				const fork = yield* Graft.plugin(
					Remote.plugin(contract, { contractModule }),
					{
						directory,
						mode: "normal",
						value: 1,
					},
				)
				yield* fork.await
				const [pid] = yield* waitFor(directory, "started-")
				const disposing = yield* Effect.forkScoped(fork.dispose)
				yield* waitFor(directory, "finalizing-")
				assert.isTrue(disposing.pollUnsafe() === undefined)
				yield* fs.writeFileString(`${directory}/release`, "release")
				yield* Fiber.join(disposing)
				const finalized = yield* fs.exists(`${directory}/finalized-${pid}`)
				assert.isTrue(finalized)
				yield* gone(pid!)
			}).pipe(run),
	)
	it.live("closes the remote process when the owning scope closes", () =>
		Effect.gen(function* () {
			const { fs, directory } = yield* setup
			const scope = yield* Scope.make()
			const fork = yield* Graft.plugin(
				Remote.plugin(contract, { contractModule }),
				{
					directory,
					mode: "normal",
					value: 1,
				},
			).pipe(Scope.provide(scope))
			yield* fork.await
			const [pid] = yield* waitFor(directory, "started-")
			yield* Scope.close(scope, Exit.void)
			const finalized = yield* fs.exists(`${directory}/finalized-${pid}`)
			assert.isTrue(finalized)
			yield* gone(pid!)
		}).pipe(run),
	)
	it.live("retains remote finalizer defects in CleanupError", () =>
		Effect.gen(function* () {
			const { directory } = yield* setup
			const fork = yield* Graft.plugin(
				Remote.plugin(contract, { contractModule }),
				{
					directory,
					mode: "cleanup-fail",
					value: 1,
				},
			)
			yield* fork.await
			const exit = yield* Effect.exit(fork.dispose)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.isTrue(
					Array.some(
						exit.cause.reasons,
						(reason) =>
							reason._tag === "Fail" &&
							Array.some(
								reason.error.cause.reasons,
								(inner) =>
									inner._tag === "Die" &&
									!Cause.isCause(inner.defect) &&
									inner.defect instanceof Error &&
									inner.defect.message === "Remote finalizer failed",
							),
					),
				)
			const [pid] = yield* waitFor(directory, "started-")
			yield* gone(pid!)
		}).pipe(run),
	)
	it.live("forwards logs with the host proxy fork annotation", () =>
		Effect.gen(function* () {
			const { directory } = yield* setup
			const fork = yield* Graft.plugin(
				Remote.plugin(contract, { contractModule }),
				{
					directory,
					mode: "normal",
					value: 9,
				},
			)
			yield* fork.await
			const log = yield* Stream.runHead(
				Graft.logs.pipe(
					Stream.filter(
						(entry) =>
							Array.isArray(entry.message) &&
							Array.some(
								entry.message,
								(message) =>
									Predicate.isString(message) &&
									message === "Remote fixture started",
							),
					),
				),
			)
			assert.equal(Option.getOrThrow(log).annotations["graft.fork"], fork.id)
			assert.deepInclude(
				Option.getOrThrow(log).annotations["remote.annotations"],
				{ value: 9 },
			)
			yield* fork.dispose
			const last = yield* Stream.runHead(
				Graft.logs.pipe(
					Stream.filter(
						(entry) =>
							Array.isArray(entry.message) &&
							Array.some(
								entry.message,
								(message) =>
									Predicate.isString(message) &&
									message === "Remote fixture finalized",
							),
					),
				),
			)
			assert.equal(Option.getOrThrow(last).annotations["graft.fork"], fork.id)
		}).pipe(run),
	)
	it.live("restarts in a fresh process when configuration changes", () =>
		Effect.gen(function* () {
			const { fs, directory } = yield* setup
			const fork = yield* Graft.plugin(
				Remote.plugin(contract, { contractModule }),
				{
					directory,
					mode: "normal",
					value: 1,
				},
			)
			yield* fork.await
			const [first] = yield* waitFor(directory, "started-")
			yield* fork.update({ directory, mode: "normal", value: 2 })
			yield* fork.await
			const pids = yield* waitFor(directory, "started-", 2)
			const second = Option.getOrThrow(
				Array.findFirst(pids, (pid) => pid !== first),
			)
			const value = yield* fs.readFileString(`${directory}/started-${second}`)
			assert.equal(value, "2")
			yield* gone(first!)
			yield* fork.dispose
			yield* gone(second)
		}).pipe(run),
	)
	it.live(
		"reports an external kill after activation with stderr and signal cause",
		() =>
			Effect.gen(function* () {
				const { directory } = yield* setup
				const fork = yield* Graft.plugin(
					Remote.plugin(contract, { contractModule }),
					{
						directory,
						mode: "normal",
						value: 1,
					},
				)
				yield* fork.await
				const [pid] = yield* waitFor(directory, "started-")
				yield* Effect.sync(() => process.kill(pid!, "SIGKILL"))
				const observed = yield* Stream.runHead(
					fork.state.pipe(Stream.filter((state) => state._tag === "Failed")),
				)
				const state = Option.getOrThrow(observed)
				assert.equal(state._tag, "Failed")
				if (state._tag === "Failed")
					assert.isTrue(
						Array.some(
							underlying(state.cause).reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Schema.is(ProcessExited)(reason.error) &&
								reason.error.exitCode === null &&
								reason.error.statusCause.reasons.length > 0 &&
								String.includes("Fixture stderr diagnostic")(
									reason.error.stderr,
								),
						),
					)
				yield* gone(pid!)
			}).pipe(run),
	)
	it.live(
		"propagates a background failure after Active without blocking graceful disposal",
		() =>
			Effect.gen(function* () {
				const { fs, directory } = yield* setup
				const fork = yield* Graft.plugin(
					Remote.plugin(contract, { contractModule }),
					{
						directory,
						mode: "background-fail",
						value: 8,
					},
				)
				yield* fork.await
				yield* fs.writeFileString(`${directory}/fail`, "fail")
				const observed = yield* Stream.runHead(
					fork.state.pipe(Stream.filter((state) => state._tag === "Failed")),
				)
				const state = Option.getOrThrow(observed)
				if (state._tag === "Failed")
					assert.isTrue(
						Array.some(
							underlying(state.cause).reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Schema.is(Rejected)(reason.error) &&
								reason.error.value === 8,
						),
					)
				const [pid] = yield* waitFor(directory, "started-")
				const finalized = yield* fs.exists(`${directory}/finalized-${pid}`)
				assert.isTrue(finalized)
				yield* gone(pid!)
			}).pipe(run),
	)
	it.live("kills the process when graceful cleanup exceeds the deadline", () =>
		Effect.gen(function* () {
			const { fs, directory } = yield* setup
			yield* fs.remove(`${directory}/release`)
			const fork = yield* Graft.plugin(
				Remote.plugin(contract, {
					contractModule,
					shutdownTimeout: "100 millis",
				}),
				{ directory, mode: "normal", value: 1 },
			)
			yield* fork.await
			const [pid] = yield* waitFor(directory, "started-")
			const disposed = yield* Effect.exit(fork.dispose)
			assert.isTrue(Exit.isFailure(disposed))
			yield* gone(pid!)
		}).pipe(run),
	)
	it.live("disposes an instance while its apply is still waiting", () =>
		Effect.gen(function* () {
			const { fs, directory } = yield* setup
			const fork = yield* Graft.plugin(
				Remote.plugin(contract, { contractModule }),
				{
					directory,
					mode: "wait",
					value: 1,
				},
			)
			const [pid] = yield* waitFor(directory, "started-")
			yield* fork.dispose
			const finalized = yield* fs.exists(`${directory}/finalized-${pid}`)
			assert.isTrue(finalized)
			yield* gone(pid!)
		}).pipe(run),
	)
})
