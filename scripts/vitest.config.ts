import { defineProject } from "vitest/config"

export default defineProject({
	test: {
		name: "@graftland/workspace",
		include: [
			"public-api.test.mjs",
			"packed-gateway.test.mjs",
			"isolated-home.test.mjs",
		],
		globalSetup: ["./isolated-home.mjs", "./public-api-setup.mjs"],
	},
})
