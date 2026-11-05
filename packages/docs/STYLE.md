# Writing the Graft docs

These rules describe how the pages under `content/docs/` are written. The model
pages are [Services](content/docs/services.md),
[Realms and isolation](content/docs/isolation.md) and
[Events](content/docs/events.md). When a rule here and those pages disagree, fix
whichever is wrong.

## What goes where

| Kind          | Holds                                                             | Written by                                            |
| ------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| Guide page    | One topic: what it is, how to use it, the rules and guarantees.   | Hand, in three languages.                             |
| API reference | Exact signatures, members and doc comments of every public entry. | Generated from source (`/reference/`). Never by hand. |
| Sample README | A runnable walkthrough: steps to follow and what you see.         | Hand, in three languages.                             |

- A topic gets **one** guide page. Split it only when a page passes about 250
  lines and the halves can be read on their own.
- A guide never copies signatures. Show the call a reader writes, then link to
  the API reference for the full type.
- Step-by-step tutorials live in a sample's README, not in a guide. A guide may
  link to the sample.
- A section in the sidebar is a set of topics, not a book. Do not add overview
  pages that only list the other pages.

## Shape of a page

1. **Front matter.** `title` is the topic name. `description` is one sentence
   saying what the reader can do with it.
2. **Opening.** One to three sentences that define the topic. If it makes
   guarantees, list them as two to four bullets. No "this page explains" and no
   "who should read this".
3. **Sections.** Headings name tasks or things: "Publish a service", "Leases",
   "When a failure starts the teardown". Each section is, in order and as
   needed: one sentence, the smallest working code block, then a table or list
   with the rules.
4. **Ordered behavior** is a numbered list, each step starting with a bold verb:
   "1. **Stop `apply`** if it is still running."
5. **End** where the content ends. No summary, no "next steps" list.

## Sentences

- Say each fact once, in the section where a reader looks for it. Link to it
  from elsewhere instead of repeating it.
- Prefer a table to a paragraph when facts share a shape: options, fields,
  rules, cases and outcomes, question and answer.
- Short sentences, present tense, active voice. Address the reader as "you" only
  when telling them to do something.
- Use the words a reader types or sees: config fields, function names, log
  messages, error tags. Do not name internal modules, helper functions or
  implementation steps.
- Define a term in bold the first time a page uses it. Link to the page that
  owns a term instead of redefining it.
- State limits plainly next to the feature they limit. Do not stack warnings or
  hedge. Use an admonition (`:::note`, `:::caution`) only for something a reader
  would otherwise get wrong, at most one or two per page.

## Code

- The smallest example that works. Never add type annotations a reader would not
  write.
- One example per idea. Vary only what the section is about.
- YAML and TypeScript show the same thing the same way across pages.
- Examples follow the project's own rules: no `Date.now()`, `process.env`,
  `setTimeout` or global `fetch` inside Effect code, unless the example shows
  what not to do.

### Checked examples

Every `ts` block is a complete module that compiles, with its imports. The docs
tests typecheck each block with the repository's settings and Effect
diagnostics, and run the doctests with
[`@effect/doctest`](https://www.npmjs.com/package/@effect/doctest).

| Block                                       | Fence                                       | Checked by                    |
| ------------------------------------------- | ------------------------------------------- | ----------------------------- |
| Runs in a test process                      | ` ```ts import.meta.vitest name="page: …" ` | Typecheck, then run as a test |
| Starts a process, opens a port, reads files | ` ```ts `                                   | Typecheck                     |
| A module that later blocks import           | ` ```ts title="clock.ts" `                  | Typecheck; doctests import it |
| Code that shows what not to do              | ` ```ts skip `                              | Nothing                       |

- A doctest asserts the outcome the section is about with a trailing
  `// => value` comment. Add no run code that the section does not need.
- To build on an earlier block, give it `title="name.ts"`, export what later
  blocks use, and import it with `import { Clock } from "./clock.ts"`. Titles
  are unique within a page.
- In a typecheck-only block, a dependency the example does not care about is a
  `declare const`. A doctest defines a small fake instead.
- The Chinese pages carry the English code blocks unchanged.
  `node snippets.mjs sync <page.md>` copies them;
  `node snippets.mjs check <page.md>` typechecks one page, and
  `pnpm vitest run content/docs/<page.md>` runs its doctests, all from
  `packages/docs`.

## Accuracy

- Every behavior, default, field, flag and error name matches the code. Check
  the source and tests, not the previous version of the page.
- When code changes behavior, update the page in the same change.

## Languages

- English, Simplified Chinese (`zh-cn/`) and Traditional Chinese (`zh-tw/`)
  carry the same structure and the same facts.
- Chinese is written for Chinese readers, not translated word for word. Keep
  each locale's established terms; for example, zh-TW
  uses 外掛, 行程, 憑證, 設定檔.
- The generated API reference is English only.

## Checks

- `pnpm --filter @graftland/docs build` checks every local link and anchor.
- `pnpm --filter @graftland/docs test` typechecks every code block, checks that
  the Chinese pages carry the same blocks, and runs the doctests; it and
  `treefmt --fail-on-change` pass.
