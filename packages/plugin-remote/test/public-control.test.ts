import process from "node:process"

import {
	Array,
	Cause,
	Effect,
	Fiber,
	FileSystem,
	HashMap,
	Layer,
	Option,
	Path,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import * as Kernel from "@graftland/graft/Kernel"

import * as Control from "../src/Control"
import * as Units from "../src/Units"
import { budget, fixture } from "./unit-binding-fixture"

const runtime = Effect.fnUntraced(function* () {
	const f = yield* fixture()
	const target = Units.target({
		artifact: f.provider,
		contractArtifact: f.contractArtifact,
		contract: "provider.js",
		input: { mode: "test" },
		placement: "Worker",
	})
	const layer = Kernel.layer({
		authority: "public-control",
		maxUnits: 3,
		instances: [{ id: "provider", target }],
	}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
	return { target, layer }
})
it.live(
	"submits and reconciles public handles and residual unit facts without coordinator access (I1, I2, I10)",
	() =>
		Effect.gen(function* () {
			const r = yield* runtime()
			yield* Effect.gen(function* () {
				const address = yield* Control.serve()
				const client = yield* Control.connect(address)
				const first = yield* client.submit({
					operations: [
						{ _tag: "Deploy", instance: "provider", target: r.target },
					],
					key: "public",
					budget,
				})
				const outcome = yield* first.await
				assert.equal(outcome.outcome, "Accepted", Cause.pretty(outcome.cause))
				const status = yield* client
					.get(first.id)
					.pipe(Effect.flatMap(Effect.fromOption))
				assert.deepEqual(Option.getOrThrow(status.conclusion), outcome)
				const same = yield* client.submit({
					operations: [
						{ _tag: "Deploy", instance: "provider", target: r.target },
					],
					key: "public",
					budget,
				})
				assert.equal(same.id, first.id)
				const repeated = yield* same.await
				assert.deepEqual(repeated, outcome)
				const units = yield* client.units
				assert.isTrue(
					Array.some(
						units,
						(u) =>
							u.kind === "Execution" &&
							u.owner === `group:${u.group}` &&
							HashMap.has(u.members, "provider") &&
							u.evidence === "Missing",
					),
				)
			}).pipe(Effect.provide(r.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)
it.effect(
	"reconnects and awaits an admitted Change after disconnect and interrupted await without cancelling it (I1, I10)",
	() =>
		Effect.gen(function* () {
			const r = yield* runtime()
			yield* Effect.gen(function* () {
				const address = yield* Control.serve()
				const client = yield* Control.connect(address)
				const change = yield* client.submit({
					operations: [
						{ _tag: "Deploy", instance: "provider", target: r.target },
					],
					budget: { ...budget, total: 60000 },
					requirements: { trial: 10000 },
				})
				const waiting = yield* change.await.pipe(Effect.forkScoped)
				yield* Fiber.interrupt(waiting)
				yield* client.close
				const reconnected = yield* Control.connect(address)
				const status = yield* reconnected
					.get(change.id)
					.pipe(Effect.flatMap(Effect.fromOption))
				assert.isTrue(Option.isNone(status.conclusion))
				yield* reconnected.observe(change.id).pipe(
					Stream.filter((s) => s.phase === "Trial"),
					Stream.runHead,
				)
				yield* TestClock.adjust(10000)
				const outcome = yield* reconnected.handle(change.id).await
				assert.equal(outcome.outcome, "Accepted", Cause.pretty(outcome.cause))
				const repeated = yield* reconnected.handle(change.id).await
				assert.deepEqual(repeated, outcome)
			}).pipe(Effect.provide(r.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)
it.live(
	"rejects a wrong control capability before mutating kernel facts (I4, I12)",
	() =>
		Effect.gen(function* () {
			const r = yield* runtime()
			yield* Effect.gen(function* () {
				const address = yield* Control.serve()
				const client = yield* Control.connect({ ...address, token: "wrong" })
				const rejected = yield* client
					.submit({
						operations: [
							{ _tag: "Deploy", instance: "provider", target: r.target },
						],
						budget,
					})
					.pipe(Effect.flip)
				assert.equal(rejected.reason, "Unauthorized")
				const good = yield* Control.connect(address)
				const units = yield* good.units
				assert.equal(units.length, 0)
			}).pipe(Effect.provide(r.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)

it.live(
	"controls a fixed kernel from another process without importing its business contract (I1, I5, I12)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture()
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const target = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider.js",
				input: { mode: "test" },
				placement: "Process",
			})
			const deployment = path.join(f.directory, "deployment.json")
			const ready = path.join(f.directory, "ready.json")
			const text = yield* Schema.encodeEffect(
				Schema.fromJsonString(Control.Deployment),
			)({
				authority: "external-control",
				maxUnits: 3,
				instances: [{ id: "provider", target }],
			})
			yield* fs.writeFileString(deployment, text)
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[
						new URL("../dist/internal/kernelMain.js", import.meta.url).pathname,
						deployment,
						ready,
					],
					{ stdout: "pipe", stderr: "pipe" },
				),
			)
			const stderr = yield* Stream.mkString(
				Stream.decodeText(child.stderr),
			).pipe(Effect.forkScoped)
			yield* Stream.runDrain(child.stdout).pipe(
				Effect.catchCause((cause) =>
					Effect.logError("Kernel fixture stdout failed", cause),
				),
				Effect.forkScoped,
			)

			const available = fs.exists(ready).pipe(
				Effect.repeat({
					schedule: Schedule.spaced("10 millis"),
					until: (exists) => exists,
				}),
			)
			yield* Effect.raceFirst(
				available,
				child.exitCode.pipe(
					Effect.flatMap((code) =>
						Fiber.join(stderr).pipe(
							Effect.flatMap((output) =>
								Effect.die(
									"Kernel entry exited before readiness: " +
										code +
										" " +
										output,
								),
							),
						),
					),
				),
			)
			const address = yield* fs
				.readFileString(ready)
				.pipe(
					Effect.flatMap(
						Schema.decodeEffect(Schema.fromJsonString(Control.Address)),
					),
				)
			const client = yield* Control.connect(address)
			const change = yield* client.submit({
				operations: [{ _tag: "Deploy", instance: "provider", target }],
				budget,
			})
			const result = yield* change.await
			assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
			const units = yield* client.units
			assert.isTrue(
				Array.some(
					units,
					(u) =>
						u.kind === "Execution" &&
						u.owner === `group:${u.group}` &&
						HashMap.has(u.members, "provider"),
				),
			)
			yield* client.shutdown
			const final = yield* client
				.get(change.id)
				.pipe(Effect.flatMap(Effect.fromOption))
			assert.deepEqual(Option.getOrThrow(final.conclusion), result)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)
