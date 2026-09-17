# Project Instructions

## Project

This is an offline-first PWA for celestial navigation.

The application must remain usable offline after required data has
been cached.

## Development principles

- Preserve existing behavior unless a task explicitly requires changing it.
- Do not refactor unrelated code.
- Do not introduce dependencies without discussing them first.
- Prefer the smallest coherent implementation.
- Follow existing architectural patterns unless there is a concrete reason
  to change them.
- Do not silently change calculation methodology.
- Do not remove existing functionality while implementing a feature.
- Prefer established web/PWA interaction patterns over novel UI conventions.

## Before modifying code

- Inspect the relevant existing implementation first.
- Identify dependencies and affected workflows.
- Identify potential regressions.
- If requirements are ambiguous in a way that could affect the architecture,
  ask before implementing.
- Do not expand the task beyond the requested feature.

## Verification

After making changes:

- inspect the git diff
- run the relevant tests/validation
- exercise the affected functionality when practical
- identify any remaining uncertainty
- do not claim something was tested if it was not actually tested

## Git

- Do not commit changes unless explicitly asked.
- Do not push changes unless explicitly asked.
- Do not alter branches or rewrite Git history without explicit approval.
- Keep working-tree changes limited to the current task.
