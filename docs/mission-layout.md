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
| The maths with no page in it (the path, the sun's and moon's real times and the moon's phase, the countdown's text, "all done") | `web/src/mission.ts`, tested in `test/mission.test.ts` |
| Home: the photos as the ground, Today and the Notepad on it | `web/src/components/mission/MissionHome.tsx`, `web/src/mission-home.css` |
| Which source light a save blinks | `web/src/uplink.ts` (called from `req` in `api.ts`), tested in `test/uplink.test.ts` |
| The tab's title and icon (every layout) | `web/src/tabTitle.ts`, tested in `test/tab-title.test.ts`; `web/src/hooks/useTabTitle.ts`; `web/public/favicon-lit.svg` |

The other layouts are untouched. What Mission adds to shared components is small and inert elsewhere: the rail takes
an optional `brand`, the top bar an optional `lead` (the hero in place of the greeting) and a row of source lights
that only Mission shows (with Launchpad's own light and its line in the poll's list).

## Built, against the design system

- Money, built from the ideas below (ideas 44–47; `mission.css` MONEY › GOALS, MONEY › OVERVIEW, MONEY › OWED AND
  STATEMENTS): a savings goal's bar fills like propellant loading as it comes in, slowly while the lines chill, then
  fast, then topping off, a cold vent at its front, over a gauge marked in tenths (idea 44); a goal just reached launches
  its card once, the way a countdown lifts off on its day: an account's card after the transfer that filled it has
  landed, a goal's progress in Goals as a short hop out of its cell (idea 44, `useUnseen`, once per goal on this device,
  when it's on the screen). Overview's balance is flown like Home's ascent: solid behind with its glow, dotted ahead, and
  Home's own vehicle at today, burning, with the beacon's ring, heading the way the balance goes over the days around
  today (40° at most), arriving as the line draws on to it (idea 45). An invoice marked paid flares its row: its tick
  rings, a band of light runs along the row and "Paid" reports in, before it goes on to Paid; the other designs stamp it
  their own way (idea 46). Importing a statement, the lock-on corners close on each matched line in turn and its tick
  reports in and flares; the other designs tick them in their way (idea 47).
- The sky by theme, the sun or moon on its arc by the clock, the horizon's glow near rising and setting, stars and
  twinklers, clouds, a satellite or a contrail now and then, cloud and rain from the forecast.
- Real sunrise and sunset, and the real moon (idea 1; `sunTimes`, `moonTimes`, `moonPhase`, `orbPlace` in `mission.ts`,
  drawn by `Scene.tsx`): the sun rises and sets at Singapore's times for the day (06:46 to 07:16, 18:50 to 19:20 over
  the year), worked out on the page with the usual almanac formulas, nothing asked of the network, within a minute or
  two of the almanacs. By night the moon rises and sets at its own times and is drawn at its real phase, a crescent to
  full, its lit side facing the sun in the scene's own sky (under the right-hand horizon after sunset, the left before
  dawn), its halo as strong as it is full. When it's down (it's up by day near new moon) the night has none: it fades as
  it sets and comes back up on the left, behind the pad, when it rises. When the theme and the clock disagree (Night at
  noon), it still sits low and late. A thin moon lights the horizon less.
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
- Learn's figures roll (idea 41, every layout; `Readout` in `Learn.tsx`): the week's study, the days in a row and today's,
  each day's total over its column, an exam's days to go, a course's grade and its study this week, the counts in Due
  soon's groups (they roll as you pick a course), how far through something on the side is (+1 rolls it), and in a
  course's drawer its grade, its study this week and the what-if grade as you type scores. The timer's clock rolls too
  in the other layouts (Mission shows its T+ face). Each keeps an `id`, so coming back to Learn shows them as they were.
