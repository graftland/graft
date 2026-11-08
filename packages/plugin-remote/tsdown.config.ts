import { defineConfig } from "tsdown"

import config from "../../tsdown.config.ts"

export default defineConfig({
	...config,
	exports: {
		...config.exports,
		customExports: (exports) => ({
			...Object.fromEntries(
				Object.entries(exports).filter(
					([name]) => !name.startsWith("./internal/"),
				),
			),
			"./kernel": "./dist/internal/kernelMain.js",
			"./internal/unit": "./dist/internal/nativeUnitMain.js",
			"./internal/publication": "./dist/internal/publicationMain.js",
		}),
	},
	entry: [
		"src/index.ts",
		"src/Artifact.ts",
		"src/Contract.ts",
		"src/Configuration.ts",
		"src/Units.ts",
		"src/Control.ts",
		"src/Recording.ts",
		"src/ProcessStdio.ts",
		"src/Notifications.ts",
		"src/Policy.ts",
		"src/Publication.ts",
		"src/Capabilities.ts",
		"src/Conformance.ts",
		"src/Testing.ts",
		"src/Transport.ts",
		"src/Errors.ts",
		"src/internal/nativeUnit.ts",
		"src/internal/nativeUnitMain.ts",
		"src/internal/kernelMain.ts",
		"src/internal/publicationMain.ts",
	],
})
