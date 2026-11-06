import { Array, Record } from "effect"
import { assert, it } from "@effect/vitest"

import { derive, type Deadlines } from "../src/internal/transitionBudgets"

it("derives cleanup and recovery reserves from the lifecycle operations they protect", () => {
	const policy: Deadlines = {
		total: 10000,
		startup: 17,
		probe: 7,
		trial: 0,
		drain: 11,
		stop: 13,
		terminate: 19,
		probes: ["health", "upstream"],
	}
	const budgets = derive(policy)
	const sum = (steps: Readonly<Record<string, number>>) =>
		Array.reduce(Record.values(steps), 0, (total, step) => total + step)
	assert.deepEqual(Record.keys(budgets.startup), [
		"allocate",
		"start",
		"describe",
		"serve",
		"ready",
	])
	assert.deepEqual(Record.keys(budgets.termination), ["exit", "hostRelease"])
	assert.equal(budgets.cleanup, sum(budgets.termination))
	assert.equal(
		budgets.recovery,
		sum(budgets.startup) +
			policy.probes.length * policy.probe +
			budgets.cleanup,
	)
	assert.equal(
		budgets.safety,
		budgets.recovery +
			policy.drain +
			policy.stop +
			budgets.cleanup +
			budgets.cleanup,
	)
})
