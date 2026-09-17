# Passage Data Model — Design Analysis

Status: **design only, no implementation yet**. This document exists to be argued
with before anything gets built.

---

## 1. What the current code actually does today

Before modeling anything new, here's what's really in the repo right now —
not what the code implies or was designed toward, but what it does.

### 1.1 Sight (`js/storage.js`, shape defined in `js/app.js`)

- **Has a stable id.** `SightStorage.save()` assigns `sight_<timestamp>_<random>`
  if none exists. Sight is fully Passage-ready on the ID front.
- **Full record shape** (from `collectFormState()`):
  ```
  {
    id, schemaVersion, notes, date,
    body: { type, name, limb },
    position: { latDeg, latMin, latNS, lonDeg, lonMin, lonEW, tzOffset },
    observations: [{ h, m, s, heightDeg, heightMin }, ...],
    corrections: { ieMin, ieSign, dipMin, altCorrMin, altCorrSign,
                   addAltCorrMin, addAltCorrSign, clockErrorSec, clockErrorDirection },
    almanac: { star: {...} } or { nonStar: {...} },
    title,                      // added only at save time, not by collectFormState
    results: {                  // added only if a reduction has actually run
      interpolatedGha, interpolatedDec, lha, hc, zn,
      interceptNM, interceptDirection, ho,
      observationTime            // ISO UTC string -- see 1.4 below
    }
  }
  ```
- **`position` is an Assumed Position, not a result.** It's an input to the
  LOP calculation (`reduceSight`), entered by the navigator — today always
  typed in by hand. Nothing currently populates it *from* a DR Leg or a Fix,
  even though conceptually that's exactly where it should come from.
- **A Sight's "time" is derived, not stored as one field.** The raw
  observation clock times live per-observation-line (`observations[].h/m/s`,
  local watch time). The single instant the Sight *means* — clock-error
  corrected, averaged across lines, converted to UTC — only exists as
  `results.observationTime`, and only after a reduction has actually been
  computed and cached. If a sight is saved before its reduction runs (or the
  reduction fails), there is no time to hand a Fix or a Passage.
- **A Sight does not know which Fix (if any) it belongs to.** That
  relationship is owned entirely by Fix (below), one-directionally.

### 1.2 Fix (`js/fixStorage.js`, logic in `js/fixes.js`)

- **Has a stable id** (`fix_<timestamp>_<random>`). Also Passage-ready on the
  ID front.
- **Persisted record shape is deliberately thin:**
  ```
  {
    id, name, savedAt,
    sightingIds: [sightId, ...],       // references, not copies
    activeSightingIds: [sightId, ...]  // subset toggled on/off for plotting
  }
  ```
- **The resolved position is *not* persisted.** This is the single most
  important finding in this whole review. `FixStorage` never stores lat/lon.
  Every time a Fix is opened, `fixes.js` re-loads all its Sights, re-derives
  each one's LOP, and calls `SightCalc.computeMultiLopGeometry` →
  `resolveMultiLopFix` live, in-memory, from scratch. The position you see on
  screen is *recomputed on every view*, never cached.
- **This already correctly supports Sights from different APs.**
  `computeMultiLopGeometry` reads each Sight's *own* `lat`/`lon` (not one
  shared AP), averages them only to pick a flat-earth plotting origin, and
  places each LOP relative to that origin using its own AP. So today, if you
  hand-typed a different Assumed Position for Sight A (10:00) than for Sight
  B (11:00), and Sight A's AP already accounted for the DR run between them,
  the existing least-squares/bisector math resolves a correct running fix —
  **by accident of generality**, not because anything explicitly advances an
  LOP. See §6 for why this matters a great deal for Running Fix.
- **A Fix has no explicit time either.** Convention would be "the time of the
  latest constituent Sight," but nothing encodes that today.

### 1.3 DR Leg (`js/drleg.js`, `js/drlegStorage.js`)

- **Has no id at all.** This is the real gap. `DrLegStorage` only exposes
  `saveForm()`/`loadForm()` — a single remembered form, the same pattern as
  Planning's persisted inputs. There is no `uid()`, no list, no way to
  address "leg #3 from last Tuesday." Today's DR Leg is a *calculator*, not
  a *record type*, and it is the only one of the three that isn't already
  Passage-addressable.
- **Its math is pure and already reusable** (`SightCalc.drPosition`,
  `computeDrLeg`, `localDateTimeToUtcMs`/`utcMsToLocalDateTime` in
  `calc.js`) — that part needs no rework, only a persistence wrapper around
  it.
