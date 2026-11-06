import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin, type Transition } from "@graftland/graft"

import { ProcessExited } from "../src/Errors"
import * as Remote from "../src/index"
import { contract, Integration } from "./fixtures/transition-contract"

const runtime = Graft.layer.pipe(
	Layer.provideMerge(
		Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
	),
)
const policy = {
	startup: "2 seconds",
	probe: "200 millis",
	trial: 0,
	drain: "200 millis",
	stop: "200 millis",
	terminate: "2 seconds",
	total: "30 seconds",
	probes: ["health"],
} satisfies Transition.Policy
const setup = Effect.fnUntraced(function* (
	target: Remote.CandidateOptions["target"],
	input: typeof contract.config.Type = { value: "old" },
	maxInFlight = 16,
) {
	const fs = yield* FileSystem.FileSystem
	const root = yield* fs.makeTempDirectoryScoped({
		directory: new URL("../.cache", import.meta.url).pathname,
		prefix: "transition-",
	})
	const source = root + "/source"
	yield* fs.copy(
		new URL("../.cache/integration", import.meta.url).pathname,
		source,
	)
	yield* fs.writeFileString(source + "/package.json", '{"type":"module"}')
	const artifact = yield* Remote.Artifact.capture({
		directory: source,
		entry: "transition-plugin.js",
		store: root + "/store",
	})
	const contractModule = new URL(
		"../.cache/integration/transition-contract.js",
		import.meta.url,
	).href
	const options = {
		instance: "integration",
		artifact,
		contractModule,
		target,
		policy,
		maxInFlight,
	}
	const fork = yield* Graft.plugin(Remote.plugin(contract, options), input)
	yield* fork.await
	const found = yield* Deferred.make<Integration["Service"]>()
	const starts = yield* Ref.make(0)
	const consumer = yield* Graft.plugin(
		Plugin.make({
			name: "gateway-consumer",
			inject: [Integration],
			apply: () =>
				Effect.gen(function* () {
					yield* Ref.update(starts, (n) => n + 1)
					const integration = yield* Integration
					yield* Deferred.succeed(found, integration)
				}),
		}),
	)
	yield* consumer.await
	const service = yield* Deferred.await(found)
	const request = (
		input: Remote.CandidateOptions["input"],
		override?: Partial<Transition.Policy>,
	) =>
		Graft.transition({
			target: fork.id,
			candidate: Remote.candidate({ ...options, input }),
			policy: override,
		})
	const serving = (attempt: number) =>
		fork.generations.pipe(
			Stream.filter((all) =>
				Array.some(
					all,
					(item) => item.attempt === attempt && item.state === "Serving",
				),
			),
			Stream.runHead,
		)
	return { fs, source, options, fork, service, starts, request, serving }
})
for (const target of [
	{ _tag: "Worker", execArgv: [] },
	{ _tag: "Local" },
] as const) {
	it.live(
		`${target._tag} transitions preserve the facade and gateway consumer`,
		() =>
			Effect.gen(function* () {
				const h = yield* setup(target)
				const constructed = h.service.read
				assert.equal((yield* constructed).value, "old")
				const result = yield* h.request({ value: "new" })
				assert.equal(result._tag, "Accepted")
				const exit = Array.findFirst(
					result.evidence,
					(item) => item.attempt === 1 && item.termination !== undefined,
				)
				const status = Cause.squash(
					Option.getOrThrow(exit).termination?.cause ?? Cause.empty,
				)
				assert.isTrue(Schema.is(ProcessExited)(status))
				if (Schema.is(ProcessExited)(status)) assert.equal(status.exitCode, 0)
				assert.isTrue(
					Array.some(
						result.evidence,
						(item) =>
							item.attempt === 1 && item.termination?.state === "Exited",
					),
				)
				assert.equal((yield* constructed).value, "new")
				const starts = yield* Ref.get(h.starts)
				assert.equal(starts, 1)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	for (const broken of ["serve", "ready", "probe"] as const) {
		it.live(
			`${target._tag} aborts a candidate with broken ${broken} and preserves the old service`,
			() =>
				Effect.gen(function* () {
					const h = yield* setup(target)
					const result = yield* h.request(
						{ value: "new", broken },
						broken === "ready" ? { startup: "500 millis" } : undefined,
					)
					assert.equal(result._tag, "Aborted")
					assert.isTrue(
						Array.some(
							result.evidence,
							(item) =>
								item.attempt === 2 && item.termination?.state === "Exited",
						),
					)
					assert.equal((yield* h.service.read).value, "old")
					if (broken === "probe") {
						const causes = Array.join(
							Array.map(result.evidence, (item) =>
								item.cause === undefined ? "" : Cause.pretty(item.cause),
							),
							"\n",
						)
						assert.include(causes, "Probe failed")
						assert.include(causes, "Probe defect")
					}
				}).pipe(Effect.scoped, Effect.provide(runtime)),
		)
	}
	it.live(
		`${target._tag} reclaims an RPC that responded before its request finalizer completed`,
		() =>
			Effect.gen(function* () {
				const h = yield* setup(target)
				const response = yield* h.service.respondThenBlock
				assert.equal(response, "old")
				yield* h.service.read.pipe(
					Effect.repeat({
						schedule: Schedule.spaced("1 milli"),
						until: (status) => status.finalizing,
					}),
				)
				const result = yield* h.request({ value: "new" })
				assert.equal(result._tag, "Accepted")
				assert.isTrue(
					Array.some(
						result.evidence,
						(item) => item.phase === "Stopping" && item.cause !== undefined,
					),
				)
				assert.isTrue(
					Array.some(
						result.evidence,
						(item) =>
							item.attempt === 1 && item.termination?.state === "Exited",
					),
				)
				assert.equal((yield* h.service.read).value, "new")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		`${target._tag} bounds old RPC drain and rejects calls beyond the attempt limit`,
		() =>
			Effect.gen(function* () {
				const h = yield* setup(target, { value: "old" }, 1)
				const call = yield* Effect.forkScoped(h.service.hold)
				yield* Effect.yieldNow
				const excess = yield* Effect.flip(h.service.read)
				assert.equal(excess.reason._tag, "RpcClientDefect")
				if (excess.reason._tag === "RpcClientDefect")
					assert.equal(excess.reason.message, "AdmissionRejected")
				const transition = yield* Effect.forkScoped(h.request({ value: "new" }))
				yield* h.serving(2)
				assert.equal((yield* h.service.read).value, "new")
				const result = yield* Fiber.join(transition)
				assert.equal(result._tag, "Accepted")
				assert.isTrue(
					Array.some(
						result.evidence,
						(item) => item.phase === "Draining" && item.cause !== undefined,
					),
				)
				const exit = yield* Fiber.await(call)
				assert.isTrue(Exit.isFailure(exit))
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		`${target._tag} lets an admitted old call finish while new calls use the candidate`,
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const gate = (yield* fs.makeTempDirectoryScoped()) + "/release"
				const h = yield* setup(target, { value: "old", release: gate })
				const call = yield* Effect.forkScoped(h.service.hold)
				yield* h.service.read.pipe(
					Effect.repeat({
						schedule: Schedule.spaced("1 milli"),
						until: (status) => status.held === 1,
					}),
				)
				const transition = yield* Effect.forkScoped(
					h.request({ value: "new" }, { drain: "2 seconds" }),
				)
				yield* h.serving(2)
				assert.equal((yield* h.service.read).value, "new")
				yield* fs.writeFileString(gate, "release")
				const response = yield* Fiber.join(call)
				assert.equal(response, "old")
				assert.equal((yield* Fiber.join(transition))._tag, "Accepted")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		`${target._tag} recovers a fresh unit from the pinned artifact after cutover failure`,
		() =>
			Effect.gen(function* () {
				const h = yield* setup(target)
				yield* h.fs.writeFileString(
					h.source + "/transition-plugin.js",
					'throw new Error("Mutable source must not be imported")',
				)
				const running = yield* Effect.forkScoped(
					h.request({ value: "new" }, { trial: "5 seconds" }),
				)
				yield* h.serving(2)
				yield* Effect.exit(h.service.crash)
				const result = yield* Fiber.join(running)
				assert.equal(result._tag, "Recovered")
				assert.equal((yield* h.service.read).value, "old")
				assert.isTrue(
					Array.some(
						result.evidence,
						(item) =>
							item.attempt === 1 && item.termination?.state === "Exited",
					),
				)
				assert.isTrue(
					Array.some(
						result.evidence,
						(item) =>
							item.attempt === 2 && item.termination?.state === "Exited",
					),
				)
				yield* h.serving(3)
				const starts = yield* Ref.get(h.starts)
				assert.equal(starts, 1)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		`${target._tag} reports recovery failure when the pinned previous artifact fails verification`,
		() =>
			Effect.gen(function* () {
				const h = yield* setup(target)
				const running = yield* Effect.forkScoped(
					h.request({ value: "new" }, { trial: "5 seconds" }),
				)
				yield* h.serving(2)
				yield* h.fs.writeFileString(
					h.options.artifact.directory + "/transition-plugin.js",
					"tampered",
				)
				yield* Effect.exit(h.service.crash)
				const result = yield* Fiber.join(running)
				assert.equal(result._tag, "RecoveryFailed")
				const unavailable = yield* Effect.flip(h.service.read)
				assert.equal(unavailable.reason.message, "Unavailable")
				assert.isTrue(
					Array.some(
						result.evidence,
						(item) =>
							item.attempt === 1 && item.termination?.state === "Exited",
					),
				)
				assert.isTrue(
					Array.some(
						result.evidence,
						(item) =>
							item.attempt === 2 && item.termination?.state === "Exited",
					),
				)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		`${target._tag} aborts failed imports without disturbing the old unit`,
		() =>
			Effect.gen(function* () {
				const h = yield* setup(target)
				yield* h.fs.writeFileString(
					h.source + "/transition-plugin.js",
					'throw new Error("Broken import")',
				)
				const broken = yield* Remote.Artifact.capture({
					directory: h.source,
					entry: "transition-plugin.js",
					store: h.source + "-broken",
				})
				const result = yield* Graft.transition({
					target: h.fork.id,
					candidate: Remote.candidate({
						...h.options,
						artifact: broken,
						input: { value: "new" },
					}),
				})
				assert.equal(result._tag, "Aborted")
				assert.isTrue(
					Array.some(
						result.evidence,
						(item) =>
							item.attempt === 2 && item.termination?.state === "Exited",
					),
				)
				assert.equal((yield* h.service.read).value, "old")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	for (const mismatch of ["operations", "overlap"] as const) {
		it.live(
			`${target._tag} checks the implementation's ${mismatch} declaration before serving`,
			() =>
				Effect.gen(function* () {
					const h = yield* setup(target)
					yield* h.fs.writeFileString(
						h.source + "/candidate.js",
						`import plugin from "./transition-plugin.js"; export default { ...plugin, ${mismatch === "operations" ? "provides: []" : "overlap: false"} }`,
					)
					const artifact = yield* Remote.Artifact.capture({
						directory: h.source,
						entry: "candidate.js",
						store: h.source + "-candidate",
					})
					const result = yield* Graft.transition({
						target: h.fork.id,
						candidate: Remote.candidate({
							...h.options,
							artifact,
							input: { value: "new" },
						}),
					})
					assert.equal(result._tag, "Aborted")
					if (result._tag === "Aborted") {
						assert.equal(result.phase, "Describing")
						assert.equal(
							result.reason,
							mismatch === "operations"
								? "IncompatibleContract"
								: "OverlapRequired",
						)
					}
					assert.isFalse(
						Array.some(result.evidence, (item) => item.phase === "Serving"),
					)
					assert.equal((yield* h.service.read).value, "old")
				}).pipe(Effect.scoped, Effect.provide(runtime)),
		)
	}
	it.live(
		`${target._tag} verifies a candidate before starting any execution`,
		() =>
			Effect.gen(function* () {
				const h = yield* setup(target)
				yield* h.fs.writeFileString(
					h.source + "/candidate.js",
					'export { default } from "./transition-plugin.js"',
				)
				const artifact = yield* Remote.Artifact.capture({
					directory: h.source,
					entry: "candidate.js",
					store: h.source + "-candidate",
				})
				yield* h.fs.writeFileString(
					artifact.directory + "/candidate.js",
					"tampered",
				)
				const result = yield* Graft.transition({
					target: h.fork.id,
					candidate: Remote.candidate({
						...h.options,
						artifact,
						input: { value: "new" },
					}),
				})
				assert.equal(result._tag, "Aborted")
				const all = yield* h.fork.generations.pipe(Stream.runHead)
				assert.equal(Option.getOrThrow(all).length, 1)
				assert.equal((yield* h.service.read).value, "old")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		`${target._tag} reports that a failed spawn never started an execution`,
		() =>
			Effect.gen(function* () {
				const h = yield* setup(target)
				const result = yield* Graft.transition({
					target: h.fork.id,
					candidate: Remote.candidate({
						...h.options,
						target: {
							_tag: "Local",
							command: [h.source + "/missing-executable"],
						},
						input: { value: "new" },
					}),
				})
				assert.equal(result._tag, "Aborted")
				assert.isTrue(
					Array.some(
						result.evidence,
						(item) =>
							item.attempt === 2 && item.termination?.state === "NotStarted",
					),
				)
				assert.equal((yield* h.service.read).value, "old")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
}
