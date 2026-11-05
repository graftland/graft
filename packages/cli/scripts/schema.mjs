// Writes schema.json from the built CLI: the JSON Schema of graft.yml in each
// release, with the loader's entry fields and the CLI's intercepts. Plugins
// add their config in each project through `graft schema`.
import { writeFileSync } from "node:fs"

import { make } from "../dist/internal/configSchema.js"

writeFileSync(
	new URL("../schema.json", import.meta.url),
	JSON.stringify(make(), null, "\t") + "\n",
)
