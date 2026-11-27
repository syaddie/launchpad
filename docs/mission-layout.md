# The Mission layout

Launchpad's default layout (design key `mission`): the page is a launch site. Its sky follows the hour and the
weather, the pad stands on the horizon, the day climbs across the sky as an ascent with a launch clock counting to the
next event, your photos are the ground under it, and the panels stand on them as glass.

The design system it is built from (tokens, components with live previews, the motion and the logo) is the
"Launchpad" Design System artifact: https://claude.ai/artifact/HXDyaPH2PE2aeL2QkjqEsN

## Where the code is

| What | Where |
|---|---|
| Tokens, glass, the strip, the dock, the hero, motion | `web/src/mission.css` (loaded last, after `motion.css`) |
| The scene: sky, sun and moon, stars, clouds, the site, the ascent, particles, the launch | `web/src/components/mission/Scene.tsx` |
| The launch clock and what it counts to | `web/src/components/mission/Hero.tsx` |
| The mark, drawn inline | `web/src/components/mission/Mark.tsx` |
| The maths with no page in it (the path, the sun's place, the countdown's text, "all done") | `web/src/mission.ts`, tested in `test/mission.test.ts` |
| Home: the photos as the ground, Today and the Notepad on it | `web/src/components/mission/MissionHome.tsx`, `web/src/mission-home.css` |
| Which source light a save blinks | `web/src/uplink.ts` (called from `req` in `api.ts`), tested in `test/uplink.test.ts` |
| The tab's title and icon (every layout) | `web/src/tabTitle.ts`, tested in `test/tab-title.test.ts`; `web/src/hooks/useTabTitle.ts`; `web/public/favicon-lit.svg` |

The other layouts are untouched. What Mission adds to shared components is small and inert elsewhere: the rail takes
an optional `brand`, the top bar an optional `lead` (the hero in place of the greeting) and a row of source lights
that only Mission shows (with Launchpad's own light and its line in the poll's list).

## Built, against the design system

- The sky by theme, the sun or moon on its arc by the clock, the horizon's glow near rising and setting, stars and
  twinklers, clouds, a satellite or a contrail now and then, cloud and rain from the forecast.
- The site: tower, masts with blinking lamps, water tower, floodlights at night, the vehicle venting.
- The day's ascent with its waypoints and the vehicle on it, burning.
- The launch clock (T- to the next event, T+ during one, the time of day when nothing is left).
- Glass panels with the pointer's light on them; the strip with its gliding selector; the phone's dock.
- A light per source of data, reporting in turn as the app opens.
- The launch: on the mark when already on Home (it used to go off on the last of the day's tasks too, until Tasks
  was retired on 25 Nov 2026).
- Home's ground: your photos from the horizon to the bottom of the window, edge to edge, crossfading with a slow
  settle every 18 s; a line fills while one stays, pointing at it holds it (a recording light goes still), and the
  open ground between Today and the Notepad has its frame number and arrows. On a phone it's a band under the sky.
  The glass over the photos is thicker, and the edges dusk a little (more at night), so words stay easy to read.
- Money › Month (`mission.css`, MONEY › MONTH): changing month is a scan. A beam with an afterglow crosses the
  calendar at a steady rate the way you went, wiping the old month off; each day lights as it passes, then cools, and
  the month's name relights letter by letter from the same side, like the launch clock's dots. The day you pick is
  locked on to (four corners close in, then fade to its ring), today's date breathes a ring now and then, and an entry
  you tick sends out one ring of light.
- Home's ground with no photos (idea 27; `Apron` in `MissionHome.tsx`, the maths in `mission.ts`, the look in
  `mission-home.css`): the launch site's apron, rows of lights in perspective from your feet to the middle of the
  horizon, crowding together and getting smaller as they go, with painted lines and joints. The runway's lights flash in
  sequence toward the horizon, two rows at a time, then rest (every 3.2 s); the taxiways' burn steady blue, passing
  under the panels. The flash is on or off, never between, so a page left open redraws only those dots. By day the
  fixtures are dots and the flash is the accent; by night they glow. On a phone it's the band under the sky, as tall as a
  photo's, with the invitation to add photos on it. Photos switched off: no apron. Less motion: the lights burn steady.
- A box ticked by hand sends out one ring of light (idea 28, `msTickFlare`): in the Notepad too, where the line now dims
  as the ring fades rather than before it, so the ring goes out at full strength. Boxes already ticked no longer flare as
  they come into view (the app opening, another notepad, another view): `tickMarks.ts` marks a box ticked by hand.
