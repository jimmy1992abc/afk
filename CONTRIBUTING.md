# Contributing

Thanks for helping improve this plugin. [`AGENTS.md`](AGENTS.md) is the canonical
guide; this is the short human version.

## Ground rules

- Comments and prose state only *why* — no background, examples, or cases.
- No personal, project, or non-public information in any file.
- English only.
- Secrets live in the environment, never in a committed file.

## Making a change

1. Open an issue describing the change, or comment on an existing one.
2. Branch off `main` (never commit to `main` directly); keep one topic per branch.
3. For anything non-trivial, add a design spec under `docs/designs/specs/`.
4. Write or update tests, then the code.
5. Run the local checks below until clean.
6. Open a PR using the template. Bump the plugin `version` if you changed
   `skills/` or a bundled script.

## Adding or editing a skill

See `AGENTS.md` → *Authoring or editing a skill*. In short: one directory under
`skills/` with a `SKILL.md`, `name` matching the directory and the `afk`/`afk-`
convention, bundled scripts invoked via the resolved plugin root, then
`node scripts/sync-marketplace.mjs` to refresh the manifests.

## Local checks

```bash
node scripts/sync-marketplace.mjs --check
node scripts/lint-skills.mjs
node scripts/check-links.mjs
node scripts/scan-provenance.mjs
node --test
```

## Review and merge

Every PR is reviewed by the owner/maintainer and passes one independent external
review before merge. PRs are squash-merged. CI must be green, but a green CI is
not by itself approval to merge.
