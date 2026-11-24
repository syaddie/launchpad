# NAC Slot Finder: spec

**Status:** draft · **Written:** 2026-11-20 · **Home:** a feature inside launchpad (Docker)

## 1. Goal

Show which busking slots are still **free** at my four regular NAC locations, so I can
decide where and when to book on the NAC portal. It also recognises **my own** bookings.

Not a goal: booking anything. Booking stays manual on the NAC portal (SingPass login,
which we never automate).

## 2. Builds on: streamlit-portfolio's `schedule-sync`

streamlit-portfolio already scrapes NAC: `schedule-sync/sync.py` reads **my** bookings
from the public endpoint behind my NAC profile every 30 min and writes `nac_schedule.csv`.
This feature is the same idea pointed at **location** pages instead of my profile.

Reuse these pieces from `sync.py` (standard library only, so copying them is simple):

| Piece | Reuse as-is? | Why |
|---|---|---|
| `fetch()` (XHR headers, "did not return JSON (blocked?)" check) | **yes** | same JSON-string-of-HTML response, same bot-check risk |
| `parse_date()` (year from matching weekday) | **yes** | same `Fri, 20 November` format with no year |
| `parse_time()` (`06:00:PM` to `18:00`) | **yes** | same time format |
| `write_csv()` write-then-rename | **yes** | so launchpad never reads a half-written file |
| `run()` keep-last-good + loop scheduler | **yes** | same 30-min loop, same failure handling |
| `data/nac_locations.csv` (NAC name to display name) | **yes**, add Changi Village | consistent names across both apps |
| `CARD_RE` | **no**, needs a new regex | location cards are laid out differently (see §4) |

Decision: copy the helpers into launchpad rather than share a package. Two small apps
with no shared dependency is simpler. (Alternative later: move them into a tiny shared
`nac` module if a third consumer appears.)

## 3. Locations (v1)

| Key | NAC location name | Location ID | Open hours (from page) |
|---|---|---|---|
| `tampines` | MRT STATION - DTL TAMPINES | `9c962e64-ae46-40d2-9506-eb71639b274d` | 10:00 AM – 2:00 PM |
| `pasir-ris` | MRT STATION - EWL PASIR RIS | `2df197be-cf61-4981-8aef-ebda3f353ec2` | 10:00 AM – 2:00 PM |
| `paya-lebar` | PAYA LEBAR SQUARE | `c6f63ddc-3926-4a83-b59f-e7904989c7a0` | 10:00 AM – 10:00 PM |
| `changi-village` | CHANGI VILLAGE - SPACE BETWEEN BLK 2 & 3 | `8f102e44-7f8d-45bc-a1da-50aa8a6202fc` | 10:00 AM – 10:00 PM |

Keep the list in config so adding a location means adding one line. Read open hours from
the page on every run, not from this table. They can change.

## 4. Data source (checked 2026-11-20)

Both endpoints are **public**: no login, no cookies.

1. **Location page**: `GET {BASE_URL}/locations/{id}/events`
   - Plain HTML (not JSON, unlike the profile endpoint). Has the open hours
     (`10:00:AM - 02:00:PM`) and the first ~11 cards.
2. **Load more**: `GET {BASE_URL}/locations/{id}/events/more?skip={n}&take={m}`
   - JSON string of HTML cards, the same shape `fetch()` already handles.
   - `skip=11&take=200` returned all 73 remaining Tampines cards (to Mon 14 Dec, about
     3.5 weeks ahead) in one call. Keep paging until a page returns fewer than `take`.
   - Each card carries its busker's photo inline as base64, about 0.3 MB a card, and NAC
     doesn't compress the answer: about 77 MB a check for the four locations.

**Update 2026-11-24:** the location page takes `skip` and `take` too
(`{BASE_URL}/locations/{id}/events?skip=0&take=1000`), even though NAC's own site never asks
it for more than 12. There the photos are links (`/Busking/booking/GetAppImage?id=…`), not
inline: Tampines' whole list of 134 cards was 221 KB in one request (about 12 s, the same
time NAC takes to build it for load-more), where load-more would have been about 38 MB. A
check of the four locations both ways the same day read the same 498 bookings: 4 requests,
0.83 MB and 49 s on the page, against 8 requests, 119 MB and 90 s through load-more. So
each location is read with that one request, and load-more is only the fallback for when
the page shows no more than its usual 12.

### Location card markup (differs from profile cards)

```html
<ul class="dash-bx-menus owner"><li><a href="">Published<img …white-play.png…></a></li></ul>
<h3><a href="…/Busking/busker/profile/{BUSKER_ID}"> FULL NAME </a></h3>
<li><img …red-date.png…>Fri, 20 November</li>
<li><img …red-clock.png…>12:00:PM-01:00:PM</li>
<li class="address"><a …><img …tem-location.png…>MRT STATION - DTL TAMPINES</a></li>
<button data-bookingid="{BOOKING_ID}" class="viewBalloting …">View more</button>
```

Fields to capture: **status, busker profile ID, date, time range, booking ID**.
Do **not** capture the full name; the profile ID is all we need.

### Status rules

| Status | Meaning for us |
|---|---|
| `Published` | **Taken** (from experience: same as Confirmed) |
| `Confirmed` | **Taken** |
| `Passed` | In the past. Ignore |
| anything else | Treat as **taken** and log it, so we learn what it means |

