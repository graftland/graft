# @graftland/package-manager

Installs dependencies with npm, pnpm or Yarn, and rolls back on failure.

```sh
npm install @graftland/package-manager effect
```

`make` detects the project's package manager. Its `install` adds, updates or
removes dependencies, and restores `package.json` and the lockfile if installing
fails. `graft add` and `graft remove` use it.

## Documentation

- [Command line](https://graftland.github.io/graft/cli/)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
