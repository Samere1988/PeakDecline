# Verified Live TV guide assignments

A channel brand is not enough to identify a regional schedule. In particular,
`HBO`, `HBO HD`, and an HBO logo can refer to several unrelated feeds. Having
more programme rows does not make one candidate a better match.

The refresh and local remap tools now prefer exact playlist `tvg-id` values,
including case-insensitive matches. A missing identifier cannot fall back to a
similarly named channel in another region. Ambiguous normalized names are left
alone. Existing unrelated assignments remain intact.

Operator-verified assignments live in `guide.db`'s `mapping_overrides` table,
with the expected channel name, guide ID, reason, and timestamp. Both tools
apply them after automatic matching. An unavailable guide source does not
replace a verified assignment with a different feed. A null guide ID blocks an
unverified assignment. If a channel ID is reused with a different name, the old
override does not apply.

To assign a verified guide, run from the website checkout:

```bash
.venv/bin/python remap_guide_channels.py --channel-id 2823 --guide-id HBO.us --reason 'Observed programme matches this guide'
```

To keep a channel unmapped until its regional guide is identified:

```bash
.venv/bin/python remap_guide_channels.py --channel-id 11561 --block --reason 'Stream region unverified; available listings do not match playback'
```

A channel override limits automatic matching to that channel and saves a
consistent SQLite backup before changing anything. The guide API reads the
mapping on each request; deployment of these scripts and a mapping update do
not require a website or encoder restart. The browser refreshes its guide
approximately once a minute.

## HBO investigation, October 22, 2026

- HBO HD (2823) was assigned to numeric guide 369809, which showed *Playing with
  Fire* from 15:20 to 17:00 America/Toronto. The user observed *Evil Dead Burn*.
- The already-downloaded `HBO.us` guide lists *Evil Dead Burn* from 16:03 to
  17:56 America/Toronto, matching that observation. This is the verified override.
- HBO (11561), observed showing *Twisters*, has playlist identifier `hbo.ca`.
  The available `HBO1.ca` and `HBO2.ca` schedules do not match that programme;
  neither is a verified replacement. This channel remains unmapped.
- Both saved stream URLs stay on their original provider host with no redirect.
  Standard provider XMLTV, playlist, and programme API endpoints returned a
  default web page instead of guide data. HBO's transport metadata reports
  generic `Service01` / `FFmpeg`, with no regional identification.
- Resolving the second channel requires its actual provider XMLTV feed or
  identification of the regional schedule. The on-screen HBO logo establishes
  the brand but does not identify the regional feed.

## Validation

Run isolated regression tests without accessing live streams or databases:

```bash
.venv/bin/python tests/live_tv/guide_mapping_test.py
```

Coverage includes ambiguous names with unequal programme counts, missing and
case-insensitive identifiers, override persistence through refresh/remap,
missing feeds, explicit blocks, ID reuse, targeted changes, backup consistency,
invalid override rejection, and the live lookup function's returned title.
