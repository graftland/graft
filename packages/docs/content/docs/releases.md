---
title: Releases
description: How Graft is checked, packed, published and documented.
---

Every change runs through CI, which builds one package, packs it once and
publishes exactly those files to GitHub Packages and npm. The docs site deploys
separately to docs.graft.land.

## Checks

Run every command in the project's devenv shell:

```sh
devenv shell -- pnpm install --frozen-lockfile
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm test:packages
```

Entering the shell formats the code with treefmt. CI runs it the same way and
fails when formatting changes a file.

`pnpm test` runs every vitest project. The workspace project checks that each
exported signature can be named through the package's public exports. If it
fails, remove the implementation type from the public signature, or export a
type that belongs to the public contract.

The documentation checks run in the docs package:

```sh
devenv shell -- pnpm --filter @graftland/docs test
devenv shell -- pnpm --filter @graftland/docs build
```

The tests typecheck every code block and run its doctests. The build checks
every local link and anchor.

## One package

Graft publishes `@graftland/graft` only.

| Entry       | Contents                            |
| ----------- | ----------------------------------- |
| `.`         | `Graft`, `Mount` and `Release`.     |
| `./rpc`     | Remote services over `effect/rpc`.  |
| `./node`    | Child process and worker protocols. |
| `./testing` | An in-memory protocol for tests.    |

`effect` is a peer dependency with the constraint `4.1.*`.
`@effect/platform-node` is an optional peer, needed only by `./node`.

## Packaging

`pnpm packages:pack` builds the workspace, gives the public package the version
the ref implies, and packs it into `.release/`. `.release/release.json` records
that version, the commit and the sha512 integrity of each packed file.

Only public, non-private packages are packed; on this branch that is
`@graftland/graft` alone.

| Event                      | Version                    | npm tag                  | Published to            |
| -------------------------- | -------------------------- | ------------------------ | ----------------------- |
| A push to `main`           | `0.0.0-commit-<full hash>` | `sha-<full hash>`        | GitHub Packages         |
| A tag like `v1.2.3-beta.0` | `1.2.3-beta.0`             | `alpha`, `beta`, or `rc` | GitHub Packages and npm |
| A tag like `v1.2.3`        | `1.2.3`                    | `latest`                 | GitHub Packages and npm |

A tag must match the version that Changesets committed. When it does not,
packing stops and asks you to merge the **Version Packages** pull request first.

### Install a prerelease or snapshot

A prerelease tag names its channel, `alpha`, `beta` or `rc`, followed by a
number. Its package goes under the npm tag of that channel and never becomes
`latest`, so `npm install @graftland/graft` keeps installing the last stable
release.

| You want…            | Run                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------- |
| A prerelease         | `npm install @graftland/graft@beta`                                                           |
| Any commit of `main` | `npm install @graftland/graft@0.0.0-commit-<full hash> --registry=https://npm.pkg.github.com` |

Commit snapshots go to GitHub Packages only. For them, use the version from the
workflow run. GitHub Packages needs a token with `read:packages`, even for
public packages. A package published there for the first time may be private;
set its visibility once in the package settings on GitHub.

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

## Release a version

1. **Merge the Version Packages pull request** so the new version is committed.
   The Changesets workflow opens or updates that pull request; it never
   publishes.
2. **Make sure `main` passes CI.**
3. **Tag the commit and push the tag**, such as `v1.2.3`. While Graft is on 0.x,
   release plain versions such as `v0.3.0`: a 0.x version already says the API
   may change, so it needs no `-beta` suffix. Prerelease tags such as
   `v1.2.3-beta.0` remain available:

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

4. **The `npm` job waits for the `npm` environment**, if it needs approval, and
   then publishes. The `github-packages` job publishes the same files under its
   own queue.

### Trusted publishing

