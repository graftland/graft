import { Array, Record } from "effect"

import type { Policy } from "../Transition"

export type Deadlines = {
	readonly [K in keyof Policy]: K extends "probes" ? Policy[K] : number
}
const sum = (steps: Readonly<Record<string, number>>) =>
	Array.reduce(Record.values(steps), 0, (total, value) => total + value)

/** The same named startup and termination steps supply execution limits and reserves. */
export const derive = (policy: Deadlines) => {
	const startup = {
		allocate: policy.startup,
		start: policy.startup,
		describe: policy.startup,
		serve: policy.startup,
		ready: policy.startup,
	}
	const termination = { exit: policy.terminate, hostRelease: policy.terminate }
	const cleanup = sum(termination)
	const recovery = sum(startup) + policy.probes.length * policy.probe + cleanup
	const safety = sum({
		recovery,
		drainPrevious: policy.drain,
		stopPrevious: policy.stop,
		terminatePrevious: cleanup,
		terminateCandidate: cleanup,
	})
	return { startup, termination, cleanup, recovery, safety }
}
