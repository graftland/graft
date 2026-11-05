# Graft app

A [Graft](https://github.com/graftland/graft) application. `graft.yml` lists the
plugins to run, and `src/hello.ts` is an example plugin.

| Script              | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm run dev`       | Runs the application and reloads plugins and config as files change |
| `npm start`         | Runs the application                                                |
| `npm run typecheck` | Checks types, including Effect diagnostics                          |

Use the same scripts with pnpm (`pnpm dev`) or Yarn (`yarn dev`). Node runs the
TypeScript sources directly; there is no build step.
