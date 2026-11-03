import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	entry: ["src/index.ts", "src/bin.ts"],
})
