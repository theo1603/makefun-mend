# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/theo1603/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/theo1603/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit an AI model wrote to a tree of text files, in any of the
four formats models use: unified diffs (even with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON.
It finds the lines each edit names at the first of three matching tiers
(exact, trailing whitespace off, both sides trimmed), re-indents tier-2
replacements to the file's own indentation, and writes every change or none:
a failed edit changes nothing, the edits after it still run, and every
failure is reported. `main.ts` is Node 22, standard library alone, and
`SPEC.md` is the whole contract it implements.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file, or `-` (or nothing) to read it from standard
input. `--format` names one format (`unified`, `search-replace`, `v4a`,
`json`); `auto` (the default) detects it. `--check` does everything but
write, `--strict` matches lines exactly. Exit 0 prints what changed
(`A`/`D`/`M`/`R` lines, then `ok: <n> files`); exit 1 lists the edits
that failed and why; exit 2 is a usage, patch-read, format or parse error.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
