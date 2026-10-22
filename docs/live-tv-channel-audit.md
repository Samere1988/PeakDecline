# Full playlist guide audit — October 22, 2026

The audit reviewed all 14,849 saved channel entries individually against the
cached XMLTV catalog, playlist identifiers, local station call signs, network
names, country/feed qualifiers, and existing verified overrides. It does not
claim to have watched or visually identified all 14,849 streams.

Eight short, sequential transport probes across US, Canadian, UK, and Mexican
entries all reported generic `Service01` / `FFmpeg` metadata. They supplied no
regional identity. The provider's guide endpoints had already returned default
HTML instead of XMLTV or programme API data.

## Matching decisions

- Match call signs together with the requested network and digital subchannel.
  Preserve West/Pacific, +1, language, and 4K event-feed distinctions.
- Use exact playlist IDs and explicitly documented aliases, retaining country
  qualifiers. A missing country-qualified ID cannot automatically justify a
  match in another country.
- Treat a unique brand name without an established region as a suggestion for
  review. Absence of another region in the catalog does not identify the stream.
- Leave unresolved contradictions, provider-specific event slots, 24/7 loops,
  and platform-specific channels unchanged. A Roku or Pluto channel name alone
  does not establish which platform's timing applies.
- Preserve existing operator overrides, including HBO HD, History Channel, and
  the unresolved HBO block. Store accepted matches as persistent overrides with
  the matching method recorded and an explicit note that evidence is metadata,
  not visual playback verification.

Country membership comes from the channel headers of the publisher's
[country XMLTV downloads](https://epg.pw/xmltv.html?lang=en). This is supporting
catalog evidence, not proof of the actual IPTV stream's origin. The retained
MSNBC-to-MS NOW alias is supported by the network owner's
[official SEC disclosure](https://www.sec.gov/Archives/edgar/data/2067876/000119312525306792/d894612dex991.htm).

## Results

- 2,812 previously unmapped entries receive a guide.
- 31 existing assignments switch to an identity-supported guide.
- 348 existing matches are confirmed and protected through refresh/remap.
- Mapping coverage increases from 957 to 3,769 entries.
- 11,080 entries remain unmapped; many are event slots, loops, or feeds whose
  region/platform schedule cannot be established from the available data.
- 718 additional name-based suggestions remain for review; some already have
  an older mapping, so this count overlaps the remaining categories.

A full rehearsal on an isolated database copy verified the exact change set,
retention of all existing mappings, integrity, and preservation of the prior
HBO/History overrides. All 25 guide/audit regression tests passed. No website
or encoder restart is required.

The private report, catalog evidence, original database/scripts, and rehearsal
are under `/home/samer/Documents/ChatGPT/migration/channel-audit-20261022-164201/`.
No stream URLs, credentials, channel databases, or per-user reports are committed.
The report's per-channel fingerprint detects a changed stream, name, identifier,
assignment, or override before a write. Application saves another consistent
SQLite backup and commits all guide changes in one transaction while holding
a read transaction on channel identities.

## Repeat the audit

Run from the production checkout, using output paths in a private directory:

```bash
.venv/bin/python audit_guide_channels.py --fetch-catalog /private/path/country-catalog.json
.venv/bin/python audit_guide_channels.py --catalog /private/path/country-catalog.json --output /private/path/audit.json
```

Inspect the generated report before applying its proposed assignments:

```bash
.venv/bin/python audit_guide_channels.py --apply /private/path/audit.json
```

Reports over 24 hours old or with changed channel evidence are rejected. The
refresh and remap tools preserve applied assignments via `mapping_overrides`.
A fresh audit is appropriate after a playlist replacement or new provider guide.

```bash
.venv/bin/python tests/live_tv/guide_mapping_test.py
.venv/bin/python tests/live_tv/guide_audit_test.py
```

## Live verification

Applied at 16:57 EDT on October 22, 2026. Production database comparison matched
all 2,843 planned changes exactly: 2,812 additions and 31 reassigned guides. No
existing mappings were removed. The 348 confirmed assignments were persisted
alongside the changes. SQLite integrity passed, the listings/identifiers tables
were preserved, and 3,735 mapped entries had a current programme at verification.
Sample production lookups returned titles for A&E, Smithsonian, PBS WNED, FOX
WNYW, CTV 2 Vancouver, HBO HD, and History. Unverified HBO remained unmapped.
No playback or website restart was performed.

The searchable result is `channel-guide-audit.html` in the private audit folder.
It includes every channel, applied changes, retained mappings, and suggestions
left unapplied. Its totals and script syntax were checked, and the report
contains no provider URLs or credentials.
