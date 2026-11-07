import { Cause, Exit, Option } from "effect"
import { assert, it } from "@effect/vitest"

import type { State } from "../src/internal/asyncClose.ts"
import * as Terminal from "../src/internal/terminalSettlement.ts"

const failed = Cause.combine(
	Cause.die("Cleanup defect"),
	Cause.die("Cleanup detail"),
)
for (const [name, host, expected] of [
	["pending cleanup", { _tag: "Pending" }, "Unresolved"],
	["running cleanup", { _tag: "Running" }, "Unresolved"],
	[
		"successful original cleanup exit",
		{ _tag: "Completed", exit: Exit.void },
		"Settled",
	],
	[
		"completed cleanup failure",
		{ _tag: "Completed", exit: Exit.failCause(failed) },
		"Failed",
	],
	[
		"unattributed cleanup interruption",
		{ _tag: "Completed", exit: Exit.failCause(Cause.interrupt(1)) },
		"Unresolved",
	],
] satisfies ReadonlyArray<
	readonly [string, State, Terminal.Classification["_tag"]]
>) {
	it("classifies " + name + " from its original completion evidence", () => {
		assert.equal(Terminal.cleanup(host)._tag, expected)
		const exited = Terminal.generation(
			Option.some({ unit: "generation", state: "Exited" }),
			host,
		)
		assert.equal(exited._tag, expected)
		const unconfirmed = Terminal.generation(Option.none(), host)
		assert.equal(unconfirmed._tag, "Unresolved")
		if (unconfirmed._tag === "Unresolved")
			assert.equal(unconfirmed.reason, "UnconfirmedTermination")
	})
}
it("retains all known failure causes while unresolved ownership takes precedence", () => {
	const result = Terminal.combine([
		Terminal.Classification.Failed({ cause: failed }),
		Terminal.Classification.Unresolved({
			reason: "UnresolvedCleanup",
			cause: Cause.interrupt(1),
		}),
	])
	assert.equal(result._tag, "Unresolved")
	if (result._tag !== "Settled")
		assert.deepStrictEqual(result.cause.reasons, [
			...failed.reasons,
			...Cause.interrupt(1).reasons,
		])
})
