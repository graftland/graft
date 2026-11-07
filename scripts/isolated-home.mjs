import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"

/**
 * Points GRAFT_HOME at an empty directory for the whole run, so command
 * plugins installed in the developer's own ~/.graft never reach the tests.
 */
export default async function setup() {
	const home = await mkdtemp(join(tmpdir(), "graft-home-"))
	const previous = process.env.GRAFT_HOME
	process.env.GRAFT_HOME = home
	return async () => {
		if (previous === undefined) delete process.env.GRAFT_HOME
		else process.env.GRAFT_HOME = previous
		await rm(home, { recursive: true, force: true })
	}
}
