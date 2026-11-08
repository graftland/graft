---
title: Publishing
description:
  Add changesets, review version updates, and publish Graft packages and release
  notes.
---

Graft uses **Changesets** to record user-facing changes and prepare package
versions and changelogs. CI publishes the checked packages when a maintainer
pushes the matching version tag.

## Checks

Run commands from the repository root in the project's devenv shell:

```sh
devenv shell -- pnpm install --frozen-lockfile
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm vitest run --project <package>
devenv shell -- pnpm test:packages
```

Shell entry formats files with treefmt. Run the tests for each package you
change; `pnpm test:packages` checks packing, publishing and release notes.

## Add a changeset

Include a changeset in a pull request that changes public packages:

```sh
devenv shell -- pnpm changeset
```

| Choice             | Rule                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packages           | Select the affected public packages. All public `@graftland/*` packages belong to one fixed group and receive the same version.                      |
| Bump               | Use `patch` for fixes, `minor` for features, and mark breaking changes with migration instructions. While on 0.x, breaking changes use a minor bump. |
| Summary            | Describe the user-visible behavior. Put **Breaking** changes first and explain how to update.                                                        |
| Private workspaces | Samples, docs and benchmarks are neither versioned nor tagged.                                                                                       |
| No public change   | Documentation-only and test-only pull requests need no changeset.                                                                                    |

Commit the generated `.changeset/*.md` with the change. Check the pending
versions with `devenv shell -- pnpm changeset status`.

## Version Packages pull request

On pushes to `main` in `graftland/graft`, `.github/workflows/release.yml` opens
or updates **Version Packages**. It consumes the pending changesets, updates
package versions and writes each public package's `CHANGELOG.md`. Review and
merge that pull request before tagging. This workflow never publishes packages
or creates a GitHub Release, and it does not run on forks.

Enable **Allow GitHub Actions to create and approve pull requests** in the
repository's Actions settings. The workflow uses `GITHUB_TOKEN`; a maintainer
with write access selects **Approve workflows to run** on the generated pull
request to start its checks before merging.

## GitHub Actions

`.github/workflows/ci.yml` runs for pull requests, pushes to `main`, and version
tags such as `v1.2.3` or `v1.2.3-beta.0`.

| Job               | When                                      | What it does                                                                              |
| ----------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `check`           | Always                                    | Checks formatting, builds, typechecks, tests release scripts and packs public packages.   |
| `test`            | Always                                    | Tests every package and sample.                                                           |
| `github-packages` | Pushes and tags, after `check` and `test` | Publishes the checked files to GitHub Packages.                                           |
| `npm`             | Tags, after `check` and `test`            | Publishes the checked files to npm with trusted publishing.                               |
| `github-release`  | Tags, after `npm` succeeds                | Creates one GitHub Release with the version's changelog entries from all public packages. |

Publishing uses exactly the files that `check` packed, without rebuilding.
Release notes deduplicate identical entries and identify their packages.
Prerelease tags create prerelease GitHub Releases. A rerun keeps an existing
GitHub Release unchanged.

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

All public packages share one committed version. For a release tag, packing
requires every public `package.json` version to equal the tag's version; a
mismatch stops before packing. Snapshots derive their version from the commit.
`pnpm packages:pack` pins dependencies between public packages to the packed
version and writes the files and their integrity hashes to `.release/`.

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
- A missing channel (E404) can be set up. A package that has only prereleases
  has no `latest` yet; its tags are listed with `npm dist-tag ls`, so its first
  stable release sets `latest` up too. A successful response that is empty or
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

## Publish a version

1. **Merge** the Version Packages pull request and wait for `main` to pass CI.
2. **Tag** that commit with its committed package version and push the tag:

   ```sh
   git tag v0.6.0
   git push origin v0.6.0
   ```

3. **Check** the tag's CI run. The `npm` job waits for the `npm` environment if
   it requires approval. After npm succeeds, `github-release` creates the
   combined GitHub Release.

While Graft is on 0.x, use plain versions such as `v0.6.0`. To prepare an
`alpha`, `beta` or `rc` prerelease, use Changesets' prerelease mode so manifests
and changelogs contain the exact prerelease version before tagging:

```sh
devenv shell -- pnpm changeset pre enter beta
devenv shell -- pnpm changeset-version
```

