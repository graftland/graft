// Writes schema.json from the built CLI, so the JSON Schema of graft.yml in
// each release matches the loader and the intercepts of that release.
import { readFileSync, writeFileSync } from "node:fs"

import { make } from "../dist/internal/configSchema.js"

writeFileSync(
	new URL("../schema.json", import.meta.url),
	JSON.stringify(
		make(
			JSON.parse(
				readFileSync(
					new URL("../../plugin-remote/schema.json", import.meta.url),
					"utf8",
				),
			),
		),
		null,
		"\t",
	) + "\n",
)
