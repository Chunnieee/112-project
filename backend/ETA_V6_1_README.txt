RiskNav ETA V6.1 — Extreme Evidence Guard

Why this patch exists
---------------------
V6 correctly added freshness and TravelTime quality checks, but the first live
run exposed a missing lower-bound evidence rule: fresh TravelTime-derived speeds
around 1.2–2.2 km/h were being treated as high-confidence merely because they
were fresh. A few short highway sections could therefore add tens of minutes each.

V6.1 does NOT clamp those speeds and does NOT invent a multiplier.
Instead, an extreme crawl (<5 km/h by default) must be corroborated by the
independently published TravelSpeed field:

- TravelTime <5 km/h + similarly low TravelSpeed -> keep TravelTime, medium confidence.
- TravelTime <5 km/h + materially higher valid TravelSpeed -> use TravelSpeed, medium confidence.
- TravelTime <5 km/h + no usable TravelSpeed -> exclude that observation from ETA.

The threshold is configurable with TDX_EXTREME_CRAWL_KMH.
The prior valid 11–17 km/h congestion observations are unaffected.
