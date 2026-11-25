# Graticule 2.0.10

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

Download [the offline HTML file](https://github.com/SunSinD/Graticule/releases/latest/download/graticule-portable.html) to use it on a PC with no internet and nothing to install.

## App and history

- After an update, the offline copy in your browser always loads the new files instead of old cached ones
- Two open tabs no longer erase each other's title and channel label edits, and clearing history during startup stays cleared
- When browser storage is full, Graticule says so and keeps the capture open for this session

## Files

- 32 bit BMP files with an empty alpha channel now show their real colors
- BMP files with slightly wrong header sizes are still read

## Bode and exports

- The Bode cutoff is no longer taken from a later bounce after a missing point
- Scope CSV files split by semicolons or tabs can use decimal commas
- CSV fields that contain a semicolon are quoted, and small voltage changes on a large DC offset keep their precision
- Special characters in titles and labels are escaped in LaTeX and Markdown tables

## Command line

- `--out folder/` writes into that folder
- UART timestamps keep their full precision

## Interface

- The fallback profile badge reads Universel in French
- Volt scales such as 500 mV fit in the channel cards on desktop
- Crop handles at the image edges no longer make the page jump
- Dragging the whole 4 corners box works on Android phones
- The shortcuts dialog scrolls on short or zoomed screens
- fflate is pinned to 0.8.3

## Credits

Made by SunSinD. MIT license.