- Stopping the timer raises its day's column by what was studied (idea 42, every layout; `useStudyRise` in
  `Learn.tsx`, `blocks` in `studyWeek`): a day's sessions are stacked in the order they were studied, and the running
  timer's block is on top, pale, as it isn't logged yet (Mission: propellant loading, its head lit in the colour of
  now). Stop and log, from anywhere (the timer, the top bar, ⌘K), fills that block with its course's colour from its
  foot: Vista slowly, Focus quick, Poster driven up a touch over, Mission burning up at a steady rate, lit at its head.
  Logging time by hand raises its day the same way. Under a minute (nothing logged), an Undo or a restore raises
  nothing. Less motion: the colour fades in.
- An exam inside a week is in the colour of now (idea 43; `mission.css` LEARN): in Today's Exams its days to go (or
  Tomorrow, Today) take the ignition colour with a faint glow, as the launch clock does inside ten minutes. Nothing
  flashes.
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
- A new best lands (idea 38; `useNewBests` in `Training.tsx`, `mission.css` TRAINING): in Your lifts, a PR that's new
  since this device last showed it (not every time Training opens; one that arrives while the tab is in the background
  waits until you're back) comes down with a flare, the lift's line draws on from the session before to the new high,
  which lights and sends out one ring, and the figure glows. Other layouts show the chip as before.
- Syncing from Hevy is a downlink (idea 39, every layout; `TrainingView`, `useArrivals` in `Training.tsx`): while Sync
  now runs, the line over Training says "Downloading from Hevy…" with a light running along under it (Vista's a long
  soft glow, Focus's a quick short one, Poster's a block of ink stepping across); Mission adds a small DOWNLINK, its
  signal bars lighting in turn, and packets streaming along the line. Sessions that arrive (a sync, an import, the
  server's own sync) slide in at the top of Recent sessions, the oldest first, and their day in the week brings them in;
  in Mission each new session lights as it reports in, its PR chip flares, and its day lights as the scan's cells do.
  Sessions are told apart by when they started, as an import's and Hevy's ids differ for the same session.
- A weight logged lands on the chart (idea 40, every layout; `useLanding`, `WeightChart` in `Training.tsx`): it drops
  onto its day from just above the chart (from where it was, when a day's weight changes), and when it's the latest the
  7-day line runs on to it and its end lights again. Logged in the panel, in ⌘K, or on another device; not a removal.
  Vista floats it down, Focus is quick with no bounce, Poster slams it down and it squashes as it hits; in Mission it's
  a landing: it comes down lit, slowing to a touchdown, a ring goes out as it touches, and it cools to the other days'
  grey before the line runs on at a steady rate.
- New lessons come in on a downlink's sweep (idea 29; `useUnseen` in `Motion.tsx`, `Today` in `Digest.tsx`,
  `mission.css` DIGEST AND INBOX): today's lessons that are new since this device last showed them (the morning's, or
  one swapped in with Another one) are drawn in from the top behind a lit line, one after another, as if received line
  by line, and each subject's placard relights as the line passes it; opening the Digest, once the view has arrived.
  Not every time the Digest opens, and nothing on a device's first run (what's there was there before); what's been
  seen is kept in `localStorage` (`launchpad:seenLessons`). Less motion: they fade in.
- The day's quick checks are a row of lights (idea 30, every layout; `DayLights` and `useDayDone` in `Digest.tsx`): on
  each of today's quick checks, a light for every lesson with one, this lesson's ringed: hollow until answered, lit once
  it is, and once all are answered, all the colour of fine. Answering the last (here, or on another device) lights them
  that way one after another; opening a day already done just shows them lit. Vista blooms each, Focus snaps them on,
  Poster stamps square ones; in Mission they stand by dashed, then report in green, each sending out a ring, and a small
  GO lights after the last. Only with two or more checks in the day. Less motion: they change colour in turn, without
  growing.
