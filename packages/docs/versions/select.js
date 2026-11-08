// Adds the commit select next to the theme select and, on a commit that is not
// the default release, a notice above the page. Every deployed build loads this file
// from the versions deployment, so a change here reaches every commit at once.
;(() => {
	const strings = {
		en: {
			label: "Docs version",
			releases: "Releases",
			commits: "Commits",
			latest: "default",
			unknown: "This build",
			notice: (name) => `You are reading the docs as of ${name}.`,
			go: "Go to the docs of the latest release",
		},
		"zh-CN": {
			label: "文档版本",
			releases: "发布版本",
			commits: "Commit",
			latest: "默认",
			unknown: "当前构建",
			notice: (name) => `你正在阅读 ${name} 时的文档。`,
			go: "前往最新发布版本的文档",
		},
		"zh-TW": {
			label: "文件版本",
			releases: "發佈版本",
			commits: "Commit",
			latest: "預設",
			unknown: "目前建置",
			notice: (name) => `你正在閱讀 ${name} 時的文件。`,
			go: "前往最新發佈版本的文件",
		},
	}
	const t = strings[document.documentElement.lang] ?? strings.en
	const list = new URL("versions.json", document.currentScript.src)

	const style = `
		graft-version-select { display: flex; align-items: center; position: relative; color: var(--sl-color-gray-2); }
		graft-version-select:hover { color: var(--sl-color-white); }
		graft-version-select select {
			border: 0; padding-block: 0.625rem; padding-inline: 0.25rem 1.25rem;
			width: 9em; background: transparent; color: inherit; cursor: pointer;
			appearance: none; text-overflow: ellipsis; font-size: var(--sl-text-sm);
		}
		graft-version-select option { background-color: var(--sl-color-bg-nav); color: var(--sl-color-gray-1); }
		graft-version-select::after { content: "▾"; position: absolute; inset-inline-end: 0.25rem; pointer-events: none; }
		graft-version-notice {
			display: block; padding: var(--sl-nav-pad-y) var(--sl-nav-pad-x);
			background-color: var(--sl-color-accent-low); color: var(--sl-color-white);
			line-height: var(--sl-line-height-headings); text-align: center; text-wrap: balance;
		}
		graft-version-notice a { color: var(--sl-color-text-accent); }
	`

	// The commit this page belongs to, read from the address: production, or
	// `<first 12 hash characters>.<site host>`.
	const currentCommit = ({ site, production, versions }) => {
		if (location.host === new URL(site).host) return production
		const label = location.hostname.split(".")[0]
		return versions.find(({ commit }) => commit.startsWith(label))?.commit
	}

	// The same page on another deployment. Every deployment uses the same base.
	const samePage = (root) => {
		const base = new URL(root).pathname
		const path = location.pathname.startsWith(base)
			? location.pathname.slice(base.length)
			: ""
		return new URL(path + location.search + location.hash, root).href
	}

	// A release by its tags and date; a commit by its short hash, date and
	// subject.
	const label = (version, production) =>
		(version.tags.length
			? [
					version.tags.join(", "),
					version.date.slice(0, 10),
					version.commit === production ? `(${t.latest})` : "",
				]
			: [version.commit.slice(0, 7), version.date.slice(0, 10), version.subject]
		)
			.filter(Boolean)
			.join(" · ")

	const select = (data, current) => {
		const root = (version) =>
			version.commit === data.production ? data.site : version.url
		const element = document.createElement("graft-version-select")
		const field = document.createElement("select")
		field.setAttribute("aria-label", t.label)
		field.autocomplete = "off"
		if (!current) field.append(new Option(t.unknown, "", true, true))
		// Tagged commits first, then the others, each newest first.
		for (const [name, tagged] of [
			[t.releases, true],
			[t.commits, false],
		]) {
			const group = document.createElement("optgroup")
			group.label = name
			for (const version of data.versions)
				if (version.tags.length > 0 === tagged)
					group.append(
						new Option(
							label(version, data.production),
							version.commit,
							false,
							version.commit === current,
						),
					)
			if (group.children.length) field.append(group)
		}
		field.addEventListener("change", () => {
			const version = data.versions.find(({ commit }) => commit === field.value)
			if (version) location.href = samePage(root(version))
		})
		element.append(field)
		return element
	}

	const notice = (data, current) => {
		const element = document.createElement("graft-version-notice")
		element.dataset.pagefindIgnore = ""
		const link = document.createElement("a")
		link.href = samePage(data.site)
		link.textContent = t.go
		const version = data.versions.find(({ commit }) => commit === current)
		const name = version?.tags[0] ?? `commit ${current.slice(0, 7)}`
		element.append(`${t.notice(name)} `, link)
		return element
	}

	const show = (data) => {
		const current = currentCommit(data)
		const sheet = document.createElement("style")
		sheet.textContent = style
		document.head.append(sheet)
		for (const theme of document.querySelectorAll("starlight-theme-select"))
			theme.before(select(data, current))
		const main = document.querySelector("main")
		if (main && current && current !== data.production)
			main.prepend(notice(data, current))
	}

	// A missing or unreadable list leaves the page as it was built.
	fetch(list, { cache: "no-cache" })
		.then((response) => (response.ok ? response.json() : undefined))
		.then((data) => {
			if (!data) return
			if (document.readyState === "loading")
				document.addEventListener("DOMContentLoaded", () => show(data))
			else show(data)
		})
		.catch(() => undefined)
})()
