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

## Before modifying code

- Inspect the relevant existing implementation first.
- Identify dependencies and affected workflows.
- If requirements are ambiguous in a way that could affect the architecture,
  ask before implementing.

## Verification

After making changes:
- inspect the git diff
- run the relevant tests/validation
- identify any remaining uncertainty
- do not claim something was tested if it was not actually tested

## Scope

Do not expand the task beyond the requested feature.
