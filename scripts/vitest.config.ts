import { defineProject } from "vitest/config"

export default defineProject({
	test: {
		name: "@graftland/workspace",
		include: ["public-api.test.mjs"],
		globalSetup: ["./public-api-setup.mjs"],
	},
})