The `npm` job uses npm's
[trusted publishing](https://docs.npmjs.com/trusted-publishers): npm accepts the
OIDC token of the workflow run instead of an access token, and adds a provenance
statement to the package. The repository stores no secret. The package trusts
the `ci.yml` workflow of `graftland/graft` in the `npm` environment:

```sh
npm trust github @graftland/graft --file ci.yml --repo graftland/graft --env npm --allow-publish
npm trust list @graftland/graft
```

### Before the first trusted publish

npm can trust only a package that already exists, and the published
`@graftland/graft` is still version 0.6. A maintainer makes the first upload of
a new line from the files that CI packed, then sets up trusted publishing:

```sh
gh run download <run id> --name packages-<commit hash> --dir .release
npm login
devenv shell -- pnpm packages:publish npm
```

After that upload, set up trusted publishing as above.

## GitHub Actions

The workflow `.github/workflows/ci.yml` runs for pull requests, for pushes to
`main`, and for tags like `v1.2.3` or `v1.2.3-beta.0`.

| Job               | When              | What it does                                                                  |
| ----------------- | ----------------- | ----------------------------------------------------------------------------- |
| `check`           | Always            | Checks formatting, builds, typechecks, tests the release script and packs.    |
| `projects`        | Always            | Lists the vitest projects, so a new one gets a test job without editing this. |
| `test`            | Always            | Runs each vitest project in a matrix.                                         |
| `github-packages` | Pushes and tags   | Publishes the packed files to GitHub Packages.                                |
| `npm`             | Tags              | Publishes the packed files to npm with trusted publishing.                    |
| `github-release`  | Tags, after `npm` | Creates the GitHub Release from the changesets of that version.               |

The `github-packages` and `npm` jobs need both `check` and `test` to pass. They
publish exactly the files that `check` packed and tested, and never build again.

### Publishing queues

Each registry has a fixed job concurrency group, with
`cancel-in-progress: false` and `queue: max`.

| Registry        | Group                     |
| --------------- | ------------------------- |
| npm             | `publish-npm`             |
| GitHub Packages | `publish-github-packages` |

- **Scope.** The group covers the whole publishing job: reading tags, choosing a
  tag, uploading packages and handling retries.
- **Independence.** The two registries have separate queues and can publish at
  the same time.
- **Order.** The queue order follows the time when a job starts waiting, not the
  version order, so the version comparison is still needed.
- **Capacity.** GitHub keeps up to 100 pending jobs with `queue: max`. When the
  queue is full, GitHub cancels extra jobs, so check the Actions runs for
  cancelled publishing jobs and run them again after the queue is empty.

:::caution

The concurrency group only coordinates this repository's CI jobs. Before a
manual publish or a tag change, wait until all running and queued jobs for that
registry finish, and stop new publishing jobs until the manual work is done.
Other workflows that publish this package must use the same group.

:::

## Docs site

The workflow `.github/workflows/docs.yml` builds this site from `packages/docs`
on every push to `main` and every `v*` tag, and deploys it to a Cloudflare
Worker at [docs.graft.land](https://docs.graft.land/). Production always serves
the newest stable release.

| Job          | What it does                                                 |
| ------------ | ------------------------------------------------------------ |
| `plan`       | Chooses the commits to build.                                |
| `production` | Builds the commit that becomes the production site.          |
| `build`      | Builds each other kept commit as its own preview.            |
| `list`       | Updates the commit list and deletes the docs no longer kept. |
| `redirect`   | Writes the redirect from the old GitHub Pages address.       |

The newest 15 release tags and the newest 30 commits on `main` each keep their
own Worker Preview at `https://<first 12 characters of the hash>.<site host>/`.
`https://versions.<site host>/` serves the commit list and the version select.
The old addresses `graftland.github.io/graft` and `graft-docs-ekb.pages.dev`
redirect to `docs.graft.land`.

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
- Link between pages with relative links, such as `../remote/`, so that links
  work under the site's base path.
- Every English README has `README.zh-CN.md` and `README.zh-TW.md` translations
  next to it, written from the English README. If you change an English README
  or an English docs page, update the translations in the same change.
- Read `packages/docs/STYLE.md` before writing a page.
- Run `node snippets.mjs check` and `pnpm vitest run` in `packages/docs` to
  typecheck the examples and run their doctests.

## Former packages

Earlier versions of Graft were a plugin runtime spread over several packages.
Those packages are no longer developed. The table lists the last version each
one published to npm.

| Package                        | Last release  | Use instead                                      |
| ------------------------------ | ------------- | ------------------------------------------------ |
| `@graftland/loader`            | `0.6.0`       | `Graft.mount` in your own program.               |
| `@graftland/cli`               | `0.6.0`       | Nothing; there is no command and no config file. |
| `@graftland/create`            | `0.6.0`       | Nothing.                                         |
| `@graftland/package-manager`   | `0.6.0`       | Nothing.                                         |
| `@graftland/plugin-remote`     | `0.6.0`       | The `rpc` entry.                                 |
| `@graftland/hmr`               | `0.5.0`       | Nothing; Graft no longer reloads modules.        |
| `@graftland/plugin-http`       | `0.5.0`       | Nothing.                                         |
| `@graftland/plugin-http-api`   | `0.5.0`       | Nothing.                                         |
| `@graftland/plugin-mcp-server` | `0.5.0`       | Nothing.                                         |
| `@graftland/plugin-otlp`       | `0.5.0`       | Nothing.                                         |
| `@graftland/plugin-release`    | Not published | Nothing.                                         |

`@graftland/plugin-release` was never published, so there is nothing to
deprecate.

Marking a package as deprecated on npm with `npm deprecate` is a separate
decision. This page does not require it, and it does not change the versions
already published.
