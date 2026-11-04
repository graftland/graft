// Publish encoded config schemas without importing capability implementations.
import { writeFileSync } from "node:fs"
import { entries } from "../dist/Config.js"
writeFileSync(
	new URL("../schema.json", import.meta.url),
	JSON.stringify(entries(), null, "\t") + "\n",
)
