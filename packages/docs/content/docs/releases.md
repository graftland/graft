---
title: Releases
description:
  How Graft is checked, published to npm and GitHub Packages, and how the docs
  are deployed.
---

For contributors who check or publish Graft.

## Checks

Every command runs in the project's devenv shell:

```sh
devenv shell -- pnpm install
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm test:packages
```

Entering the shell formats the code with treefmt. `pnpm test:packages` tests the
release script.

## GitHub Actions

The workflow `.github/workflows/ci.yml` runs for pull requests, pushes to
`main`, and tags like `v1.2.3`.

| Job               | When            | What it does                                                                  |
| ----------------- | --------------- | ----------------------------------------------------------------------------- |
| `check`           | Always          | Checks formatting, builds, typechecks, tests, and packs every public package. |
| `github-packages` | Pushes and tags | Publishes the packed files to GitHub Packages.                                |
| `npm`             | Tags            | Publishes the packed files to npm, with provenance.                           |

The publishing jobs run only after `check` passes, and publish exactly the files
that `check` packed and tested. They never build again.

## Versions

All packages are released together with one version. `pnpm packages:pack` sets
that version in every public package, pins the dependencies between them to it,
packs them into `.release/`, and records each file's hash in
`.release/release.json`.

| Event               | Version                    | npm tag           | Published to            |
| ------------------- | -------------------------- | ----------------- | ----------------------- |
| A push to `main`    | `0.0.0-commit-<full hash>` | `sha-<full hash>` | GitHub Packages         |
| A tag like `v1.2.3` | `1.2.3`                    | `latest`          | GitHub Packages and npm |

Commit snapshots let you try any commit of `main`. Install one from GitHub
Packages with the version from the workflow run:

```sh
npm install @graftland/graft@0.0.0-commit-<full hash> --registry=https://npm.pkg.github.com
```

GitHub Packages needs a token with `read:packages` even for public packages. A
package published there for the first time may be private; set its visibility
once in the package settings on GitHub.

Publishing can be run again safely. If a version already exists with the same
contents, the script only sets its tag. If it exists with other contents, the
script stops.

`latest` never moves back. A release older than the current `latest`, such as a
fix for an older line, is published under the `backport` tag instead.

## Release a version

1. Make sure `main` passes CI.
2. Tag the commit and push the tag:

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

3. The `npm` job waits for the `npm` environment, if it requires approval, and
   then publishes.

The `npm` job needs an npm access token that can publish the `@graftland` scope.
Store it as the `NPM_TOKEN` secret of the `npm` environment, in the repository
settings under **Environments**.

## Docs site

The workflow `.github/workflows/docs.yml` builds this site from `packages/docs`
on every push to `main`, and deploys it to GitHub Pages at
[graftland.github.io/graft](https://graftland.github.io/graft/). You can also
start it by hand from the Actions tab. Only one deploy runs at a time.

The repository's Pages source must be **GitHub Actions**. To work on the site
locally:

```sh
devenv shell -- pnpm --filter @graftland/docs dev
```

English pages are in `packages/docs/content/docs`, and Chinese pages in its
`zh-cn` folder, with the same file names. Link between pages with relative
links, such as `../plugins/`, so that links work under the site's base path.
