import { Effect, Record } from "effect"
import { describe, expect, it } from "@effect/vitest"

import * as Avvio from "../src/avvio.ts"
import * as Baseline from "../src/baseline.ts"
import * as Cordis from "../src/cordis.ts"
import * as Emitters from "../src/emitters.ts"
import { expected } from "../src/expectation.ts"
import * as Graft from "../src/graft.ts"
import {
	supported,
	type Case,
	type Factory,
	type Implementation,
	type Scenario,
} from "../src/model.ts"

const factories: Readonly<Record<Implementation, Factory>> = {
	graft: Graft.make,
	cordis: Cordis.make,
	avvio: Avvio.make,
	effect: Baseline.make,
	node: Emitters.node,
	emittery: Emitters.emittery,
}
const scenarios: ReadonlyArray<Scenario> = [
	"cold-load",
	"cold-dispose",
	"fanout-load",
	"fanout-withdraw",
	"fanout-restore",
	"chain",
	"service",
	"events-emit",
	"events-sequential",
	"events-parallel",
	"events-bail",
	"events-serial-bail",
	"events-waterfall",
	"config-update",
	"config-restart",
	"replace",
	"memory-cycles",
	"memory-steady",
]
for (const scenario of scenarios)
	describe(scenario, () => {
		for (const implementation of Record.keys(factories)) {
			const reason = supported(implementation, scenario)
			if (reason !== undefined) {
				it.skip(`${implementation}: ${reason}`, () => {})
				continue
			}
			it.effect(`${implementation} completes the same observable work`, () =>
				Effect.gen(function* () {
					const spec: Case = { scenario, size: 3, calls: 5 }
					const fixture = yield* factories[implementation](spec)
					const result = yield* Effect.ensuring(
						Effect.gen(function* () {
							const value = yield* fixture.run
							expect(fixture.read()).toEqual(expected(spec))
							expect(value).toBe(
								scenario === "chain" ||
									scenario === "service" ||
									scenario === "events-bail" ||
									scenario === "events-serial-bail" ||
									scenario === "events-waterfall" ||
									scenario === "config-update" ||
									scenario === "config-restart"
									? expected(spec).value
									: 0,
							)
							if (scenario === "memory-cycles") {
								yield* fixture.run
								yield* fixture.run
								expect(fixture.read()).toEqual(expected(spec, false, 3))
							}
							return value
						}),
						fixture.close,
					)
					expect(Number.isFinite(result)).toBe(true)
					expect(fixture.read()).toEqual(
						expected(spec, true, scenario === "memory-cycles" ? 3 : 1),
					)
				}),
			)
		}
	})
