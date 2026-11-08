import { audit, type Audit, type Case } from "./model"

export const expected = (
	spec: Case,
	closed = false,
	cycles = 1,
): Readonly<Audit> => {
	const result = audit()
	const { scenario, size, calls } = spec
	if (
		scenario === "cold-load" ||
		scenario === "cold-dispose" ||
		scenario === "memory-steady"
	)
		result.activations = size
	if (scenario === "cold-dispose") result.finalizers = size
	if (scenario === "memory-cycles") {
		result.activations = size * cycles
		result.finalizers = result.activations
	}
	if (scenario === "chain") {
		result.activations = size
		result.calls = size - 1
		result.value = size
	}
	if (
		scenario === "fanout-load" ||
		scenario === "fanout-withdraw" ||
		scenario === "fanout-restore"
	) {
		const restored = scenario === "fanout-restore"
		result.activations = (size + 1) * (restored ? 2 : 1)
		result.finalizers = scenario === "fanout-load" ? 0 : size + 1
		result.calls = size * (restored ? 2 : 1)
		result.value = result.calls
	}
	if (scenario === "service") {
		result.activations = 2
		result.calls = calls
		result.value = (calls * (calls + 1)) / 2
	}
	if (scenario === "config-update") {
		result.activations = 1
		result.updates = 1
		result.value = 1
	}
	if (scenario === "config-restart") {
		result.activations = 2
		result.finalizers = 1
		result.value = 1
	}
	if (
		scenario === "events-emit" ||
		scenario === "events-sequential" ||
		scenario === "events-parallel" ||
		scenario === "events-bail" ||
		scenario === "events-serial-bail" ||
		scenario === "events-waterfall"
	) {
		result.handlers = size * calls
		if (scenario === "events-waterfall") result.terminals = calls
		result.value =
			scenario === "events-waterfall"
				? size
				: scenario === "events-bail" || scenario === "events-serial-bail"
					? 7
					: 0
	}
	if (closed) result.finalizers = result.activations
	return result
}
