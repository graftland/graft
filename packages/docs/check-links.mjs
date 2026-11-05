import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const decode = (text) =>
	text.replace(
		/&(?:amp|quot|apos|lt|gt|#(x[0-9a-f]+|[0-9]+));/gi,
		(entity, code) =>
			code
				? String.fromCodePoint(
						code[0].toLowerCase() === "x"
							? parseInt(code.slice(1), 16)
							: Number(code),
					)
				: {
						"&amp;": "&",
						"&quot;": '"',
						"&apos;": "'",
						"&lt;": "<",
						"&gt;": ">",
					}[entity],
	)

/** Check emitted local anchors and pages, including localized fallback navigation. */
export function checkLinks(directory, site) {
	const files = readdirSync(directory, { recursive: true }).filter((file) =>
		file.endsWith(".html"),
	)
	const pages = new Map(
		files.map((file) => {
			const html = readFileSync(join(directory, file), "utf8")
			return [
				file,
				{
					ids: new Set(
						[...html.matchAll(/\bid="([^"]*)"/g)].map((match) =>
							decode(match[1]),
						),
					),
					links: [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) =>
						decode(match[1]),
					),
				},
			]
		}),
	)
	const failures = new Map()
	for (const [file, page] of pages) {
		const from = new URL(file.replace(/index\.html$/, ""), site)
		for (const href of page.links) {
			const target = new URL(href, from)
			if (
				target.origin !== site.origin ||
				!["http:", "https:"].includes(target.protocol)
			)
				continue
			if (!target.pathname.startsWith(site.pathname)) {
				failures.set(target.href, `${file}: link escapes site base: ${href}`)
				continue
			}
			const path = decodeURIComponent(
				target.pathname.slice(site.pathname.length),
			)
			const destination =
				path.endsWith("/") || path === "" ? path + "index.html" : path
			if (!existsSync(join(directory, destination)))
				failures.set(target.href, `${file}: missing page: ${href}`)
			else if (
				target.hash &&
				pages.has(destination) &&
				!pages
					.get(destination)
					.ids.has(decodeURIComponent(target.hash.slice(1)))
			)
				failures.set(target.href, `${file}: missing anchor: ${href}`)
		}
	}
	if (failures.size)
		throw new Error(
			`Found ${failures.size} broken local links:\n${[...failures.values()].slice(0, 20).join("\n")}`,
		)
	return files.length
}

export function referenceLinkCheck(site) {
	return {
		name: "check-documentation-links",
		hooks: {
			"astro:build:done"({ dir, logger }) {
				const count = checkLinks(fileURLToPath(dir), site)
				logger.info(`Checked local links and anchors in ${count} HTML pages.`)
			},
		},
	}
}
