---
title: Releases
description:
  How Graft is checked, published to npm and GitHub Packages, and how the docs
  are deployed.
---

This page is for contributors who check or publish Graft.

## Checks

Run every command in the project's devenv shell:

```sh
devenv shell -- pnpm install
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm test:packages
```

Entering the shell formats the code with treefmt. `pnpm test:packages` tests the
release script.

The CLI's build also writes `packages/cli/schema.json`, the
[JSON Schema of the config file](../config-file/#editor-support), from the
loader's entry fields and the intercepts the CLI registers. It is not committed;
each release packs the one its build generated.

## GitHub Actions

The workflow `.github/workflows/ci.yml` runs for pull requests, for pushes to
`main`, and for tags like `v1.2.3` or `v1.2.3-beta.0`.

| Job               | When            | What it does                                                                  |
| ----------------- | --------------- | ----------------------------------------------------------------------------- |
| `check`           | Always          | Checks formatting, builds, typechecks, tests, and packs every public package. |
| `github-packages` | Pushes and tags | Publishes the packed files to GitHub Packages.                                |
| `npm`             | Tags            | Publishes the packed files to npm with trusted publishing.                    |

The publishing jobs run only after `check` passes. They publish exactly the
files that `check` packed and tested, and never build again.

### Publishing queues

Each registry has a fixed job concurrency group, with
`cancel-in-progress: false` and `queue: max`.

| Registry        | Group                     |
| --------------- | ------------------------- |
| npm             | `publish-npm`             |
| GitHub Packages | `publish-github-packages` |

- **Scope.** The group covers the whole publishing job: reading tags, choosing a
  tag, uploading packages and handling retries. Different versions cannot mix
  these operations on the same registry.
- **Independence.** The two registries have separate queues and can publish at
  the same time.
- **Order.** The queue order follows the time when a job starts waiting, not the
  version order, so the version comparison is still needed.
- **Capacity.**
  [GitHub concurrency queues](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)
  keep up to 100 pending jobs with `queue: max`. When the queue is full, GitHub
  cancels extra jobs, so check the Actions runs for cancelled publishing jobs
  and run them again after the queue is empty. Without `queue: max`, GitHub
  keeps only one pending job, and a third job replaces it.

:::caution

The concurrency group only coordinates this repository's CI jobs. Before a
manual publish or a tag change, wait until all running and queued jobs for that
registry finish, and stop new publishing jobs until the manual work is done.
Other workflows that publish these packages must use the same group.

:::

## Versions

All packages are released together with one version. `pnpm packages:pack` sets
that version in every public package, pins the dependencies between them to it,
packs the packages into `.release/` and writes the hash of each file to
`.release/release.json`.

| Event                      | Version                    | npm tag                  | Published to            |
| -------------------------- | -------------------------- | ------------------------ | ----------------------- |
| A push to `main`           | `0.0.0-commit-<full hash>` | `sha-<full hash>`        | GitHub Packages         |
| A tag like `v1.2.3-beta.0` | `1.2.3-beta.0`             | `alpha`, `beta`, or `rc` | GitHub Packages and npm |
| A tag like `v1.2.3`        | `1.2.3`                    | `latest`                 | GitHub Packages and npm |

### Install a prerelease or snapshot

A prerelease tag names its channel, `alpha`, `beta` or `rc`, followed by a
number. Its packages go under the npm tag of that channel and never become
`latest`, so `npm install @graftland/graft` keeps installing the last stable
release.

| You want…            | Run                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------- |
| A prerelease         | `npm install @graftland/graft@beta`                                                           |
| Any commit of `main` | `npm install @graftland/graft@0.0.0-commit-<full hash> --registry=https://npm.pkg.github.com` |

For commit snapshots, use the version from the workflow run. GitHub Packages
needs a token with `read:packages`, even for public packages. A package
published there for the first time may be private; set its visibility once in
the package settings on GitHub.

## Publishing guarantees

### Retries

You can run the publishing again under the same registry queue.

| Situation                                    | npm                                                                                                                                          | GitHub Packages                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Version exists with the same contents        | Skipped. Tags are not changed.                                                                                                               | Skipped. It can repair its channel tag if that does not move the tag backward. |
| Version exists with different contents       | The script stops.                                                                                                                            | The script stops.                                                              |
| A tag is missing or was changed from outside | A maintainer with tag permission repairs it separately, under the same exclusive publication rule. Running the job again does not repair it. | Repaired as above.                                                             |

The npm trusted publisher has publish permission only, so retries never call
`npm dist-tag`.

### Channels never move backward

Because publishing runs one at a time, `latest`, `alpha`, `beta` and `rc` never
move back to an older version.

- A first upload and a GitHub tag repair use the same
  [SemVer precedence](https://semver.org/#spec-item-11) comparison against the
  current version of the target channel.
- Numeric prerelease identifiers compare as numbers (`beta.10` is newer than
  `beta.2`). Major, minor and patch come before the prerelease sequence. Build
  metadata does not affect precedence.
- The script reads the complete `dist-tags` object with an explicit `@<channel>`
  selector, so packages that have only prereleases do not need a `latest` tag.
- A missing channel (E404) can be set up. A successful response that is empty or
  malformed stops publishing.
- Running the version already on a channel again leaves the tag unchanged.

### Late uploads

If a new upload is older than the current version of the channel, Graft still
publishes the package under a fallback tag:

| Release kind | Fallback tag                                       |
| ------------ | -------------------------------------------------- |
| Stable       | `backport`                                         |
| Prerelease   | `alpha-backport`, `beta-backport` or `rc-backport` |

These tags mark late uploads and do not promise to follow the newest version.
Install an older release by its exact version. Running an older existing version
again does not move its channel or repair a fallback tag. For example, if you
publish `0.2.0-beta.2` before `0.2.0-beta.1`, or run `beta.1` again afterward,
`beta` stays on `beta.2`.

:::note

Direct concurrent runs of the release script have no lock and do not give the
channel guarantee. You still need the registry queue; version comparison alone
cannot make registry reads and writes atomic.

:::

## Release a version

1. Make sure `main` passes CI.
2. Tag the commit and push the tag, such as `v1.2.3`. While Graft is on 0.x,
   release plain versions such as `v0.3.0`: a 0.x version already says the API
   may change, so it needs no `-beta` suffix. Prerelease tags such as
   `v1.2.3-beta.0` remain available:

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

3. The `npm` job waits for the `npm` environment, if it needs approval, and then
   publishes.

### Trusted publishing

The `npm` job uses npm's
[trusted publishing](https://docs.npmjs.com/trusted-publishers): npm accepts the
OIDC token of the workflow run instead of an access token, and adds a provenance
statement to every package. The repository stores no secret. Each package trusts
the `ci.yml` workflow of `graftland/graft` in the `npm` environment:

```sh
npm trust github @graftland/graft --file ci.yml --repo graftland/graft --env npm --allow-publish
npm trust list @graftland/graft
```

### Publish a new package

npm can trust only a package that already exists. A maintainer publishes a new
package once from the files that CI packed, and trusts it afterwards:

```sh
gh run download <run id> --name packages-<commit hash> --dir .release
npm login
devenv shell -- pnpm packages:publish npm
```

## Docs site

The workflow `.github/workflows/docs.yml` builds this site from `packages/docs`
on every push to `main` and deploys it to GitHub Pages at
[graftland.github.io/graft](https://graftland.github.io/graft/). You can also
start it by hand from the Actions tab. Only one deploy runs at a time.

| Task                     | How                                                      |
| ------------------------ | -------------------------------------------------------- |
| Pages source             | Set the repository's Pages source to **GitHub Actions**. |
| Work on the site locally | `devenv shell -- pnpm --filter @graftland/docs dev`      |

### Writing pages

| Language            | Folder                             |
| ------------------- | ---------------------------------- |
| English             | `packages/docs/content/docs`       |
| Simplified Chinese  | `packages/docs/content/docs/zh-cn` |
| Traditional Chinese | `packages/docs/content/docs/zh-tw` |

- Use the same file names in every folder.
- Link between pages with relative links, such as `../plugins/`, so that links
  work under the site's base path.
- Prefer tables, numbered steps and short lists over long paragraphs. Open a
  page with what it covers, and end it with where to go next.
- Every README has `README.zh-CN.md` and `README.zh-TW.md` translations next to
  it, written from the English README. If you change an English README or an
  English docs page, update the translations in the same change.
