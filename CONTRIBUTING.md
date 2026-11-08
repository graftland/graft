# Contributing to Graft

Run commands from the repository root through `devenv shell --`. Shell entry
formats files with treefmt.

```sh
devenv shell -- pnpm install --frozen-lockfile
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm vitest run --project <package>
devenv shell -- pnpm test:packages
```

Code, comments and test names use English. Follow `CLAUDE.md` and read
[the docs style guide](packages/docs/STYLE.md) before changing documentation.
Public behavior changes include matching English, Simplified Chinese and
Traditional Chinese guide updates.

Include a changeset in pull requests that change public packages:

```sh
devenv shell -- pnpm changeset
```

Select affected public packages and describe what users need to know, including
migration steps for breaking changes. All public packages share a fixed release
version; private workspaces are not released. Documentation-only and test-only
changes need no changeset.

Maintainers review the generated **Version Packages** pull request, merge it,
and tag the version it commits. The Changesets workflow does not publish. See
the [publishing guide](packages/docs/content/docs/publishing.md) for the release
procedure, publishing guarantees and repository setup
([简体中文](packages/docs/content/docs/zh-cn/publishing.md),
[繁體中文](packages/docs/content/docs/zh-tw/publishing.md)).