Review and merge those changes before tagging `v0.6.0-beta.0`. When the series
is ready for a stable release, run `devenv shell -- pnpm changeset pre exit` and
let Version Packages prepare the stable version. Do not version packages
manually in parallel with the automated pull request.

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
and deploys it to a Cloudflare Worker at
[docs.graft.land](https://docs.graft.land/). The newest 15 release tags and the
newest 30 commits on `main` also keep the docs as they were at that commit, each
as a **Worker Preview**.

| Address                                               | Shows                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `https://docs.graft.land/`                            | The **default release**: the newest stable tag, such as `v1.2.3`. |
| `https://<first 12 hash characters>.docs.graft.land/` | That commit, while it is kept.                                    |
| `https://versions.docs.graft.land/versions.json`      | Every kept commit, its date, subject and tags.                    |
| `https://graftland.github.io/graft/<path>`            | Redirects to `<path>` on the default release.                     |
| `https://graft-docs-ekb.pages.dev/<path>`             | Redirects to `<path>` on the default release.                     |

### What a run does

| Started by                         | Builds                                               | Then                                                                    |
| ---------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| A push to `main`                   | The pushed commit, and any kept commit without docs. | Updates the list and deletes the docs of commits no longer kept.        |
| A tag like `v1.2.3`                | The tagged commit, only if it has no docs yet.       | Labels the commit with the tag. A newer stable tag becomes the default. |
| Actions tab                        | Any kept commit without docs.                        | Same as a push.                                                         |
| Actions tab, **rebuild** filled in | The named commits too, even if they have docs.       | Replaces their docs and updates the list.                               |

- **Kept.** The commits of the newest 15 release tags, prereleases included, the
  newest 30 commits on `main`, and the default release. A commit can be both a
  tag and one of the 30. The docs of any other commit are deleted, and it leaves
  the list.
- **Once per commit.** A commit is built once, with its own lockfile and
  toolchain. A new default release is built once more to deploy it as
  production. Cloudflare uploads only files it does not have yet.
- **Default.** Prereleases such as `v1.2.3-beta.0` never become the default, as
  on npm. Commits on `main` after the last release are listed but are not the
  default. Production moves only after the release's build succeeds.
- **Order.** Runs update the list one at a time.
- **Failures.** A commit that does not build is left out; the others still
  deploy, and the next run tries it again while it is kept. If the live list
  cannot be read, the run stops rather than start a new one.
- **Search engines.** Only production is indexed; every commit address sends
  `X-Robots-Tag: noindex`.

### Switching versions

Every deployed page loads the select from the versions address.

- **Select.** Next to the theme select. It lists the kept commits in two groups,
  each newest first: **Releases**, the tagged commits by their tags, with the
  default release marked; and **Commits**, the others by their short hash and
  subject. It opens the same page in the chosen version; a page that did not
  exist yet shows that version's 404 page.
- **Notice.** A page of any other commit says so at the top, with a link to the
  same page in the default release.

### Set up

| Task                       | How                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain                     | The zone of `DOCS_URL`'s domain is on the same Cloudflare account. The first run creates the Worker named in `DOCS_WORKER`, the domain, and its wildcard certificate.       |
| `docs` environment secrets | `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN` with **Workers Scripts: Edit** and **Cloudflare Pages: Edit** on the account, and **Workers Routes: Edit** on the zone. |
| Old addresses              | Set the repository's Pages source to **GitHub Actions**. The Cloudflare Pages project in `DOCS_PAGES_PROJECT` keeps only the redirect.                                      |
| Work on the site locally   | `devenv shell -- pnpm --filter @graftland/docs dev`; the select appears only on deployed pages.                                                                             |

### Writing pages

| Language            | Folder                             |
| ------------------- | ---------------------------------- |
| English             | `packages/docs/content/docs`       |
| Simplified Chinese  | `packages/docs/content/docs/zh-cn` |
| Traditional Chinese | `packages/docs/content/docs/zh-tw` |

- Use the same file names in every folder.
- Link between pages with relative links, such as `../plugins/`, so that links
  work under the site's base path.
- Prefer tables, numbered steps and short lists over long paragraphs. State each
  fact once and end where the content ends.
- Every README has `README.zh-CN.md` and `README.zh-TW.md` translations next to
  it, written from the English README. If you change an English README or an
  English docs page, update the translations in the same change.
