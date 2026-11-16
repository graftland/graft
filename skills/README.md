# Agent skills

Skills for coding agents that work on code built with Graft, Effect's dynamic
Layer library. Each folder holds a `SKILL.md` and the references it loads on
demand.

| Skill            | Use it to                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`graft`](graft) | Mount layers that build and tear down, publish values, isolate tenants, observe the graph, and run a service remotely. |

Install them with the [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add graftland/graft
```

Or copy a skill folder into your agent's skills directory, such as
`.claude/skills/` for Claude Code or `.agents/skills/` for Codex.