- The launch clock's last ten seconds (idea 4; `finalCount` in `mission.ts`, `Hero.tsx`): a soft ring goes out from
  its face with each second, the beacon by its label breathing with it, and the vehicle on the ascent burns brighter
  until the event starts. Nothing louder. Less motion: no ring; the vehicle still brightens, as the clock still turns
  the colour of now.
- Staging (idea 5; `stagesShed` in `mission.ts`, `Scene.tsx`): as each event ends, the vehicle on the ascent sheds a
  spent stage. It's pushed off the tail, then falls toward the ground, tumbling, its engine's ember going out, and
  fades. Only the last one when several ended at once (the page asleep), none while on another view or with the page
  hidden, and none with less motion.
- The study timer is mission elapsed time (idea 15; `Learn.tsx`, `mission.css` LEARN): Learn's running timer reads
  "T+00:24:10" in the launch clock's dot-matrix face, its digits relighting as they change, in the colour of now (it's
  what's happening this minute, as the top bar's study button already said), its dot a beacon. Starting it is an
  ignition: as the timer takes Start studying's place it flares hot and sends out one ring (only when it starts while
  Learn is open, not for one already running). Its row has a menu with Stop and log.
- Server › Services is a go/no-go poll (idea 16; `markOf` in `Containers.tsx`, `ServicesPanel` in `Server.tsx`,
  `mission.css` SERVER): each container, sync and health check has a light with the source lights' marks. Up and
  healthy is go; starting or restarting holds; unhealthy or dead is scrubbed; stopped, made or paused stands by. A sync
  failing with a reason is scrubbed, a sync that hasn't run stands by. They report in one after another as the panel
  opens, and the panel's head counts them ("9 GO · 1 HOLD").
- Moving money is a transfer orbit (idea 17; `TransferOrbit` in `Accounts.tsx`, `mission.css` MONEY › ACCOUNTS):
  once Move money's drawer has gone, the account the money leaves gives a short burn, a point of light climbs off its
  balance and travels on an arc over a faint trace to the other account's, which flares as it lands; then both
  balances roll. Only for a move done by today (a planned one changes nothing yet). The balances are `Readout`s now, so
  they roll in every layout; only Mission waits for the light.
- Losing the server is loss of signal (idea 18; `TopBar.tsx`, `App.tsx`, `mission.css` LOSS OF SIGNAL): as the
  banner comes down, the source lights go out one at a time and a small "LOS" lights beside them; when the server
  answers again the banner goes back up and the lights report back in, in turn, as they do when the app opens.
- The three empty-state drawings (idea 19; `mission/EmptyArt.tsx`, `mission.css` EMPTY STATES): a small line drawing of
  the site over an empty state's words, at 38 places. Pad clear (the pad and tower, a few stars) for nothing to do:
  nothing due, no countdowns, an empty folder, trash, month or search. Vehicle away (the vehicle's outline dashed on the
  pad) for what isn't set up yet: Google, SSH, the API key, Docker, Hevy, a source switched off. Launch scrubbed (the
  vehicle on the pad with its engine out, venting, beside the scrub mark) for what failed to load and a view that hit a
  problem. Loading states have none. Only the mast's lamp moves, blinking with the site's.
- Changing a period with arrows is the Month scan everywhere (idea 20; `periodMotion.ts`, `usePeriodScan` and
  `Glyphs` in `Motion.tsx`, `mission.css` CHANGING A PERIOD): Mood's month, Year in pixels' year, Review's week and
  Training's week (and its columns) scan like Money › Month, each cell lighting as the beam passes it (measured across
  the grid, so any layout works) and the period's name relighting from the side you went. Review's and Training's
  figures roll from the week before. Every layout has its own version (docs/motion.md, "Changing a period"). Music's
  slot calendar has no arrows (it shows every day that's known at once), so there's no period to change there; Check
  now's scan across it (idea 57) can use the same pieces.
- A save blinks its source's light, like a packet going up (idea 21; `uplink.ts`, `TopBar.tsx`, `mission.css` SAVES
  GOING UP): the API layer notes every save the server takes, and the light it belongs to blinks once, a ring pulsing
  off it as a packet streaks up. An event added is the calendar's, an email archived or a bill dropped the inbox's, a
  lesson marked or a story saved the digest's. Everything kept in Launchpad's own store (notes, money, Learn, the
  trackers, settings, photos) goes to a new last light, Launchpad's own ("Saved just now" in the poll's list), which
  holds while edits wait in this browser to be sent. Reads, refreshes, syncs, Claude's answers and actions on the server
  (a restart, a download, a file) aren't saves. Queued edits sent after a loss of signal blink as they go. Less motion:
  the ring fades, nothing travels.
