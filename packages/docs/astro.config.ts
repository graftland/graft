import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import starlightLlmsTxt from "starlight-llms-txt"

// DOCS_URL is the public address of the site, such as
// https://graftland.github.io/graft/. Its path becomes the base of every page.
const url = new URL(process.env["DOCS_URL"] ?? "http://localhost:4321/")

export default defineConfig({
	site: url.origin,
	base: url.pathname,
	trailingSlash: "always",
	integrations: [
		starlight({
			title: "Graft",
			description:
				"A plugin framework built on Effect: plugins, services and hot reload in a running process.",
			favicon: "/favicon.svg",
			// English pages are at the root; translations are in a folder named
			// after the locale.
			defaultLocale: "root",
			locales: {
				root: { label: "English", lang: "en" },
				"zh-cn": { label: "简体中文", lang: "zh-CN" },
				"zh-tw": { label: "繁體中文", lang: "zh-TW" },
			},
			// Starlight adds its Markdown features, such as the links next to
			// headings, only to pages in `src/content/docs`. Our pages are in
			// `content/docs`, so we name that folder here.
			markdown: { processedDirs: ["./content/docs"] },
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/graftland/graft",
				},
			],
			editLink: {
				baseUrl: "https://github.com/graftland/graft/edit/main/packages/docs/",
			},
			plugins: [starlightLlmsTxt({ projectName: "Graft" })],
			sidebar: [
				{
					label: "Start here",
					translations: { "zh-CN": "开始", "zh-TW": "開始" },
					items: ["index", "quickstart", "cordis"],
				},
				{
					label: "Guides",
					translations: { "zh-CN": "指南", "zh-TW": "指南" },
					items: ["plugins", "services", "lifecycle", "isolation", "events"],
				},
				{
					label: "Applications",
					translations: { "zh-CN": "应用", "zh-TW": "應用" },
					items: ["config-file", "hot-reload", "remote", "cli", "embedding"],
				},
				{
					label: "Project",
					translations: { "zh-CN": "项目", "zh-TW": "專案" },
					items: ["releases"],
				},
			],
		}),
	],
})
