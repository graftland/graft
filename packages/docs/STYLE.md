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

- The smallest example that works. Leave out imports a reader already has, and
  never add type annotations a reader would not write.
- One example per idea. Vary only what the section is about.
- YAML and TypeScript show the same thing the same way across pages.

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
- `pnpm --filter @graftland/docs test` and `treefmt --fail-on-change` pass.
