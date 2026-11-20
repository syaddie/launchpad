# NAC Slot Finder fixtures

Saved stand-ins for NAC's busking location pages, for `test/nac.test.ts` and for running the
app without asking NAC anything (`NAC_FIXTURES`, below).

The markup is NAC's own, as its pages and load-more answers looked on 20 Nov 2026: the page
header with the location's name and open hours, the booking cards, the hidden `skip`/`take`
inputs, and load-more answers as a JSON string of HTML with `<`, `>`, `&` and `'` escaped and
each busker's photo inline (here a few bytes of fake JPEG). Everything in it is made up: the
buskers (`TEST BUSKER 01` to `20`), their profile IDs (`a0000000-…`), booking IDs (`b0000000-…`),
image IDs (`c0000000-…`), the header text and every booking. The location IDs are NAC's real,
public ones from `server/src/config.ts`. No real busker's name or profile ID is in here.

"Your" profile ID is the made-up `11111111-2222-4333-8444-555555555555` (in `meta.json`). Your
cards use the same name as busker 07, whose ID is different, so a test can tell that "mine" is
matched by ID and not by name.

| Folder | What it is |
|---|---|
| `.` | The check at 12:20 on Fri 20 Nov 2026 (`meta.json`). Tampines to Mon 14 Dec, Pasir Ris to Fri 11 Dec, Paya Lebar to Mon 14 Dec, Changi Village to Sun 6 Dec. Tue 24 Nov is the spec's example day. Wed 2 Dec at Tampines has no bookings. |
| `later/` | The check after, at 12:50: a booking at Paya Lebar on Tue 24 Nov cancelled (2 PM to 7 PM free and new), Tampines opened Tue 15 Dec, and a slot at Pasir Ris taken. Only the files that changed; the rest come from the folder above. |
| `blocked/` | NAC's bot protection answering Tampines' load-more call with its own page. |
| `full/` | Every slot taken at every location, three days ahead. |
| `quiet/` | Nobody has booked Changi Village at all. (A made-up page: NAC's real page for a location with no bookings hasn't been seen.) |
| `none/` | No bookings at any location: what a change to NAC's markup looks like. |

Each location is `<key>.html` (its page, the first 12 cards) and `<key>-more.json` (what NAC
answers for `skip=10&take=200`: the Slot Finder asks from two cards back, see `OVERLAP` in
`server/src/nac.ts`).

## Running the app on these

Set `NAC_FIXTURES` when starting the server (`npm run dev:server`, or the built
`dist/server/index.js`):

```sh
NAC_FIXTURES=test/fixtures/nac npm run dev:server
```

With it set, the Slot Finder reads the folder instead of NAC, checks once at startup as well
as on :15 and :45, writes `DATA_DIR/nac/snapshot-fixtures.json` (never the real
`snapshot.json`), and the page marks the data as test data. Dates move so the fixtures'
Fri 20 Nov is today. Point it at `later/` and restart to see new windows, or at `blocked/` for
a failed check. Set `NAC_BUSKER_ID` to the made-up ID in `meta.json` to see yours.
