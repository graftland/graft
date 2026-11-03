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
files that `check` packed and tested. They never build again.

Each registry has a fixed job concurrency group (`publish-npm` or
`publish-github-packages`), with `cancel-in-progress: false` and `queue: max`.
The group covers the whole publishing job: reading tags, choosing a tag,
uploading packages, and handling retries. So different versions cannot mix these
operations on the same registry. The two registries have separate queues and can
publish at the same time.

[GitHub concurrency queues](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)
keep up to 100 pending jobs with `queue: max`. When the queue is full, GitHub
cancels extra jobs, and you must run them again. Without `queue: max`, GitHub
keeps only one pending job, and a third job replaces it, even with
`cancel-in-progress: false`. Check the Actions runs for cancelled publishing
jobs, and run them again after the queue is empty. The queue order follows the
time when a job starts waiting, not the version order. So the version comparison
is still needed.

The concurrency group only coordinates this repository's CI jobs. Before a
manual publish or a tag change, wait until all running and queued jobs for that
registry finish. Also stop new publishing jobs until the manual work is done.
Other workflows that publish these packages must use the same group.

## Versions

All packages are released together with one version. `pnpm packages:pack` sets
that version in every public package and pins the dependencies between them to
it. It packs the packages into `.release/` and writes the hash of each file to
`.release/release.json`.

| Event                      | Version                    | npm tag                  | Published to            |
| -------------------------- | -------------------------- | ------------------------ | ----------------------- |
| A push to `main`           | `0.0.0-commit-<full hash>` | `sha-<full hash>`        | GitHub Packages         |
| A tag like `v1.2.3-beta.0` | `1.2.3-beta.0`             | `alpha`, `beta`, or `rc` | GitHub Packages and npm |
| A tag like `v1.2.3`        | `1.2.3`                    | `latest`                 | GitHub Packages and npm |

A prerelease tag names its channel, `alpha`, `beta` or `rc`, followed by a
number. Its packages go under the npm tag of that channel and never become
`latest`. So `npm install @graftland/graft` keeps installing the last stable
release. To install a prerelease, use its channel:

```sh
npm install @graftland/graft@beta
```

Commit snapshots let you try any commit of `main`. To install one from GitHub
Packages, use the version from the workflow run:

```sh
npm install @graftland/graft@0.0.0-commit-<full hash> --registry=https://npm.pkg.github.com
```

GitHub Packages needs a token with `read:packages`, even for public packages. A
package that is published there for the first time may be private. Set its
visibility once in the package settings on GitHub.

You can run the publishing again under the same registry queue. If a version
already exists with the same contents, npm publishing skips it and does not
change tags. GitHub Packages can also repair its channel tag, if that does not
move the tag backward. If the contents differ, the script stops. Our npm trusted
publisher has publish permission only, so retries never call `npm dist-tag`. If
an npm tag is missing or someone changed it from outside, a maintainer with tag
permission must repair it separately, under the same exclusive publication rule.
Running the job again does not repair that tag.

Because publishing runs one at a time, `latest`, `alpha`, `beta`, and `rc` never
move back to an older version. A first upload and a GitHub tag repair use the
same [SemVer precedence](https://semver.org/#spec-item-11) comparison against
the current version of the target channel. The script reads the complete
`dist-tags` object with an explicit `@<channel>` selector. So packages that have
only prereleases do not need a `latest` tag. A missing channel (E404) is
different from a successful response that is empty or malformed. The second case
stops publishing. Numeric prerelease identifiers are compared as numbers
(`beta.10` is newer than `beta.2`). The major, minor, and patch numbers come
before the prerelease sequence. Build metadata does not affect precedence. A
missing channel can be set up. If you run the version that is already on a
channel again, the tag stays unchanged.

If a new upload is older than the current version of the channel, Graft still
publishes the package. It uses `backport` for stable releases, or
`alpha-backport`, `beta-backport`, or `rc-backport` for prereleases. These
fallback tags mark late uploads. They do not promise to follow the newest
version. Install an older release by its exact version when you need it. Running
an older existing version again does not move its channel or repair a fallback
tag. For example, if you publish `0.2.0-beta.2` before `0.2.0-beta.1`, or run
`beta.1` again afterward, `beta` stays on `beta.2`.

Direct concurrent runs of the release script have no lock and do not give the
channel guarantee. You still need the registry queue. Version comparison alone
cannot make registry reads and writes atomic.

## Release a version

1. Make sure `main` passes CI.
2. Tag the commit and push the tag, such as `v1.2.3` for a stable release or
   `v1.2.3-beta.0` for a prerelease:

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

3. The `npm` job waits for the `npm` environment, if it needs approval, and then
   publishes.

The `npm` job uses npm's
[trusted publishing](https://docs.npmjs.com/trusted-publishers). npm accepts the
OIDC token of the workflow run instead of an access token, and adds a provenance
statement to every package. The repository stores no secret. Each package trusts
the `ci.yml` workflow of `graftland/graft` in the `npm` environment:

```sh
npm trust github @graftland/graft --file ci.yml --repo graftland/graft --env npm --allow-publish
npm trust list @graftland/graft
```

npm can trust only a package that already exists. So a maintainer publishes a
new package once from the files that CI packed, and trusts it afterwards:

```sh
gh run download <run id> --name packages-<commit hash> --dir .release
npm login
devenv shell -- pnpm packages:publish npm
```

## Docs site

The workflow `.github/workflows/docs.yml` builds this site from `packages/docs`
on every push to `main`. It deploys the site to GitHub Pages at
[graftland.github.io/graft](https://graftland.github.io/graft/). You can also
start it by hand from the Actions tab. Only one deploy runs at a time.

The repository's Pages source must be **GitHub Actions**. To work on the site on
your computer:

```sh
devenv shell -- pnpm --filter @graftland/docs dev
```

English pages are in `packages/docs/content/docs`, Simplified Chinese pages in
its `zh-cn` folder, and Traditional Chinese pages in its `zh-tw` folder, with
the same file names. Link between pages with relative links, such as
`../plugins/`, so that the links work under the site's base path.

Every README has `README.zh-CN.md` and `README.zh-TW.md` translations next to
it. They are written from the English README. If you change an English README or
an English docs page, update the translations in the same change.
