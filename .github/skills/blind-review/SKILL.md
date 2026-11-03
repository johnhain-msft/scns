---
name: blind-review
description: Commission an independent blind-first review without leaking the producer's framing. Use whenever a producer asks another agent to review its own artifact, claims, fix, benchmark, or verdict.
---

# Blind Review Commissioning

The caller is a dispatcher, not the prompt author. Pass one is generated from frozen pointers only.
`HARNESS_ROOT` must point to the root of your local SCNS repository checkout; set it explicitly when
running elsewhere:

```bash
HARNESS_ROOT="${HARNESS_ROOT:-$(git rev-parse --show-toplevel)}"
```

## 1. Freeze the request

Create a JSON request containing exactly:

```json
{
  "version": "BLIND_REVIEW_V1",
  "artifact": {
    "path": "/absolute/path/to/artifact",
    "section": "section identifier",
    "sha256": "64-character hash"
  },
  "acceptance": {
    "path": "/absolute/path/to/acceptance-source",
    "section": "criterion identifier",
    "sha256": "64-character hash"
  },
  "repository": {
    "path": "/absolute/path/to/repository",
    "revision": "full 40-character commit hash"
  }
}
```

There is deliberately no field for findings, fixes, summaries, suspected defects, or review items.
Do not add one.

## 2. Generate, never hand-author

Run:

```bash
(cd "$HARNESS_ROOT" && npx tsx scripts/blind-review-prompt.ts \
  --request "$REQUEST_JSON" \
  --output "$PROMPT_TXT" \
  --manifest "$PROMPT_MANIFEST")
```

The generator verifies both file hashes, rejects unknown fields, audits the blind prompt for framing,
and records its SHA-256. If it fails, stop. Do not recreate the prompt manually.

## 3. Dispatch the exact bytes

Read `$PROMPT_TXT` and pass its complete contents unchanged as the `prompt` argument to one fresh
`task` invocation. Use the `blind-review` custom agent when available; otherwise use
`general-purpose`. Give the task a unique `name` and save the returned verdict to a file.

Do not prepend or append context. In particular, do not mention prior review rounds, what was
allegedly fixed, what the producer expects, or what to inspect.

## 4. Prove what was dispatched

Extract the actual top-level task argument from the current session's raw `events.jsonl`:

```bash
(cd "$HARNESS_ROOT" && npx tsx scripts/blind-review-dispatch-proof.ts \
  --events "$SESSION_FOLDER/events.jsonl" \
  --reviewer "$TASK_NAME" \
  --expected-prompt "$PROMPT_TXT" \
  --expected-sha256 "$PROMPT_SHA256" \
  --output "$DISPATCH_PROOF" \
  --captured-prompt "$CAPTURED_PROMPT")
```

The review is invalid unless `exactMatch` is `true` and `framingLeaks` is empty. Report a mismatch or
leak honestly; never substitute the intended prompt for the dispatched prompt.

## 5. Follow-up only after blind verdict

If prior findings must be checked, create a new request with version
`BLIND_REVIEW_FOLLOWUP_V1` and one additional field:

```json
"blindVerdict": {
  "path": "/absolute/path/to/completed-blind-verdict",
  "sha256": "64-character hash"
}
```

The generator rejects follow-up mode without that completed verdict and rejects `blindVerdict` in
the first pass. Dispatch and prove the second prompt separately.

## 6. Retracted acceptance items

Freeze the acceptance list when the PR opens. An acceptance source is often an audit rather than a
work order, and scoring every bullet in it as pass/fail is how a PR fails for requirements nobody
still wants. Decide up front which items are in scope.

When an item is genuinely withdrawn by its own author, say so — in follow-up mode only:

```json
"retracted": [
  {
    "item": "Suggested work item 5",
    "authority": "https://github.com/owner/repo/issues/54#issuecomment-5657656379"
  }
]
```

Without this the reviewer scores the frozen acceptance source verbatim, so a withdrawn item keeps
failing the artifact on every pass, forever. That is what happened to issue #54's item 5 on PR #56:
misdiagnosed, withdrawn, and still marked unmet on two consecutive reviews.

This is the only field the producer controls, so it is deliberately narrow and the generator
enforces it:

- follow-up only — pass one stays fully blind, and `retracted` in a `BLIND_REVIEW_V1` request is
  rejected as an unknown field;
- `item` is a single-line identifier of at most 80 characters — name the item, do not argue it;
- `authority` must be an `http(s)` URL to the decision that withdrew it. There is no field for a
  reason, and there must not be one: the reviewer follows the link and judges for itself;
- the framing audit now runs over the generated follow-up prompt as well as the blind one.

Do not use this to remove an item you merely disagree with. Withdraw it at the source first, then
cite that.
