import { docsSchema } from "@astrojs/starlight/schema"
import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"

// Page paths follow their files: `index.mdx` is `/`, `plugins.mdx` is
// `/plugins/`, and `zh-cn/plugins.mdx` is `/zh-cn/plugins/`.
export const collections = {
	docs: defineCollection({
		loader: glob({ base: "./content/docs", pattern: "**/[^_]*.{md,mdx}" }),
		schema: docsSchema(),
	}),
}
