import { Socket } from "node:net"

import {
	Array,
	Cause,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Queue,
	References,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel } from "@graftland/graft"

import * as Units from "../src/Units"
import { budget, stage } from "./native-unit-fixture"

const connect = (address: string) =>
	Effect.acquireRelease(
		Effect.callback<Socket>((resume) => {
			const socket = new Socket()
			socket.once("error", (error) => resume(Effect.die(error)))
			socket.connect(address, () => resume(Effect.succeed(socket)))
		}),
		(socket) => Effect.sync(() => socket.destroy()),
	)

for (const fault of ["none", "malformed", "truncated"] as const) {
	it.live(
		fault === "none"
			? "classifies clean runner client shutdown without an error log"
			: `retains ${fault} runner control input as an error`,
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				yield* fs.makeDirectory(".cache/native-tests", { recursive: true })
				const logs = yield* Queue.unbounded<Logger.Options<unknown>>()
				const logger = Logger.make<unknown, void>((entry) => {
					Queue.offerUnsafe(logs, entry)
				})
				yield* Effect.gen(function* () {
					const owner = yield* Units.serveRunner({
						socket: `.cache/native-tests/shutdown-${fault}.sock`,
						owner: "shutdown-test",
					})
					const socket = yield* connect(owner.address.socket)
					yield* Effect.sync(() =>
						socket.end(
							fault === "none"
								? ""
								: fault === "truncated"
									? "invalid json"
									: "invalid json\n",
						),
					)
					const entry = yield* Queue.take(logs)
					assert.equal(entry.logLevel, fault === "none" ? "Debug" : "Error")
					if (fault !== "none") assert.isAbove(entry.cause.reasons.length, 0)
				}).pipe(
					Effect.scoped,
					Effect.provide(Logger.layer([logger])),
					Effect.provideService(References.MinimumLogLevel, "Debug"),
				)
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
}

it.live(
	"retires real runner Restart executions and closes control without an error log",
	() =>
		Effect.gen(function* () {
			const artifact = yield* stage("none")
			const logs = yield* Queue.unbounded<Logger.Options<unknown>>()
			const logger = Logger.make<unknown, void>((entry) => {
				Queue.offerUnsafe(logs, entry)
			})
			yield* Effect.gen(function* () {
				const owner = yield* Units.serveRunner({
					socket: ".cache/native-tests/restart-shutdown.sock",
					owner: "restart-shutdown",
				})
				const target = Units.target({
					artifact,
					contract: "contract.js",
					input: { mode: "test" },
					placement: "Runner",
					runner: owner.address,
				})
				yield* Effect.gen(function* () {
					const kernel = yield* Kernel.Kernel
					const first = yield* Change.run({
						instance: "a",
						target,
						strategy: "Restart",
						budget,
					})
					assert.equal(first.outcome, "Accepted", Cause.pretty(first.cause))
					const second = yield* Change.run({
						instance: "a",
						target,
						strategy: "Restart",
						budget,
					})
					assert.equal(second.outcome, "Accepted", Cause.pretty(second.cause))
					const retired = yield* kernel.units
					assert.isTrue(
						Array.some(
							retired,
							(unit) =>
								unit.kind === "Execution" &&
								unit.term === 1 &&
								unit.evidence === "Exited",
						),
					)
					yield* kernel.shutdown
					while (true) {
						const units = yield* kernel.units
						if (Array.every(units, (unit) => unit.evidence !== "Missing")) break
						yield* Effect.yieldNow
					}
				}).pipe(
					Effect.provide(
						Kernel.layer({
							authority: "restart-shutdown",
							maxUnits: 3,
							instances: [{ id: "a", target }],
						}).pipe(Layer.provide(Units.layer)),
					),
					Effect.scoped,
				)
				const entry = yield* Queue.take(logs).pipe(Effect.timeout("3 seconds"))
				assert.equal(entry.logLevel, "Debug")
				const rest = yield* Queue.clear(logs)
				assert.isFalse(
					Array.some(
						rest,
						(entry) => entry.logLevel === "Error" || entry.logLevel === "Fatal",
					),
				)
			}).pipe(
				Effect.scoped,
				Effect.provide(Logger.layer([logger])),
				Effect.provideService(References.MinimumLogLevel, "Debug"),
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)
