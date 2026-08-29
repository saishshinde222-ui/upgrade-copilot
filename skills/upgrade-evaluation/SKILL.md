# Evaluating a Dependency or API Upgrade

Use this skill whenever you are asked whether it is safe to bump a dependency
(or migrate to a new version of a third-party API) in one or more repositories.

## What counts as a breaking change

**Dependency (library/package) breaking changes:**
- A removed or renamed export, class, or function that a repo imports.
- A changed default value or default behavior for an existing option.
- A new or tightened peer-dependency requirement that conflicts with what a
  repo already has installed (e.g. requires React 18+ but the repo pins React 17).
- A change to the package's module format that breaks the consumer's import
  style (the canonical example: a CommonJS package going ESM-only, which
  breaks every `require(...)` call site even though `import` call sites are fine).
- A changed minimum supported runtime version (e.g. Node 18 → Node 20).

**Third-party API breaking changes:**
- A renamed, removed, or retyped field in a response payload that calling
  code destructures or maps over.
- A newly required request parameter, or a parameter whose valid values changed.
- An endpoint marked deprecated with a sunset date, even if it still works today.
- A changed authentication scheme (e.g. API key → OAuth) or changed rate limits
  that the existing retry/backoff logic doesn't account for.

Anything that doesn't fall into the above (bug fixes, new optional
parameters, new endpoints, additive fields) is a non-breaking upgrade.

## Changelog vs. migration guide

- A **changelog** tells you *what* changed. Read it first to scope the blast
  radius: does the target version's changelog (and every version in between,
  not just the target) mention removals, renames, or "BREAKING" entries?
- A **migration guide** tells you *how* to adapt calling code. Prefer it over
  the changelog whenever both exist — it usually gives the exact before/after
  code pattern, which is what you need to judge whether a specific repo's
  usage is affected.
- If a major version bump has no migration guide, treat that as a yellow
  flag, not a green light: read the full changelog for every intermediate
  major version, not just the target.

## Classification rubric — always use exactly one of these three

1. **safe to upgrade** — the sandbox install + build/test run succeeded with
   the new version, and nothing in the changelog/migration guide applies to
   this repo's actual usage.
2. **needs manual migration** — cite the exact file and line in the target
   repo that uses the changed surface, and the exact changelog/migration-guide
   entry that explains why it must change. Do not classify as "needs manual
   migration" without both citations.
3. **broken** — cite the exact failing command and the exact error/failure
   output from the sandbox run that demonstrates the break. A theoretical
   incompatibility you found in documentation, with no reproduction, is not
   enough to classify as "broken" — verify it first (see below), and if you
   can't verify it, classify as "needs manual migration" and say why you
   couldn't confirm it in the sandbox.

## The hard rule: verify in the sandbox, always

Never conclude "safe to upgrade" from documentation alone, no matter how
clean the changelog looks. Documentation can be incomplete, wrong, or not
cover a repo's specific (possibly unusual) usage pattern. Before classifying
anything as "safe":

1. Actually install the candidate version in the repo's sandbox.
2. Actually run the repo's existing build and test commands against it.
3. Only classify as "safe" if that run passes. If the repo has no build/test
   command to run, say so explicitly in your report — "safe" without any
   verification signal is not a valid conclusion; downgrade to "needs manual
   migration" and note that verification was not possible.

This rule has no exceptions for "obviously fine" patch releases — the cost
of running the check is low, and the cost of a silently wrong "safe" is a
production break in someone else's repo.
