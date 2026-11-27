# Motion

How Launchpad moves. The rule: motion answers what you do (pressing, opening, switching, ticking off) and shows what
changed; very little moves by itself. Each design moves in its own character, from the same tokens.

The code: `web/src/motion.css` (the tokens, each design's character, and the shared motion: controls, highlights,
figures, things that open and close, views, the opening, what's alive on its own, less motion);
`web/src/components/Motion.tsx` (`Presence`, `Readout`, `useGlide`, `useSettled`, `usePeriodScan`, `Glyphs`);
`web/src/periodMotion.ts` (changing a period with arrows); `web/src/viewTransition.ts`
(changing view); `web/src/motion.ts` (the pure parts, tested in `test/motion.test.ts`); `web/src/loadable.tsx` (views
that render at once once their code is in). A part of the app's own motion (a task ticking off, a meter filling) is
in `styles.css` next to that part's other rules, using the tokens; how one design does it differently is in that
part's block in `designs.css`.

## Tokens

Every duration, ease and distance is a custom property on `:root`; a design changes them, and less motion changes
them again. Use them, never a bare `0.2s` or `ease`.

| Token | Default | Use |
|---|---|---|
| `--m-press` | 80ms | A press going down |
| `--m-hover` | 150ms | Hover tints fading in and out |
| `--m-state` | 220ms | A control changing state; small things appearing (popovers, menus, a tick) |
| `--m-move` | 340ms | Something moving to a new place: a highlight gliding, a drawer sliding in, a press coming back up |
| `--m-exit` | 160ms | Leaving is quicker than arriving |
| `--m-view` | 360ms | One view giving way to the next |
| `--m-roll` | 420ms | A digit rolling |
| `--m-sweep` | 720ms | A meter filling, a chart drawing |
| `--m-stagger` | 55ms | Between panels as the app opens |
| `--e-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Arriving: decelerates to rest |
| `--e-in` | `cubic-bezier(0.55, 0, 0.75, 0.2)` | Leaving: accelerates away |
| `--e-io` | `cubic-bezier(0.65, 0, 0.35, 1)` | Moving from one place to another, or drawing across |
| `--e-settle` | a spring, 2% over | Settling into place: a press coming back up, a highlight arriving, the palette |
| `--m-rise` | 8px | How far things travel as they appear |
| `--m-travel` | 22px | How far a view or a drawer slides |
| `--m-press-y`, `--m-press-s` | 1px, 0.97 | How far a pressed control goes down, and how much it shrinks |
| `--m-roll-d` | 0.62em | How far a digit rolls |
| `--m-view-mode` | `transition` | How a view change moves: the browser's view transition, or `enter` (see Views) |
| `--hv-press` | 10% ink | A pressed row, a step past its hover tint |

The springs are `linear()` curves sampled from a damped spring that settles (to within 0.1%) in the duration it's
given: 2% overshoot by default (damping 0.78), 7% for Vista (0.65).

## Each design's character

Broadsheet, Console, Bento and Horizon, and their motion, were retired on 25 Nov 2026 (git tag
`designs-before-retiring`).


- **The default** settles like paper: gentle decelerations, a 2% spring. Opening, each panel is laid down on the desk,
  its shadow tightening as it lands. The rail's highlight glides to the view you picked.
- **Mission** starts from the default and adds its own (in `mission.css`): the strip and the dock come in, the sources
  report in, the day's ascent draws on, and ticking off the last task launches the rocket. Its sun and moon keep their
  real times for Singapore, the moon at its real phase, fading out as it sets and back in as it rises. In Money › Month, changing
  month is a radar-like scan, the day you pick is locked on to, today breathes a ring and a ticked entry flares. A box
  ticked by hand sends out a ring of light. With no photos, Home's ground is a lit apron whose runway lights flash in
  sequence toward the horizon. In the launch clock's last ten seconds a soft ring goes out from it each second and the
  vehicle on the ascent brightens; as each event ends, that vehicle sheds a spent stage that falls away. Every period
  with arrows changes with Money › Month's scan. Learn's study timer is T+ in the dot-matrix face and starting it is an
  ignition; Server › Services is a go/no-go poll that reports in; moving money sends a point of light on an arc between
  the two accounts before their balances roll; losing the server puts the source lights out one at a time, and they
  report back in when it's back; empty states have a drawing of the site (pad clear, vehicle away, launch scrubbed).
  Anything saved blinks its source's light in the strip, like a packet going up (`uplink.ts`); "Loading…" is a scan line
  acquiring and a spinner a small satellite circling; ⌘K's highlight is a lit plate; a right-click menu's items relight
  in turn as it opens; an Undo message counts down in five dots going out one by one. In Training, a new best lands with
  a flare and its lift's line draws on to the new high, which sends out a ring; a sync is a downlink (DOWNLINK, signal
  bars, packets) and what it brings reports in, lit; a weight logged comes down to a touchdown on its day before the line
  runs on to it. See [`mission-layout.md`](mission-layout.md).
- **Vista** drifts like light on glass: long, soft arrivals and a 7% spring. Its photo drifts so slowly you only notice
  it has moved. Its views don't use the browser's transitions (`--m-view-mode: enter`): the glass blurs the photo
  behind it, which a part pictured on its own, or anything inside a fading container, can't see. So the new view's
  panels condense into place by themselves, each blurring the photo throughout.
- **Focus** is quick and exact: short moves, no overshoot, small distances. The sidebar's highlight and the home tabs'
  white pill glide.
- **Poster** slams like a press: hard starts, hard stops, cuts where a fade would be soft. A button stands up off the
  page when pointed at, its hard shadow showing, and slams down into it when pressed. A new view rolls down off the
  press (up, going back); the drawer is a sheet slammed in from the edge; opening, the masthead's rule and then each
  sheet wipe in from the left. Digits are stamped.

## What moves

- **Controls answer the hand.** Pointed at, a control tints (each design's hover in `styles.css`/`designs.css`).
  Pressed, a button, chip or tab goes down a step in `--m-press` and springs back on `--e-settle`; a row tints a step
  further (`--hv-press`); a card gives a little. The focus ring closes in on what's focused, like a sight locking on.
  A ticked box's tick lands with a bounce. The individual `translate` and `scale` properties are used throughout, so
  motion never fights a `transform` an element is placed with.
- **The active item's highlight glides** (`useGlide`, or `<Glide on={…} />` first in a row): the rail, every row of
  tabs and every segmented control draw their active item's background on one span that moves from item to item, so
  changing view or tab shows where you went from and to. The item arriving takes its colours as the highlight reaches
  it. (Not Server's own tabs, which light two at once when Terminal and Files share the view.) ⌘K's highlighted result
  glides the same way between rows as the arrows or the pointer move it; typing places it afresh.
- **Figures roll** (`Readout`): a changed digit leaves as its new one arrives, upward when the figure grew and downward
  when it shrank; the digits that didn't change stay still, and the units stay put when a figure grows a digit. The
  clock's minutes roll over. A figure remembers what it showed last (by its `id`), so coming back to a view shows it
  as it was, and one that changed meanwhile rolls from what was last seen.
- **Things open from where they're anchored and close a little quicker** (`Presence` keeps a closing thing on the
  page, marked `data-leaving` and inert, until its exit animation has run, at most 450ms): popovers and menus drop
  from what opened them; the drawer slides in from the edge over a dimming page; the palette and the shortcuts sheet
  drop into place on a spring; messages rise from the bottom edge and sink back. A message with an Undo shows how long
  it has left with a line along its foot (Mission: five dots going out one by one), and stays while pointed at.
- **Views move the way you went along the rail** (`viewTransition.ts`): toward a view further along it is `next`, back
  toward Home is `prev`, along the rail's own direction (down where it runs down the side, sideways where it runs
  across: a phone's, Mission's strip and dock). The old view clears first, then the new one arrives,
  so two layouts are never seen over each other; the title changes in place; the rail and the rest of the frame stay
  put, the highlight gliding. Each design does this its own way (above). Back and Forward move the same way, unless
  the browser animated the change itself (a phone's back swipe). A view whose code isn't in yet is waited for, up to
  400ms, so the motion goes to the view and not its loading placeholder. Without view transitions the new view rises in.
- **The opening.** The first view after the app opens comes in once, in each design's own way, its panels one after
  another; then `lp-opening` comes off the page (after 2.2s, or at the first change of view) and nothing replays it
  until the app is opened again.
- **Meters fill and charts draw** as they appear (`lpSweepX`, `lpSweepY`, `lpDrawAcross` in motion.css's METERS AND
  CHARTS): bars fill from empty, columns rise one after another (where the browser has `sibling-index()`; all at
  once where it hasn't), lines draw across, and once drawn nothing clips them (so a dot at a line's very end shows
  whole); and a bar slides to a new reading when it changes.
- **Ticking things off.** A task's tick lands, its line is struck through and it dims for its 5-second undo; then it
  folds away and the tasks below close up (`.task-item.leaving`). A box ticked by hand is marked `data-ticked` for a
  moment (`tickMarks.ts`, one listener for the app), so a design can give that tick some light without every box already
  ticked lighting up as it comes into view (Mission's ring; a notepad's line dims as it fades). A task added slides in while it saves. The undo bar
  rises in and sinks away.
- **What's on now.** Today's event on now has a line along its foot that fills as the minutes go (how far through it
  you are), and its "in 35 min" rolls down to the start. A package out for delivery has a light travelling along its
  stage, and the stages fill in turn as the panel appears.
- **Changing a period** with arrows goes the way you went, as views do: Money › Month (and This month), Mood's month,
  Year in pixels' year, Review's week (and This week), Training's week (and its columns). `usePeriodScan` (Motion.tsx)
  and `periodMotion.ts` do it for any of them: the host is `lp-scan` and marked `data-arrive` while the new period comes
  in, what changes is `lp-scan-grid` (keyed by the period, so it comes in whole), the cells that light are
  `lp-scan-cell`, and the period's name is `lp-period-label` with `Glyphs` in it; the rules are after the calendar's in
  `styles.css`. A copy of the old grid stays over the new one (inert, hidden from screen readers) and a line crosses it,
  the new period behind it and the old ahead, in `--sweep` (1.5 × `--m-view`); the name comes in from that side, and
  the figures roll (Money › Month's four one after another). Vista and Focus slide instead (the old period clears
  first, then the new one arrives); Poster slams a bar of ink across and stamps the name; Mission makes it a scan (in
  `mission.css`), each cell lighting as the beam reaches it (`--x`, where the cell is across the grid). Opening a
  period from elsewhere (a day picked in the year, Money's Month from Overview) just shows it.
- **The tab says what's coming** (`tabTitle.ts`, `hooks/useTabTitle.ts`, every design): inside the hour before the
  day's next event its title counts down ("T-08:12 · Gym: push day"), and while studying it counts up ("T+24:10 ·
  Studying ASE 301"); inside the launch clock's ten minutes, and while studying, its icon lifts off on a flame. Written
  at most once a second and only while counting; the icon only when it changes.
- **Lists animate what's added to them**, not what was there when they appeared (that comes in with its view):
  `useSettled` marks a list `data-settled` two frames after it's drawn, and the list's items have an
  `@starting-style` under that mark. (Tasks do it more simply: a task still saving has the page's own id, so it's
  marked `data-new` while it slides in.) Training's sessions are marked `data-new` for a moment instead
  (`useArrivals`, which waits for `useSettled` too), by when they started, since an import's ids and Hevy's differ for
  the same session: those after the newest one shown slide in at the top of Recent sessions, the oldest first, and their
  day in the week brings them in (`trArrive` in `styles.css`; Vista drifts, Poster wipes, Mission lights them).
- **Waiting on a sync.** Training's Sync now puts a downlink in place of the line about your workouts while it runs:
  the words, and a light running along under them in each design's way (`.tr-downlink`). It's the only thing there
  that moves by itself, and only for as long as the sync takes.
- **What you log lands.** A weight logged drops onto the body weight chart, on its day, from just above the chart (or
  from where it was, if that day's weight changed), and when it's the latest the 7-day line runs on to it and its end
  lights again (`useLanding`, `WeightChart`; `trDrop`, `trRunOn` in `styles.css`). Vista floats it down, Focus is quick,
  Poster slams it so it squashes as it hits, Mission brings it down to a touchdown with a ring. A removal, or many days
  changing at once (a restore), doesn't land anything.
- **A new best** in Training's Your lifts lands once, the first time this device shows it (`useNewBests`, keeping
  what's been seen in `localStorage`): Mission's flare and line drawing to the new high (`mission.css`, TRAINING); the
  other designs show the chip as they always have.

## Alive on its own

Little moves by itself, and each thing that does is slow or stepped, so a page left open all day costs next to
nothing: the clock's minutes, Vista's photo drifting (it steps once a second, so the glass over it is redrawn once a
second rather than every frame), Mission's sky and the ring today's date breathes on Money's calendar (scaled, so
nothing is repainted for it), and the runway lights on Mission's apron when Home has no photos (each dot on or off, a
run every few seconds). In Mission, a running study timer's digits relight as they change and its dot breathes a
beacon (scaled), and an empty state's drawing has its mast lamp blinking with the site's (stepped). Busy states
(a spinner, a skeleton line, Mission's acquiring line and satellite, Training's downlink) move only while something is
being waited for. The tab's title changes once a second only while it counts to an event inside the hour or a running
study timer.

## Less motion

When the device asks for less motion (`prefers-reduced-motion`), the tokens take all travel out (`--m-rise`,
`--m-travel`, `--m-press-y` 0, `--m-press-s` 1, no overshoot, sweeps instant), and the keyframes that move without
travelling (wipes, scans, pops, stamps, the photo settling) are defined again as quick fades. So nothing travels,
rolls, sweeps, springs or drifts, but what appears or changes still fades, quickly, so no change is missed. Nothing
moves by itself: no drift, no blinking. (The tab's title still counts: it's words, not motion.)

## Adding motion to something

1. Use the tokens and the shared pieces: `Presence` for anything that's removed when it closes, `Readout` for a figure
   that changes, `useGlide` and a `<span className="glide" />` for a row with an active item, `useSettled` for a list
   that items are added to.
2. Animate `opacity`, `translate`, `scale` and `clip-path`, not layout (`width`, `height`, `top`) or `filter`, except a
   meter's own width or height changing. In Vista, never fade or filter an element that has glass inside it: animate
   the glass panel itself.
3. Ask what it shows. A move that doesn't say what changed is decoration; leave it out.
4. Check it in every design, at desktop, wide and phone sizes, and with less motion on.

Ideas for more motion, kept for later, are at the end of [`mission-layout.md`](mission-layout.md) ("Ideas to push it
further"); the ones marked *(every design)* belong to all of them, not only Mission.
