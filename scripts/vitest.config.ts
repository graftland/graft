import { defineProject } from "vitest/config"

export default defineProject({
	test: {
		name: "public-api",
		include: ["public-api.test.mjs"],
		globalSetup: ["./public-api-setup.mjs"],
	},
})