- **Output already resembles a typed Position** (see §3): `{ latDeg, lonDeg,
  dateStr, secOfDay, tzOffset }` is assembled ad hoc in `window._lastDrResult`
  and in the two handoff builders, but it's a one-off shape invented in
  `drleg.js`, not a shared type anything else recognizes.

### 1.4 The two live handoff mechanisms (`sessionStorage`, one-shot)

- `ocsrApHandoff` — DR Leg → New Sighting, and originally Planning → New
  Sighting. Shape: `{ date, tzOffset, latDeg, latMin, latNS, lonDeg, lonMin,
  lonEW }`. No time-of-day, no provenance, no source id.
- `ocsrPlanningApHandoff` — DR Leg → Planning. Same shape.
- Both are **write-once, consume-once, structurally identical position
  packets** with no memory of where they came from. They already are, in
  effect, an ad hoc `Position` object, just not named or typed as one, and
  not carrying enough information (no time-of-day, no provenance) to fully
  satisfy §3's principle.

### 1.5 Summary table

| Entity  | Stable id today? | Persisted as a list? | Position stored? | Time stored? |
|---|---|---|---|---|
| Sight   | Yes (`sight_...`) | Yes (`SightStorage`) | Yes (as AP input) | Derived only, cached post-reduction |
| Fix     | Yes (`fix_...`)   | Yes (`FixStorage`)   | **No — recomputed live** | **No** |
| DR Leg  | **No**            | **No — single form only** | Yes (start + computed end) | Yes (start + computed end) |

That table is the headline: **Sight and Fix are Passage-ready on identity;
DR Leg is not. Fix is the odd one out on position, storing none at all.**
Any Passage work has to close both gaps before it can do anything else
useful.

---

## 2. Current data relationships (as they exist today)

```
Sight (has id, has AP typed in by hand, has observations[])
  │
  │ produces (in-memory only, via reduceSight)
  ▼
LOP  (zn, interceptNM, azimuthUnit, interceptPoint -- never persisted on its own;
      recomputed from the Sight's stored fields every time it's needed)
  │
  │ referenced by id, many-to-many
  ▼
Fix (has id, has sightingIds[], NO stored position, NO stored time)


DR Leg (NO id, single form, not a list)
  │
  │ produces (in-memory only)
  ▼
DR Position  (ad hoc {latDeg, lonDeg, dateStr, secOfDay, tzOffset})
  │
  │ sessionStorage one-shot handoff, no id, no provenance
  ▼
New Sighting's AP   or   Planning's AP
```

Nothing currently connects the DR Leg branch to the Sight/Fix branch except
that one-shot, provenance-free handoff. There is no object today that a
Passage could hang a chronology off of — every "position" in the app is
either a raw form input or a value recomputed on demand and thrown away.

---

## 3. The Position principle, applied to what already exists

The document's guiding principle —

> A navigational position should always be associated with a time, and
> should carry a provenance.

— turns out to already be *implicit* in three different places in the
codebase, each incomplete in a different way:

| Where | Has lat/lon? | Has time? | Has provenance? |
|---|---|---|---|
| Sight's `position` (AP) | Yes | No (lives on the Sight, not the position) | No |
| Fix's resolved point | Yes (in memory only) | No | No |
| DR Leg's result | Yes | Yes (`dateStr` + `secOfDay`) | Implicit (it's a DR result) but not encoded |
| The two handoff packets | Yes | **No** (date only, no time-of-day) | No |

So adopting a real `Position { time, lat, lon, type }` isn't inventing a
new concept — it's naming and completing one that already exists in three
incompatible partial forms, and it immediately exposes a real bug-in-waiting:
**the existing handoffs drop time-of-day.** A DR Leg computed to arrive at
06:47 local currently hands New Sighting only a *date*; the actual arrival
time is lost. That's worth fixing regardless of anything else in this
document (see §9).

Recommended shape:

```js
Position {
  time: <ISO UTC string>,   // always UTC internally; format for display at the edges
  lat: <signed decimal degrees>,
  lon: <signed decimal degrees>,
  type: 'KNOWN' | 'FIX' | 'DR'
}
```

`type` matters beyond labeling — it tells a consumer how much to trust the
position. A DR position accumulates error the longer it's been since the
last fix; a KNOWN position (GPS, a charted mark, a pilotage landmark) is
exact until proven otherwise. Passage will eventually want to *show* that
distinction (e.g. a DR track drawn differently from a fix track), so it's
worth carrying from day one rather than bolting on later.

