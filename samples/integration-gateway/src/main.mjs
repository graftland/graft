import process from "node:process"
import { fileURLToPath } from "node:url"

import {
	Array,
	Cause,
	Console,
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	HashMap,
	HashSet,
	Option,
	Path,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

import { channel, listen } from "./units/socket.mjs"

const budget = {
	total: 60000,
	startup: 5000,
	probe: 1000,
	drain: 5000,
	stop: 1000,
	terminate: 1000,
}
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
const Reply = Schema.Struct({
	id: Schema.String,
	version: Schema.Int,
	term: Schema.Int,
	session: Schema.Int,
})
const decode = Schema.decodeEffect(Schema.fromJsonString(Reply))
const requireFact = (value, detail) =>
	value ? Effect.void : Effect.die(detail)
const upstream = Effect.fnUntraced(function* () {
	const connection = yield* Deferred.make()
	const ready = yield* Deferred.make()
	const sessions = yield* Ref.make(0)
	const pending = yield* Ref.make(HashMap.empty())
	const next = yield* Ref.make(0)
	const port = yield* listen((socket) =>
		Effect.gen(function* () {
			yield* Ref.update(sessions, (n) => n + 1)
			const c = yield* channel(socket)
			yield* Deferred.succeed(connection, c)
			yield* Stream.runForEach(c.lines, (line) =>
				decode(line).pipe(
					Effect.flatMap((value) =>
						value.id === "ready"
							? Deferred.succeed(ready, value.session)
							: Ref.get(pending).pipe(
									Effect.flatMap((p) =>
										Option.match(HashMap.get(p, value.id), {
											onNone: () => Effect.die("Unexpected gateway response"),
											onSome: (d) => Deferred.succeed(d, value),
										}),
									),
								),
					),
				),
			)
		}),
	)
	const call = Effect.fnUntraced(function* (city) {
		const c = yield* Deferred.await(connection)
		const id = String(yield* Ref.getAndUpdate(next, (n) => n + 1))
		const waiter = yield* Deferred.make()
		yield* Ref.update(pending, HashMap.set(id, waiter))
		return yield* encode({ id, city }).pipe(
			Effect.flatMap(c.write),
			Effect.andThen(Deferred.await(waiter)),
			Effect.ensuring(Ref.update(pending, HashMap.remove(id))),
		)
	})
	return {
		port,
		call,
		session: Deferred.await(ready),
		sessions: Ref.get(sessions),
	}
})
const gate = Effect.fnUntraced(function* () {
	const held = yield* Deferred.make()
	const release = yield* Deferred.make()
	const port = yield* listen((socket) =>
		Effect.gen(function* () {
			const c = yield* channel(socket)
			yield* Stream.runHead(c.lines)
			yield* Deferred.succeed(held, undefined)
			yield* Deferred.await(release)
			yield* c.write("release")
		}),
	)
	return {
		port,
		held: Deferred.await(held),
		release: Deferred.succeed(release, undefined),
	}
})
const boot = Effect.fnUntraced(function* (directory, deployment) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const config = path.join(directory, "deployment.json")
	const ready = path.join(directory, "ready.json")
	yield* Schema.encodeEffect(Schema.fromJsonString(Control.Deployment))(
		deployment,
	).pipe(Effect.flatMap((text) => fs.writeFileString(config, text)))
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const executable = fileURLToPath(
		import.meta.resolve("@graftland/plugin-remote/kernel"),
	)
	const child = yield* spawner.spawn(
		ChildProcess.make(process.execPath, [executable, config, ready], {
			stdout: "pipe",
			stderr: "pipe",
		}),
	)
	const diagnostic = yield* Stream.mkString(
		Stream.decodeText(child.stderr),
	).pipe(Effect.forkScoped)
	yield* Stream.runDrain(child.stdout).pipe(
		Effect.catchCause((cause) =>
			Effect.logError("Kernel stdout failed", cause),
		),
		Effect.forkScoped,
	)
	yield* Effect.raceFirst(
		fs.exists(ready).pipe(
			Effect.repeat({
				schedule: Schedule.spaced("10 millis"),
				until: (exists) => exists,
			}),
		),
		child.exitCode.pipe(
			Effect.flatMap((code) =>
				Fiber.join(diagnostic).pipe(
					Effect.flatMap((text) =>
						Effect.die("Kernel exited before readiness: " + code + " " + text),
					),
				),
			),
		),
	)
	return yield* fs
		.readFileString(ready)
		.pipe(
			Effect.flatMap(
				Schema.decodeEffect(Schema.fromJsonString(Control.Address)),
			),
		)
})
const phase = (client, id, name) =>
	client.observe(id).pipe(
		Stream.filter((s) => s.phase === name),
		Stream.runHead,
		Effect.flatMap(Effect.fromOption),
	)
