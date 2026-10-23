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

## Second pass: regional feeds and digital subchannels

The October 22 follow-up finds 205 more unmapped entries and 52 existing
assignments to update, for 3,974 mapped entries. Five additional assignments
are confirmed. The isolated rehearsal preserves every previous mapping and
override, including HBO HD, History, and the unresolved HBO block. All 30
guide/audit tests pass.

Station indexing now uses the call sign in the guide ID, avoiding sister-station
mentions such as KICU / KTVU Plus. When the playlist does not specify a digital
subchannel, an explicit network plus call sign can select a unique DT2/DT3 feed.
Explicit subchannels remain binding. Network checks also reject mismatches such
as Movies! versus FOX on the same transmitter.

Named Canadian city feeds, regional US sports/news feeds, and a limited set of
Canadian network identities can establish region without a country prefix.
The selected guide must still match the complete label and feed. Supporting
sources include [Sportsnet's channel list](https://www.sportsnet.ca/about/),
[Bell's distribution grid](https://www.bellmts.ca/migration/find%20a%20channel),
[Bell's channel updates](https://www.bell.ca/Bell_TV/channelupdates),
[Crave's numbered channels](https://www.rogers.com/tv/channels/crave), and
[News 12 Hudson Valley](https://hudsonvalley.news12.com/).

Explicit old-ID aliases include the documented
[MAVTV to RACER rebrand](https://racer.com/2025/03/27/mavtv-acquired-to-be-rebranded-racer)
and [Hallmark Movies & Mysteries to Hallmark Mystery](https://www.directv.com/insider/hallmark-movies-and-mysteries/),
plus spelling/abbreviation variants that retain country and feed. Time-shift
and 4K conflicts are rejected during fallback matching. Placeholder-only
listings, including “Channel No Longer Available,” do not enable a new mapping.

UK sources with the same channel name sometimes have different schedules;
these were not collapsed or chosen by listing count. Available Pluto records
often repeat channel names instead of programme titles; those were not added.
There are 533 remaining name-based suggestions, and 10,875 entries remain
unmapped. None of these results constitutes visual playback verification.

Private backups, the reviewed report, and rehearsal evidence are in
`/home/samer/Documents/ChatGPT/migration/channel-audit-round2-20261022-182419/`.

Applied at 18:32 EDT. Live database comparison matched all 257 planned changes
and five confirmations exactly. All prior overrides and mapping entries were
retained, SQLite integrity passed, and guide/identifier/programme table counts
were unchanged. The production lookup function returned current and next
programmes for sampled new channels, HBO HD, and History; unresolved HBO remained
unmapped. There were 3,937 mapped entries with a current programme at verification.
No website or encoder restart was performed. The searchable HTML report in the
private folder contains all 14,849 entries and the second-pass results.

## Focused broadcast-feed pass after loop removal

After removal of the separately reviewed 1,551 loop entries and 165 movie
collections, the live playlist contains 13,133 entries. This pass reviews only
the 3,890 previously unmapped entries whose labels resemble broadcast/cable
feeds. The classification is a shortlist, not proof that every stream is a
traditional broadcast feed. Alternate qualities and provider copies count as
separate entries.

The reviewed plan adds 262 guide mappings. Another 313 name-based suggestions
remain unapplied. Existing assignments are preserved, including HBO HD and
History; the unknown regional HBO feed remains explicitly blocked. Expected
coverage after application is 4,236 mapped entries and 8,897 unmapped entries
across the entire remaining playlist.

The parser now handles additional provider transport tags, joined digital call
signs, technical frame-rate labels, and accented city names. Canadian city and
province aliases must identify the same complete station. Specific Canadian
network identities and documented spelling variants can establish a region;
French-language playlist categories do not override a known Canadian identity.
Local CBC/Global/City news streams remain distinct from their broadcast stations.
West/Pacific, explicit subchannels, +1 and 4K qualifiers remain binding.

Network-and-city matching requires a unique station and the full catalog
location, with optional state abbreviations. A state or partial city label
such as Fox Kansas or Fox Virginia cannot select a local station. Numbered
brands such as PBS12 require stronger identity evidence. Unknown identifiers,
conflicting call signs, and unresolved multi-city markets remain unchanged.

Supporting network/provider sources include
[Bell's Canadian channel grid](https://www.bellmts.ca/migration/find%20a%20channel),
[CTV Sci-Fi's owner](https://www.bellmedia.ca/the-lede/tv/ctv-sci-fi/),
[TSN's five feeds](https://www.shawdirect.ca/english/promotions/tv-apps/tsn-go/),
[NESN's network information](https://nesn.com/press-room), and the
[C-SPAN viewer guide](https://static.c-span.org/assets/documents/C-SPANViewersGuide.pdf).
[CBC News Explore](https://solutionsmedia.cbcrc.ca/en/platforms/cbc-news-explore)
is an example of a separate news streaming service; a shared parent brand does
not justify substituting a broadcast station's schedule.

Three short visual samples illustrate the remaining uncertainty. The WJTV
entry returned a provider unavailable screen. The WSPA-labelled stream showed
CBS branding while its candidate guide listed CW programming. HBO showed its
logo during credits but supplied no regional identity. All three remain
unresolved. The other accepted matches rely on playlist/catalog identities;
they are not claims of visual playback verification.

All 43 guide/audit regression tests pass. An isolated application rehearsal
verified exactly 262 additions, preservation of all 3,974 prior mappings and
3,456 prior overrides, unchanged guide/identifier/programme table counts, and
SQLite integrity. A fresh audit against production matched the reviewed plan
and all channel fingerprints.

The optional `--scope /private/path/focus.json` argument accepts reviewed
`id`/`name` pairs, rejects changed identities or duplicate IDs, and leaves
entries outside that scope out of the report. Application retains its existing
snapshot checks and consistent pre-write database backup.

Private evidence and backups are under
`/home/samer/Documents/ChatGPT/migration/broadcast-channel-audit-20261022-205406/`.
Only the audit script, regression tests, and this documentation are committed.