- Checking for new mail pings, and new mail slides in (idea 31, every layout; `Inbox.tsx`, `useArrived` in
  `Motion.tsx`): while Check for new mail runs, rings go out from its button one after another (Mission's lit like
  sonar, Vista's a soft halo, Focus's one thin ring, Poster's square, knocked out in steps) and the line says "Checking
  for new mail…". Emails that come in while the Inbox shows (from the button, the hourly check or another device), and
  the digest items they bring, slide in at the top as the list opens up for them, the oldest first; Mission lights them
  as they report in. The counts in the head and the columns roll. Less motion: one still ring while it checks; what
  arrives fades in.
- An email archived folds away (idea 32, every layout; `FoldRow`, `focusPastRow` and `useWithGone` in `Motion.tsx`,
  `motion.css` ROWS COMING AND GOING): an email or a digest item archived, from its button or its menu, slides out to
  the side, then the rows after it close up; Undo brings it back, sliding in. The keyboard's place moves on to the next
  row (or the one before, or the panel), so archiving with the keys carries on down the list. A bill kept or dismissed
  goes the same way, and the bills panel after its last. Marking read doesn't take an email out of the list (it's still
  in the inbox), so its unread dot goes out instead, like a light, and the words close over where it was. Vista drifts
  it away, Poster wipes it off, Mission jettisons it like a spent stage, dimming and greying as it drops back. The
  Inbox's source light still blinks for each change (idea 21). Less motion: the row fades, then the list closes up at
  once.
- The time since the last cigarette is mission elapsed time (idea 33; `SinceLast` in `You.tsx`, `elapsedText` in
  `mission.ts`, `mission.css` YOU): Cigarettes' "Last one" reads "T+06:42:58" in the launch clock's dot-matrix face
  ("T+1:02:13:45" past a day), so the streak is alive. It steps once a second, on the second of the gap, only while the
  page is in view, and only the digits that changed relight. Logging one sets it back to zero. Other layouts keep "6 h
  42 min ago".
- A cigarette logged lands (idea 34, every layout; `useLogged` in `You.tsx`, `addedOne` in `motion.ts`): its mark drops
  onto the day's line, and once it's down today's bar rises from where it was and its count comes in. Vista floats it
  down and rises slowly, Focus is quick with no bounce, Poster slams the mark down (it squashes as it hits) and drives
  the bar up hard, a touch over, stamping its count; in Mission it's a touchdown: the mark comes down lit, a ring goes
  out as it touches and it cools to grey, then the bar burns up at a steady rate, lit at its head, and its count
  relights. From Log one, C, ⌘K or another device; not an Undo, and not the server's answer, which gives the one just
  logged its own time.
- Picking a mood lights its day (idea 35; `Flare` in `You.tsx`, `mission.css` YOU): on the month's calendar the day
  lights as the scan's cells do, cooling to its mood's colour, with one ring going out, and its pixel in the year lights
  with it. Each pick lights afresh; taking a mood off lights nothing. The month's scan (idea 20) is as it was.
- Today's pixel twinkles (idea 36; `mission.css` YOU): in Year in pixels a glint around today's square fades and shrinks
  and comes back every five seconds or so, like the sky's stars. Opacity and scale only; with less motion it stays lit.
- Countdowns lift off (idea 37; `useLiftoffs` in `You.tsx`, `liftoffs` in `motion.ts`, `mission.css` YOU): the nearest
  one still to come counts down in the dot-matrix face ("T-05 DAYS"); one due today is in the colour of now, and on its
  day it lifts off once: it ignites, and what's on it climbs out of the top of the card on a plume of light, slowly then
  faster, the way the mark leaves its tile, then rolls back into place from below. Once a day for each countdown,
  remembered on this device across reloads (`launchpad:liftoffs`), and only where it can be seen: in Mission, with the
  page in view and the card on the screen (on a phone it waits until you scroll down to it). Past ones are spent stages:
  hollow and dimmed, their bar burnt out to a dashed line, and as the view opens their ember goes out. A countdown has
  a right-click menu (Edit, Delete) in every layout.
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

**Money**

All built (ideas 44–47, see Built).

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
