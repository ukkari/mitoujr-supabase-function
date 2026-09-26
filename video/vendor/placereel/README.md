# PlaceReel engine subset

Copied from [ukkari/placereel](https://github.com/ukkari/placereel), commit
`2f4582c69885682385b861cb0c13efb1cf84d6de` (2026-09-26 fetch).

These JavaScript files are unmodified copies of `public/engine/`:

- `timeline.js`: 120 BPM clock
- `kit.js`, `assets.js`: canvas, typography, easing, palette helpers
- `energy.js`, `fx/overdrive.js`, `fx/transition.js`: beat-driven effects
- `audio.js`: synthesized score and synchronized sound effects
- `voice.js`: pitch-preserving WSOLA time stretching

The Mattermost source adapter, Gemini Japanese storyboard/TTS client, Japanese
renderer, and unattended Chromium/FFmpeg exporter live outside this directory.
No Google Maps scraper, external photo proxy, location data, or map tiles are used.
The upstream repository does not contain a LICENSE file; this is a task-specific
reuse requested by its owner, not a declaration of an open-source license.
