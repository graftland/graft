---
name: collaborate-with-claude-5
description: >-
  Use when you work with an Anthropic Claude 5 model (Opus 5.5, Sonnet 5.5,
  Fable 5.1, Haiku 5.5) as a worker or reviewer: choosing the member, deciding
  what to give it, briefing it and checking what it returns. Applies through any
  harness, including when you are a Claude model yourself; to run it through
  Claude Code CLI, also load `claude-code`.
---

# Collaborate with Claude 5

Claude reconstructs mechanisms, builds rehearsals and checks implementations in
detail. Opus and Sonnet also compare alternative readings of requirements.
Separate the choice of interpretation from the proof that its implementation
works; review each before the action that depends on it.

## Decision habits

**Opus explains alternatives while retaining its chosen reading.** It calculates
how other readings change the result and supplies them in the hand-off. Move
that comparison before the dependent commitment, and settle the reading from the
governing source rather than the detail of its explanation.

**Sonnet extends verification after the main implementation works.** Give it an
acceptance condition and a budget. Request further checks when they address a
specific failure mode; put additional polishing in the hand-off.

**Planned changes and exploratory probes receive different treatment.** Formal
changes get rehearsal; probes described as harmless have changed live state.
Specify the experimental boundary and inspect actual dependencies. Empty
payloads, staging labels and predicted rejection do not establish isolation.

## Pick the member

- **Opus 5.5**: use for reconstructing mechanisms and comparing interpretations.
  Ask for the source that decides between its competing readings before acting.
- **Sonnet 5.5**: use for faithful reproduction, staging and separate numerical
  implementations. Check which premises those implementations share.
- **Fable 5.1**: use for bounded technical investigation with observable
  results. Reconcile the hand-off with complete test output and production logs;
  its summaries have omitted failed checks and side effects.
- **Haiku 5.5**: use for checkable execution and explicit predictions. It checks
  its testing tools and reports incidents concretely. Review classifications
  against their governing definitions separately from arithmetic.
- For interpretation review, give another reviewer the original evidence and
  request a fresh derivation before showing Claude's account.

## Brief it

- "For each consequential reading, give the governing sentence, the alternative
  reading and the effect on the result. Resolve the choice before acting."
- "Separate implementation checks from interpretation checks. Name the premises
  shared by the main implementation and each independent check."
- "Experiments belong in this isolated environment; authorized live work has
  this scope. Verify actual dependencies before using the environment."
- "Stop when this acceptance condition is met. Report further work separately."
- With an external deadline: "Check the other party's state at these milestones;
  keep rehearsal within this budget."
- "End with decisions, contrary observations, complete test results and side
  effects, including effects of exploratory actions."

## Check what comes back

- Compare its selected reading with the governing source. A sensitivity
  calculation establishes consequences, not which premise governs the task.
- Check whether the verification exercises the premise being disputed, rather
  than repeating that premise in separately written code.
- For shared systems, inspect probe and rehearsal effects alongside the planned
  change. Check actual connections and targeted process IDs.
- For Sonnet, inspect changes of decision inside long tool runs. For Fable,
  reconcile the last complete test outputs and omitted suites with the summary.
- For Haiku, compare predictions with outcomes and re-derive consequential
  classifications from their definitions.