- Waiting (idea 22; `mission.css` WAITING): "Loading…" is a scan line acquiring. A line with its afterglow crosses the
  words of whatever is being waited for (26 places marked `lp-loading`: the server's health, the SSH check, the files,
  logs, slots, downloads, Claude writing a note…) and the placeholder of a view whose code is still coming, again and
  again until it's there, starting a moment late so a quick wait shows nothing. A spinner is a small satellite, a body
  between two panels, circling a planet on a faint dashed orbit. Less motion: no line, and the satellite stands still.
- ⌘K's highlighted result glides from row to row (idea 23, every layout; `Palette.tsx`, `motion.css`): as the arrows or
  the pointer move the selection, the highlight travels in each layout's pace (Vista's spring, Focus quick, Poster's
  hard stops), Mission's a lit plate like the strip's selector. Typing places it afresh rather than flying it.
- A right-click menu's items relight in turn as it opens (idea 24; `mission.css` MENUS), top to bottom, each in three
  steps with a moment's glow, like a period's name; a long menu is lit within half a second. Only light: every item
  answers the pointer and the keys at once, and the one with focus or the pointer is lit straight away. Less motion:
  none.
- An Undo message counts down in five dots (idea 25; `App.tsx`, `mission.css`): the line along its foot is a row of
  five dots that go out one by one from the right, like the source lights losing signal, the last as the message goes.
  Pointing at it holds them, as it holds the message. Less motion: they fade out in turn without shrinking.
- The tab counts down (idea 26, every layout; `tabTitle.ts`, `useTabTitle.ts`): inside the hour before the day's next
  event the tab's title is "T-08:12 · Gym: push day", and while the study timer runs "T+24:10 · Studying ASE 301" (an
  event inside ten minutes comes first). Inside the launch clock's ten minutes, and while studying, the icon is the
  rocket lifting off on a long flame (`favicon-lit.svg`). Further off it's "Launchpad" and the usual icon. The title is
  written once a second only while it counts, on the second; otherwise it's looked at once a minute, and the icon is
  swapped only when it changes. A browser slows a hidden tab's timers after a few minutes, so a tab in the background
  may then count in steps of up to a minute.
- Reduced motion: the sky still shows the hour; nothing moves and nothing launches.

## Not built yet (in the design system, not in the app)

- **Telemetry**: the stepping strip chart for live readings on Server.
- **A panel's one big figure in the matrix face**, and the beacon and burn on a panel with something running in it.
- **A short sky with the view's title on it** is there on other views, but those views' own panels are only reskinned
  by the tokens, not redesigned.
- **"Follow the sun"** as a Theme choice (Day from sunrise, Night from sunset).
- **The new mark as the app's icon**: `web/public/favicon.svg` and the PNGs in `web/public/icons` are still the old
  rocket. The files are in the design system's Logos group.

## Ideas to push it further

Kept from the design sessions, roughly in the order worth trying.

