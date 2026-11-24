# The Mission layout

Launchpad's default layout (design key `mission`): the page is a launch site. Its sky follows the hour and the
weather, the pad stands on the horizon, the day climbs across the sky as an ascent with a launch clock counting to the
next event, the console is glass, and the rocket launches when the last of the day's tasks is ticked.

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
| Home's columns | `MISSION` in `web/src/layout.ts` |

The other layouts are untouched. What Mission adds to shared components is small and inert elsewhere: the rail takes
an optional `brand`, the top bar an optional `lead` (the hero in place of the greeting) and a row of source lights
that only Mission shows.

## Built, against the design system

- The sky by theme, the sun or moon on its arc by the clock, the horizon's glow near rising and setting, stars and
  twinklers, clouds, a satellite or a contrail now and then, cloud and rain from the forecast.
- The site: tower, masts with blinking lamps, water tower, floodlights at night, the vehicle venting.
- The day's ascent with its waypoints and the vehicle on it, burning.
- The launch clock (T- to the next event, T+ during one, the time of day when nothing is left).
- Glass panels with the pointer's light on them; the strip with its gliding selector; the phone's dock.
- A light per source of data, reporting in turn as the app opens.
- The launch: on the last of the day's tasks, and on the mark when already on Home.
- Reduced motion: the sky still shows the hour; nothing moves and nothing launches.

## Not built yet (in the design system, not in the app)

- **A parcel's flight** (Trajectory): the four-stage arc at the end of a parcel's row. Packages still show their four
  segments.
- **Telemetry**: the stepping strip chart for live readings on Server.
- **The three empty-state drawings** (pad clear, vehicle away, launch scrubbed).
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
4. **The countdown's last ten seconds.** A soft pulse ring from the clock on each second, and the vehicle on the
   ascent brightening. Nothing loud.
5. **Staging.** As each event ends, the vehicle on the ascent sheds a spent stage that falls away and fades.
6. **A recovery.** After a launch, minutes later, a far point of light comes back down to the horizon and lands.
7. **Parcels arriving as landings.** "Out for delivery" puts a small descending light in the sky; "Delivered" lands
   it beside the pad.
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
