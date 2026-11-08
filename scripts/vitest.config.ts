import { defineProject } from "vitest/config"

export default defineProject({
	test: {
		name: "@graftland/workspace",
		include: [
			"public-api.test.mjs",
			"phase2-boundary.test.mjs",
			"gateway-sample.test.mjs",
			"isolated-home.test.mjs",
			"check-names.test.mjs",
		],
		globalSetup: ["./isolated-home.mjs", "./public-api-setup.mjs"],
	},
})