1. **Real sunrise and sunset.** The sun is up at 07:00 and down at 19:00. Singapore's are within twenty minutes of
   that all year, but the real times (and the moon's real phase and rise) are a small calculation with no network.
2. **Dawn and dusk as their own skies.** Today the horizon warms inside one theme. A third and fourth palette
   (indigo into rose into orange) for the half hour either side of sunrise and sunset, cross-faded.
3. **Weather that is more than cloud and rain.** Thunder as a far flash behind the cloud; haze from the PSI reading
   as a pale band over the horizon; wind bending the vehicle's vapour.
6. **A recovery.** After a launch, minutes later, a far point of light comes back down to the horizon and lands.
7. **Parcels arriving as landings.** "Out for delivery" puts a small descending light in the sky; "Delivered" lands
   it beside the pad. (On hold: Packages was retired on 25 Nov 2026, its data kept.)
8. **The server as the site's power.** When a container is down, one of the site's floodlights is out, or a mast
   lamp turns steady instead of blinking. The scene as a status display you learn to read at a glance.
9. **A mission patch per day.** The date and the day's count of events drawn as a small round patch in the strip;
   a week of them in Review.
10. **Sound, off by default.** A low rumble on launch, a soft tick for the last ten seconds.
11. **Depth by scroll on a phone.** The sky's layers part as the page scrolls, as they do under the pointer on a desk.
12. **Other views' skies.** Money's sky with the month's balance as an altitude line; Training's with the week's
    sessions as waypoints; Learn's with a study timer as the vehicle climbing.
13. **A night mode for the eyes.** After 23:00 the site's lights dim to red, like a darkened control room.
14. **Hangar and Apogee in the sky.** Hangar's shed as a silhouette at the far end of the horizon; a faint ring
    high up where Apogee's orbit would be, with a dot on it when a study session is running.

### More, from a look through every view (28 Nov 2026)

After Money › Month got its scan, the owner asked for every other place the app could have more motion, life and
aerospace quirks. Most are Mission's own; those marked *(every design)* are motion each design would do in its own
way (docs/motion.md). **S** is small, mostly reusing what's there (the Month scan and lock-on corners in `mission.css`,
`msReport`, `msLiftoff`, `Readout`, `useGlide`); **M** is a new piece. Aerospace words ("T+", "LOS", "go") stay in the
small mono labels; the messages themselves stay plain.

**Digest and Inbox**

29. The morning's new lessons arrive with a short sweep, like a downlink, the first time they're seen. **S**
30. Answering every quick check of the day lights a row of lights green, one after another. **S** *(every design)*
31. Checking for new mail sends a ping out from the button; new emails slide in. **S** *(every design)*
32. An email archived or marked read slides out and the list closes up. **S–M** *(every design)*

**You**

33. Cigarettes: the time since the last one as T+ in the matrix face, ticking, so the streak is alive. **S–M**
34. Logging one drops its mark onto the day's line, and today's bar rises. **S** *(every design)*
35. Picking a mood lights that day on the month's calendar. **S**
36. Year in pixels: today's pixel twinkles slowly, like the sky's stars. **S**
37. Countdowns: the nearest in the matrix face; on its day the card lifts off once (`msLiftoff`); past ones dim like
    spent stages. **M**

**Training**

38. A new best (the PR chip) lands with a flare, and the lift's line draws to its new high, which pulses once. **S**
39. Syncing from Hevy shows a downlink while it runs; new sessions slide in. **S** *(every design)*
40. A body weight logged drops onto the chart and the line runs on to it. **M** *(every design)*

**Learn**

41. Learn's figures don't roll yet: give them `Readout`. **S** *(every design)*
42. Stopping the timer raises today's column by what was studied. **S** *(every design)*
43. An exam inside a week takes the colour of now, as the launch clock does inside ten minutes. **S**

**Money**

44. A savings goal's bar fills like propellant loading; reaching the goal launches the card once. **S–M**
45. Overview's balance chart has the vehicle at today, flown solid and ahead dotted, like Home's ascent. **M**
46. An invoice marked paid is stamped, or flares its row. **S** *(every design)*
47. Importing a statement, the matched lines tick in one after another. **S** *(every design)*

**Server**

48. The CPU and RAM rings are instruments: a tick scale, sweeping up as they open, a slow pulse above 90%. **S**
49. The speed test counts T-3, then its result sweeps up. **S–M**
50. Network is the stepping telemetry strip chart (in the design system, not built). **M**
51. A container restarting goes hold, then go with a flare; one that's down is scrubbed. **S**
52. Minecraft: a light for a player boarding, a countdown and ignition on start, scrubbed on a crash. **S–M**
53. Files: dragging over, the lock-on corners close in on the drop zone. **S**
54. Downloads: a sheen runs along a bar while it downloads, and the row flares when it's done. **S**
55. A new Terminal tab switches on like a CRT: a line that opens into the screen. **S**

**Review and Music**

56. Review's cards report in one after another, like a debrief, and Claude's recap appears a line at a time. **S**
57. Music's Check now sends the scan across the slot calendar, and free windows light as they're found. **S–M**
58. "Next check 08:55" is a small T- countdown that rolls. **S**
59. A watched slot coming free pings its day with a beacon ring. **S**

**Settings and phones**

60. Picking Mission in Settings › Layout launches the rocket in its little preview. **S**
61. A short vibration on a tick, a launch or a lock-on, where the phone allows it (Android; not Safari on an
    iPhone). **S** *(every design)*
