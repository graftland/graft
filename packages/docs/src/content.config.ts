import { docsSchema } from "@astrojs/starlight/schema"
import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"
import { slug } from "github-slugger"

// Page paths follow their files: `index.mdx` is `/`, `plugins.mdx` is
// `/plugins/`, and `zh-cn/plugins.mdx` is `/zh-cn/plugins/`.
export const collections = {
	docs: defineCollection({
		loader: glob({
			base: ".",
			pattern: [
				"content/docs/**/[^_]*.{md,mdx}",
				"src/content/docs/reference/**/[^_]*.md",
			],
			// TypeDoc writes to Starlight's conventional directory; handwritten pages stay in place.
			generateId: ({ entry, data }) =>
				String(
					data.slug ??
						entry
							.replace(/^(?:src\/)?content\/docs\//, "")
							.replace(/\.mdx?$/, "")
							.split("/")
							.map((part) => slug(part))
							.join("/")
							.replace(/\/index$/, ""),
				),
		}),
		schema: docsSchema(),
	}),
}
