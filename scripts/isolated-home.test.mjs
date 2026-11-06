import { fileURLToPath } from "node:url"

import { expect, it } from "vitest"
import { createVitest } from "vitest/node"

const setup = fileURLToPath(new URL("./isolated-home.mjs", import.meta.url))
const root = fileURLToPath(new URL("..", import.meta.url))

it("isolates GRAFT_HOME in every vitest project", async () => {
	const vitest = await createVitest("test", {
		watch: false,
		root,
		config: "vitest.config.ts",
	})
	try {
		const missing = vitest.projects
			.filter((project) => !(project.config.globalSetup ?? []).includes(setup))
			.map((project) => project.name)
		expect(missing).toEqual([])
	} finally {
		await vitest.close()
	}
}, 60_000)
