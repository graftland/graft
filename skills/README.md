# Agent skills

Skills for coding agents that work on Graft applications and plugins. Each
folder holds a `SKILL.md` and the references it loads on demand.

| Skill                                            | Use it to                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| [`graft`](graft)                                 | Design an app as plugins and Effects, then write, test, run and debug it. |
| [`migrate-cordis-plugin`](migrate-cordis-plugin) | Port a cordis plugin or service, and its tests, to Graft.                 |
| [`migrate-cordis-app`](migrate-cordis-app)       | Move a cordis application: `cordis.yml`, its plugins, and its host.       |

Install them with the [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add graftland/graft
```

Or copy a skill folder into your agent's skills directory, such as
`.claude/skills/` for Claude Code or `.agents/skills/` for Codex.
