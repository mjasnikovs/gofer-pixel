# AIGEN: the naming veto

**Done, 2026-08-08 — and the answer was no.** Built as `src/gen/veto.ts`, measured live over 8 cats
and 8 knights, and demoted to a label: the naming vetoed two real cats and all eight knights. The
numbers and the reason are in `docs/GEN_RESEARCH.md`. The brief below is kept for what it measured
first; do not execute it again.

A self-contained brief. Execute it in a fresh session. Read `docs/GEN_RESEARCH.md` and `CLAUDE.md`
first; do not re-run anything the research doc marks dead.

## Goal

After candidates land in the generate dialog, reject the ones the vision model cannot name as the
subject. A blob costs a grid slot and CLIP cannot catch it — it ranks, it does not judge. The veto
judges.

## What is already measured — build on it, do not re-derive it

- The one phrasing that works: **one** 224px render, the 45° yaw, temp 0, and the exact question
  `This is a voxel model. What does it depict? Answer with one or two words.` It answered
  "cat"/"dog" for good cats, "robot" for a blob, "lever" for a broken ship.
- Dead: yes/no questions that name the subject ("Is this recognisable as X?") — yes for garbage, the
  framing decides. Dead: any question over a four-view strip — no for everything.
- The naming is honest but loose: a good cat once came back "sheep". The open problem is the
  **match**, not the naming.

## Build

1. `src/gen/veto.ts`, a port like `llama.ts`: `browserVeto` talks to the server, `memoryVeto`
   returns canned words for `bun test`. One function: candidate volume in, `{word, pass}` out.
2. The match, in order of preference — measure before choosing:
    - exact/substring match against the prompt's nouns (cheap, strict — "sheep" for "a cat" fails);
    - one text-only call: `Could "<word>" describe <prompt>? Answer yes or no.` Text-only yes/no was
      NOT part of the measured sycophancy — that finding was about images — but verify it on the
      recorded cases before trusting it: cat/sheep should pass, cat/robot must fail.
3. Wire into `GenerateDialog` after attempts land: a vetoed candidate stays visible but marked and
   sorted last, never silently dropped — the artist may disagree with the judge.
4. Tests: no waiting, no live server. The seam is the port; the naming word is canned.

## Verify live, then record

Generate 8 cats and 8 knights against the live server. Count: how many passed, how many of the
passes your eyes agree with, how many vetoes were wrong. Append the numbers and the date to
`docs/GEN_RESEARCH.md`. If the match strategy loses more good candidates than it saves bad ones, say
so there and stop — a veto that vetoes cats is worse than no veto.

## Done means

`bun run check` green; the dialog shows the veto word per candidate; the live numbers are in
`docs/GEN_RESEARCH.md`; anything surprising is written there, not left in the session.