---

## 4. Domain model

### Position
The one shared value type everything else produces or consumes. Not a
top-level persisted entity with its own id — it has no independent
existence; it's always *someone's* position (a Fix's, a DR Leg's endpoint, a
Sight's AP). See §5 for how references work.

### DR Leg
```
DrLeg {
  id,
  startPosition: Position (type usually 'FIX' or 'DR' or 'KNOWN'),
  sog, courseDegTrue,
  durationHours,            // authoritative once solved; see below
  endPosition: Position (type: 'DR'),
  passageId                 // which Passage this belongs to, if any
}
```
**Authoritative vs. derived:** the user enters *either* duration or an end
time; `computeDrLeg()` (already in `calc.js`) solves for the other. Once
solved, store *both* — recomputing a real-world duration/time round-trip on
every read is pure waste, and the numbers are cheap to keep in sync since
they're never edited independently after the fact (a DR Leg, once logged, is
a historical record of what was assumed at the time — see §8's "immutable
history" question). `startPosition` should be a *reference* where the start
came from an existing Fix/DR Leg endpoint (see §6), and an embedded literal
`Position` only when manually keyed in as a passage's starting point.

### Sight
Unchanged in substance from today's shape (§1.1), with two additions:
- `fixId` is **not** added here — ownership stays on Fix, one-directional,
  matching today's design (a Sight doesn't need to know; a Fix does).
- `assumedPosition` should conceptually be a `Position` (type `'DR'` if it
  came from a DR Leg, `'FIX'` if carried from a prior Fix, `'KNOWN'` if
  hand-entered) rather than a bare deg/min/hemisphere group with no
  provenance. This is the same gap identified in §3.

### LOP
Never a persisted entity, today or in this proposal. It's a pure function of
a Sight's stored fields (`reduceSight` → `zn`, `interceptNM`, and the
flat-earth geometry helpers). Keeping it derived-only is correct and should
stay that way — persisting it would be exactly the "premature duplication"
§14 warns against, since it's fully reconstructible from the Sight at any
time.

### Fix
```
Fix {
  id, name, savedAt,
  sightingIds: [...],          // unchanged
  activeSightingIds: [...],    // unchanged
  resolvedPosition: Position | null,   // NEW -- see below
  passageId
}
```
**The one real schema change to an existing entity this document
recommends:** cache `resolvedPosition` (type `'FIX'`, time = the time of the
latest constituent Sight) the moment a Fix successfully resolves, instead of
recomputing it live on every view and never persisting it. This isn't
optional for Passage — a Passage needs to list "Fix @ 18:50, 31°57'N
63°17'W" without reloading and re-solving every Sight just to render a
timeline. It also isn't a duplication concern: the position is *derived*
data being *cached*, not a second independent copy someone could edit out of
sync — recompute-and-compare-on-save is cheap insurance if that's ever a
worry.

### Running Fix
**Not a persisted entity — a calculation workflow**, exactly as §12
argues, and the existing Fix-resolution code makes the reasoning concrete
rather than just architecturally tidy: §1.2 showed that `resolveMultiLopFix`
already happily combines LOPs from different APs, correctly, as long as each
LOP's AP is already where the navigator actually was (or is treated as being)
at that LOP's own time. A running fix is exactly that scenario. So "running
fix" doesn't need new intersection math — it needs one new step *before* the
existing math: advance the earlier Sight's AP forward by a DR Leg, producing
a new position, and feed that (not the original Sight) into the same
multi-LOP resolution that already exists.

Concretely, as a workflow, not a stored object:
```
RunningFixResult = resolve({
  advancedLop: {
     sourceSightId,                       // reference, not a copy
     drLegId,                             // the movement used to advance it
     advancedZn: <same as source, LOPs don't rotate>,
     advancedInterceptPoint: <source's intercept point, translated by the DR Leg's vector>
  },
  laterSightId
})
```
The output is an ordinary `Fix` (§ above) whose `sightingIds` still just
lists the two real Sights — the "advancement" is a computation performed at
resolve time, not a new kind of stored LOP. If a UI wants to show "this fix
used a running-fix advancement, driven by DR Leg X," that's a `drLegId`
attached to the `Fix` record as *provenance metadata*, not a new entity type.
This keeps the persisted schema small: Running Fix leaves exactly one trace
in storage — a `Fix` with an extra `advancedFromLegId` field — and the
interesting math stays exactly where `resolveMultiLopFix` already lives.

