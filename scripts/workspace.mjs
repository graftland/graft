import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** Ignored build directories may survive a package move; only manifests define packages. */
export const packageManifests = (root) =>
	readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, "packages", entry.name, "package.json"))
		.filter(existsSync)
