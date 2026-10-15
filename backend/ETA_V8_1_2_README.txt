RiskNav ETA V8.1 — Partial City Coverage Resilience

Why this release exists
-----------------------
The latest V8 log exposed an all-or-nothing failure mode:
Taipei and Taoyuan could be usable, while NewTaipei/HsinchuCounty were rejected
or slow, but the outer 7-second batch timeout discarded the entire city package
set. The result was cityMatchedDistanceKm = 0 even though some city providers
were healthy.

V8.1 fixes the source-resolution architecture before adding any inferred
uncovered-road prior.

Behavior
--------
- Every jurisdiction is isolated.
- Shape + Live are required for that jurisdiction only.
- SectionLink remains optional.
- A slow/rejected jurisdiction returns null for itself, not for all cities.
- Per-scope timeout is 5.5 s; it is network resilience only, never an ETA factor.
- Existing V8 canonical Freeway/Highway geometry is untouched.
- Existing strict direction, freshness and extreme-value guards are untouched.

Expected diagnostic
-------------------
[TDX city partial coverage] {
  requestedScopes: [...],
  usableScopes: ['Taipei', 'Taoyuan', ...],
  packageCount: ...,
  diagnostics: [...]
}

For the Taipei -> Hsinchu route, NewTaipei/HsinchuCounty may still be genuinely
unsupported by Live/City. That is okay. The important change is that Taipei and
Taoyuan traffic must no longer disappear just because another scope fails.

Next stage
----------
After live-source recovery, add a data-driven uncovered prior only to the road
pieces that still have no live evidence. This order prevents inferred priors
from replacing real city traffic that was merely being discarded by a batch
failure.

V8.1.2 installer compatibility fix
----------------------------------
The prior installer looked only for the exact string `dotenv.config();`.
The current project uses a multiline configuration such as `dotenv.config({ ... });`,
so that installer rolled server.js back before V8.1 was applied.
V8.1.2 inserts the import after the final static ESM import declaration instead.
It also replaces loadCityLivePackages by matching the actual JavaScript function
body rather than depending on the next function name.