const accepted = Effect.fnUntraced(function* (client, request) {
	const handle = yield* client.submit({ ...request, budget })
	const result = yield* handle.await
	yield* requireFact(result.outcome === "Accepted", Cause.pretty(result.cause))
	return handle
})
const prepare = Effect.fnUntraced(function* (placement) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const cache = fileURLToPath(
		new URL("../.cache/native-gateway", import.meta.url),
	)
	yield* fs.makeDirectory(cache, { recursive: true })
	const directory = yield* fs.makeTempDirectoryScoped({
		directory: cache,
	})
	const source = fileURLToPath(new URL("units", import.meta.url))
	const capture = (entry) =>
		Artifact.capture({
			directory: source,
			entry,
			store: path.join(directory, "artifacts"),
		})
	const contractArtifact = yield* capture("provider-contract.mjs")
	const first = yield* capture("v1.mjs")
	const second = yield* capture("v2.mjs")
	const gateway = yield* capture("gateway.mjs")
	const u = yield* upstream()
	const g = yield* gate()
	const runner =
		placement === "Runner"
			? yield* Units.serveRunner({
					socket: path.relative(".", path.join(directory, "runner.sock")),
					owner: "sample-owner",
				})
			: undefined
	const target = (artifact, selected = placement) =>
		Units.target({
			artifact,
			contractArtifact,
			contract: "provider-contract.mjs",
			input: { upstream: u.port, gate: g.port },
			placement: selected,
			...(selected === "Runner" ? { runner: runner.address } : {}),
		})
	const consumer = Units.target({
		artifact: gateway,
		contractArtifact,
		contract: "consumer-contract.mjs",
		input: { upstream: u.port, gate: g.port },
		placement: "Worker",
	})
	const old = target(first)
	const next = target(second)
	const unrelated = target(second, "Worker")
	const address = yield* boot(directory, {
		authority: "sample",
		maxUnits: 8,
		instances: [
			{ id: "integration", target: old },
			{ id: "gateway", target: consumer },
			{ id: "unrelated", target: unrelated },
		],
		bindings: [
			{
				consumer: "gateway",
				provider: "integration",
				service: "gateway/Integration",
			},
		],
	})
	return { address, old, next, consumer, unrelated, u, g }
})
const upgrade = Effect.fnUntraced(function* (f, client, strategy) {
	const held = yield* f.u.call("held").pipe(Effect.forkScoped)
	yield* f.g.held
	const handle = yield* client.submit({
		instance: "integration",
		target: f.next,
		strategy,
		budget,
		requirements: { trial: 5000 },
	})
	if (strategy === "Restart") {
		yield* phase(client, handle.id, "Draining")
		const queued = yield* f.u.call("queued").pipe(Effect.forkScoped)
		const waiting = yield* client.waiters.pipe(
			Effect.repeat({
				schedule: Schedule.spaced("10 millis"),
				until: (values) => values.length === 1,
			}),
		)
		yield* requireFact(
			waiting.length === 1 && !("provider" in waiting[0]),
			"Restart waiter acquired an execution provider",
		)
		yield* f.g.release
		yield* requireFact(
			(yield* Fiber.join(held)).version === 1,
			"Old call changed provider",
		)
		yield* phase(client, handle.id, "Trial")
		yield* requireFact(
			(yield* Fiber.join(queued)).version === 2,
			"Queued call did not reach new code",
		)
	} else {
		yield* phase(client, handle.id, "Trial")
		yield* requireFact(
			(yield* f.u.call("new")).version === 2,
			"New call did not reach new code",
		)
		yield* f.g.release
		yield* requireFact(
			(yield* Fiber.join(held)).version === 1,
			"Old call changed provider",
		)
	}
	yield* accepted(client, { instance: "unrelated", target: f.unrelated })
	yield* client.close
	return handle.id
})
export const prove = Effect.fnUntraced(function* (
	placement = "Worker",
	strategy = "Overlap",
) {
	const f = yield* prepare(placement)
	const client = yield* Control.connect(f.address)
	yield* accepted(client, { instance: "integration", target: f.old })
	yield* accepted(client, { instance: "gateway", target: f.consumer })
	const session = yield* f.u.session
	const before = yield* f.u.call("before")
	const id = yield* upgrade(f, client, strategy)
	const reconnected = yield* Control.connect(f.address)
	const result = yield* reconnected.handle(id).await
	const status = yield* reconnected
		.get(id)
		.pipe(Effect.flatMap(Effect.fromOption))
	const repeated = yield* reconnected.handle(id).await
	const original = yield* Effect.fromOption(status.conclusion)
	const after = yield* f.u.call("after")
	const units = yield* reconnected.units
	const old = yield* Array.findFirst(
		units,
		(u) =>
			u.instance === "integration" && u.kind === "Execution" && u.term === 1,
	).pipe(Effect.fromOption)
	const gateways = Array.filter(
		units,
		(u) => u.instance === "gateway" && u.kind === "Execution",
	)
	const calls = yield* reconnected.calls
	yield* requireFact(result.outcome === "Accepted", Cause.pretty(result.cause))
	yield* requireFact(
		original.outcome === repeated.outcome,
		"Public observations disagree",
	)
	yield* requireFact(
		before.version === 1 &&
			after.version === 2 &&
			after.session === session &&
			(yield* f.u.sessions) === 1,
		"Gateway session or business version changed incorrectly",
	)
	yield* requireFact(
		old.evidence === "Exited" &&
			gateways.length === 1 &&
			gateways[0].evidence === "Missing",
		"Native exit or gateway evidence missing",
	)
	yield* requireFact(
		HashSet.size(status.leaseHolders) === 0 &&
			HashSet.size(status.unconfirmedUnits) === 0 &&
			Array.every(calls, (call) => !call.credit),
		"Settled Change retained execution obligations",
	)
	yield* requireFact(
		status.member.healthy &&
			status.member.matchesTarget &&
			status.member.reason === "ExplicitTarget",
		"Current target is unhealthy or selection is incorrect",
	)
	const report = {
		placement,
		strategy,
		outcome: result.outcome,
		before: before.version,
		after: after.version,
		session,
		sessions: yield* f.u.sessions,
		gatewayUnits: gateways.length,
		oldExit: old.evidence,
		selection: status.member.reason,
		healthy: status.member.healthy,
		matchesTarget: status.member.matchesTarget,
		leases: HashSet.size(status.leaseHolders),
		unconfirmed: HashSet.size(status.unconfirmedUnits),
		remainingBudget: status.remaining,
		cause: Cause.pretty(result.cause),
	}
	yield* reconnected.shutdown
	return report
})
if (import.meta.main)
	NodeRuntime.runMain(
		prove(process.argv[2] ?? "Worker", process.argv[3] ?? "Overlap").pipe(
			Effect.scoped,
			Effect.provide(NodeServices.layer),
			Effect.flatMap(Console.log),
		),
	)