### Passage
```
Passage {
  id, name, notes,
  startedAt, endedAt,             // derived from the timeline's extent; cache, don't hand-maintain
  timelineIds: [
    { type: 'position', id: ... },   // a manually-logged KNOWN position (start, or a mid-passage fix like GPS)
    { type: 'drleg',    id: ... },
    { type: 'sight',    id: ... },   // only once it's contributed to a fix, typically
    { type: 'fix',      id: ... },
    ...
  ]
}
```
Passage **references, it does not own or duplicate.** Every entry in
`timelineIds` points at an existing, independently-stable-id'd record
(`DrLeg`, `Sight`, `Fix`, or a lightweight logged `Position`). Passage's own
job is purely to be the *ordering* — the story of which happened when —
answering exactly the reconstruction question in §23 of the prompt. This is
why §1's finding that DR Leg has no id is the actual blocking issue: you
cannot put an un-id'd thing in a reference list.

---

## 5. Relationships, made explicit

| From | To | Reference or embed? | Why |
|---|---|---|---|
| Passage | DrLeg / Sight / Fix / logged Position | **id reference**, ordered list | Passage is a timeline over existing entities; duplicating their contents would immediately desync |
| Fix | Sight | **id reference** (existing `sightingIds`) | Unchanged — already correct today |
| Fix | resolvedPosition | **embedded** `Position` | It's *of* this Fix, has no independent existence, and is cheap/safe to cache (derived, not authoritative) |
| DrLeg | startPosition | **id reference** *when* it came from a prior Fix/DrLeg endpoint; **embedded** `Position` when manually keyed as a passage's origin | Avoids duplicating a Fix's position while still allowing a passage to simply *start* somewhere |
| DrLeg | endPosition | **embedded** `Position` | It's the DR Leg's own output, not borrowed from elsewhere |
| Sight | assumedPosition | **embedded** `Position`, tagged with provenance | Matches today's behavior (it's a typed-in input) but gains a `type` and, when it *did* come from a DrLeg/Fix, a `sourceId` alongside the embedded value — embedded because a Sight needs its AP to remain meaningful even if the source DR Leg or Fix is later edited/deleted, but the `sourceId` preserves the "why" |
| RunningFix | source Sight, later Sight, DrLeg | **id references**, live only inside the resolve() call and as `advancedFromLegId` provenance on the resulting Fix | Not a persisted entity of its own — see §4 |

