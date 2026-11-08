import { execFileSync } from "node:child_process"

import { assert, it } from "vitest"

for (const [placement, strategy] of [
	["Worker", "Overlap"],
	["Process", "Restart"],
	["Runner", "Restart"],
])
	it(`runs the public gateway sample through a separate kernel with ${placement} ${strategy}`, () => {
		const output = execFileSync(
			process.execPath,
			["samples/integration-gateway/src/main.mjs", placement, strategy],
			{ cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 45000 },
		)
		assert.include(output, "Accepted")
		assert.include(output, "Exited")
		assert.match(output, /sessions: 1/)
		assert.match(output, /after: 2/)
		assert.match(output, /brokenUpgrade: '(Aborted|Recovered)'/)
		assert.match(output, /afterBroken: 2/)
	}, 60000)