## 5. Logic

All times are Singapore time (SGT, UTC+8).

1. For each location, fetch all cards (the page with `take=1000`; page + load-more pages if
   the page only shows its usual 12).
2. **Horizon:** from *now* to the latest booking date seen at that location. Days past it
   are **unknown**, not free (booking may just not be open yet).
3. Split each day's open hours into 1-hour blocks (all bookings seen start and end on the hour).
4. Mark each block **mine** if it's covered by a card whose busker profile ID equals
   `NAC_BUSKER_ID` (same setting schedule-sync uses), **taken** if covered by any other
   taken card, otherwise **free**. Drop blocks that have already ended today.
5. **Merge** neighbouring free blocks into windows (same join idea as `build_rows()`).
6. **Diff** against the last snapshot. Flag free windows that are **new** (cancellation,
   or a new date opened).

Matching "mine" by profile ID, not by name, avoids false matches like
`MOHAMMAD SAID BIN RAHIM`, a real Tampines booking that isn't mine.

## 6. Output

Merged windows, grouped by date, then location:

```
Tue 24 Nov
  Paya Lebar       2 PM – 7 PM   (5 h)   NEW
  Changi Village   10 AM – 11 AM (1 h)
  Tampines         —  fully booked
  Pasir Ris        12 PM – 2 PM  (2 h)   ★ yours 10 AM – 12 PM
```

Header: `Last checked 14:30 · next check 15:00`, and on failure
`⚠ Data is from 13:30, NAC fetch failed: <reason>`.

How launchpad shows it (page, widget, alert) is up to launchpad. This feature produces:

```json
{
  "checked_at": "2026-11-20T14:30:00+08:00",
  "ok": true,
  "locations": [
    {
      "key": "paya-lebar",
      "name": "Paya Lebar Square",
      "open": "10:00", "close": "22:00",
      "horizon_end": "2026-12-14",
      "days": [
        {
          "date": "2026-11-24",
          "free":  [{ "start": "14:00", "end": "19:00", "new": true }],
          "mine":  [],
          "taken": [{ "start": "10:00", "end": "14:00", "status": "Confirmed" }]
        }
      ]
    }
  ]
}
```

No other buskers' names or profile IDs in stored or displayed data.

## 7. Schedule and politeness

- Every **30 minutes**, like schedule-sync. Requests **one at a time**, ~2 s apart:
  about 8 requests per run (4 pages + 4 load-more calls with `take=200`). Since 24 Nov 2026,
  4 (one page each, `take=1000`), under 1 MB a run.
- Keep schedule-sync's generic User-Agent style; no email in requests.
- The site is behind **Incapsula** (bot protection). On a non-200 or non-JSON/HTML-shaped
  response: stop the run, keep last good data, show the warning, and **back off** (skip
  the next few runs). **Never** try to get around the bot protection.
- Combined with schedule-sync, that's two scrapers hitting NAC from the same server.
  Stagger them (e.g. schedule-sync on :00/:30, this on :15/:45).

## 8. Edge cases

- **Year:** use `parse_date()`'s weekday-match approach (handles the Dec to Jan rollover).
- **Zero bookings** on a day inside the horizon = fully free.
- **Today:** only blocks that haven't ended yet.
- **Markup changes:** 0 cards parsed, or a card missing date/time, means a **failed run**,
  not "everything is free". Keep last good data and warn.
- **HTML entities** (`&amp;` in the Changi Village name): `html.unescape`, as `fetch_cards()` does.
- **Blackout days / public holidays:** not modelled in v1 (see open questions).

## 9. Storage

- `snapshot.json`: last good result, used for the diff and as the fallback.
- In a Docker volume so it survives rebuilds.
- Test fixtures: real responses with **names and profile IDs scrubbed** (keep one card
  with my ID to test "mine").

## 10. Acceptance criteria

- [ ] All 4 locations show merged free windows from now to the horizon.
- [ ] A slot I book on NAC shows as **mine** within 30 min; nobody else's ever does.
- [ ] A cancellation shows as a **NEW** free window within 30 min.
- [ ] If NAC is down or blocks us, last good data stays with a warning; nothing shows
      falsely free.
- [ ] No other busker's name or profile ID is stored or displayed.
- [ ] Parser tests run on scrubbed fixtures with no network.
- [ ] "Mine" slots agree with schedule-sync's `nac_schedule.csv` for the same period
      (cross-check that both scrapers read NAC the same way).

## 11. Out of scope (v1)

- Booking or balloting automatically (SingPass is never automated).
- Notifications (Telegram etc.). Easy to add on top of the "new" flag.
- Locations beyond the four above.

## 12. Later ideas

- Alert when a free window ≥ N hours opens at a favourite location/time.
- "Best times" stats from snapshot history (which slots tend to stay free).
- Add a "Changi Village" row to streamlit-portfolio's `data/nac_locations.csv`, so my
  bookings there get a nice display name on the site too.

## 13. Open questions

1. How far ahead does NAC open booking, and on what day? (Would let us show "opens on X"
   instead of "unknown".)
2. Min/max booking length, or a weekly cap per busker, that should filter which free
   windows I can actually book?
3. Does NAC close locations on public holidays or event days, and does the page show it?
4. Do cancelled bookings disappear, or show with a status like `Cancelled`?