General rule applied throughout: **reference when the target has its own
stable identity and lifecycle (DrLeg, Sight, Fix, Passage); embed when the
value is intrinsically part of the containing record and has no meaning on
its own (a resolved position, a DR Leg's endpoint).**

---

## 6. Answering the eight questions directly

**Q1 — What belongs to a Passage?**
References to `Position` (manually logged, e.g. a starting point or a GPS
fix mid-passage), `DrLeg`, `Sight` (once meaningfully part of the
chronology — a sight that never got reduced or saved isn't part of the
story yet), and `Fix`. Not Planning events — Planning is a *tool* Passage
calls out to (§8), not a timeline member; its output (a future DR position
at a celestial event) becomes the input to a *new* DR Leg or Sight, which
*does* join the timeline.

**Q2 — What is the authoritative source of a position?**
All three (Fix, DR Leg, Planning's projection) are legitimately the *same*
conceptual `Position` type, distinguished only by `type`. There should be
exactly one shape, not three. Authority varies by type: a `'FIX'` position
is authoritative for its own time (best current estimate); a `'DR'` position
is explicitly provisional/derived and should visually/semantically read as
lower-confidence the longer it's been projected forward without a new fix.

**Q3 — How should DR Legs connect to Fixes?**
`Position → DrLeg → Position`, not `Fix → DrLeg → Fix`, per the prompt's own
instinct — a DR Leg's start doesn't have to be a Fix (it could be a manually
logged known position, or another DR Leg's end with no fix in between, e.g.
dead-reckoning through a stretch with no sights taken). Making `Fix` the
required bookend would break the chain the moment a passage has a gap
between fixes.

**Q4 — How should Running Fix be represented?**
A calculation workflow, not a persisted object — full reasoning in §4. Its
only storage footprint is provenance metadata (`advancedFromLegId`) on the
`Fix` it eventually produces.

**Q5 — How do existing Sight/Fix records associate with a Passage?**
By id, added to `Passage.timelineIds` — no changes needed to Sight's or
Fix's own schema for this (Fix already references Sights the same way).
Existing saved Sights/Fixes from before Passage existed are valid and
importable: assigning them to a Passage is purely additive (append their id
to a timeline), never a migration of the records themselves.

**Q6 — How does a Passage begin?**
All of the listed options collapse to one mechanism: a Passage begins with
one logged `Position` of type `'KNOWN'` (hand-entered, imported, GPS, or
literally handed over from a prior Passage's last position/Fix — which is
just a `Position` reference either way). No special-casing needed per
source.

**Q7 — How does a Passage evolve; is it immutable or editable?**
Both, in the sense real logbooks are: entries, once logged, are historical
record (a DR Leg says "at the time, we assumed 6kt/090" — that shouldn't
silently change later just because you're re-examining old data), but the
Passage's *membership list* is editable (you can append new entries, or
correct a clearly-wrong entry with an explicit edit) without needing an
event-sourced/append-only log for v1. That's a reasonable place to draw the
line for now rather than over-building immutability machinery before there's
a concrete need for it.

**Q8 — How does Planning interact with Passage?**
Planning needs to *read* the Passage's current position (its latest
timeline entry) and the DR parameters in effect, to answer "where will I be
at the next event" — which is exactly the same `computeDrLeg` math DR Leg
already uses, just aimed at a computed event time instead of a manually
entered duration/end-time. The output is a `Position` (type `'DR'`) handed
to New Sighting exactly like today's handoff, just carrying real time-of-day
now (§3's bug) and, once Passage exists, also appended to the Passage's
timeline as an implicit DR Leg. No new mechanism required — Planning becomes
a specialized *caller* of the same DR Leg computation, not a parallel system.

---

## 7. What's derived vs. authoritative vs. cached, across the whole model

| Data | Classification |
|---|---|
| Sight's observation lines, corrections, almanac inputs | Authoritative (typed in) |
| Sight's `results` (Hc, Zn, intercept, etc.) | Derived, cached (already the pattern today) |
| Sight's `assumedPosition` | Authoritative as *input*, but its `type`/`sourceId` should say where the number came from |
| LOP (azimuth line, intercept point) | Derived, **never** persisted (already correct) |
| Fix's `sightingIds` | Authoritative (the navigator's choice of which sights to combine) |
| Fix's `resolvedPosition` | Derived, cached (**new** — currently neither derived-and-shown nor cached, just recomputed and discarded) |
| DR Leg's `startPosition` | Authoritative if manually entered; a reference if carried from a prior Fix/Leg |
| DR Leg's `endPosition`, solved duration/end-time | Derived from start + course/speed/time, cached once solved |
| Running Fix's advanced LOP | Derived, computed at resolve time, never persisted on its own |
| Passage's `startedAt`/`endedAt` | Derived from timeline extent, cache for display, never hand-edited |

---

## 8. Prerequisites this analysis surfaces (not yet built)

These are blocking issues for Passage specifically, independent of whether
Passage is built next or later:

1. **DR Leg needs to become a real saved-record type** — its own
   `uid()`, a `save()/list()/get()/remove()` API matching
   `SightStorage`/`FixStorage`'s existing shape, replacing (or sitting
   alongside) today's single-form persistence. This is the one true
   blocker: nothing can reference "a DR Leg" by id today.
2. **Fix should cache `resolvedPosition`** instead of only ever computing it
   live — needed for Passage to render a timeline without re-solving every
   Fix's Sights on every load, and generally overdue on its own merits.
3. **The two existing handoffs (`ocsrApHandoff`, `ocsrPlanningApHandoff`)
   are missing time-of-day** — worth fixing regardless of Passage, since
   it's a real, small, currently-shipping bug: a DR Leg's computed arrival
   time is silently dropped when handing off to New Sighting or Planning.
4. **`Position` as a named, shared shape** (`{time, lat, lon, type}`) should
   exist as one thing in `calc.js` (or a new small shared module) before
   DR Leg, Fix, and the handoffs all converge on using it — right now each
   of the three has its own slightly-different ad hoc shape for the same
   concept.

None of these require building Passage itself to justify doing them — each
is independently correct, and doing them first makes Passage additive
rather than a rearchitecture.

---

## 9. Explicitly out of scope for this document

No UI, no new storage backend, no schema version bump implemented, no
`PassageStorage.js` written. This is the model to react to before any of
that starts.
