# Project Red Horizon – SOLMAP presentation

Animated [reveal.js](https://revealjs.com) version of the *Project Red Horizon* deck (SOLMAP, Challenge #14).

## Run
Open `index.html` in a browser, or serve the folder:

```bash
cd presentation && python3 -m http.server 8000
```

## Controls & effects
- → / Space / click arrow: next. Every slide's elements fly in when it appears.
- On slides with a rocket (title, "Awesome Planet" shuttle, "Thanks"), the first "next" launches it off the top of the slide with an exhaust trail; smoke keeps billowing behind it until you press "next" again to change slide. Between slide 1 and 2 the smoke rises until it fills the whole screen, and slide 2 appears as it clears.
- reveal.js 5.1.0 is bundled in `lib/` so it works offline.

Template credits: Slidesgo, Flaticon, Freepik.
