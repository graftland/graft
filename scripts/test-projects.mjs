// Prints the workspace's vitest project names as a JSON array, so CI can run
// each project in its own job without listing them by hand.
import { createVitest } from "vitest/node"

const vitest = await createVitest("test", {
	watch: false,
	config: "vitest.config.ts",
})
try {
	console.log(
		JSON.stringify(vitest.projects.map((project) => project.name).sort()),
	)
} finally {
	await vitest.close()
}
