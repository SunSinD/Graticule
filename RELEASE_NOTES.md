# Graticule 2.0.5

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

A fix release. It makes the app more reliable, a few measurements more accurate and the release process safer.

## App and reliability

- Adding images quickly one after another no longer mixes up their previews
- A folder drop with a file the browser cannot read now skips that file instead of stopping the whole drop
- Picking more than 50 images now shows a clear notice
- Export all skips captures that are still being read again, and it stays available in Bode view
- The saved history closes cleanly when another tab updates the app
- Math and FFT warnings now show up in the app
- Keyboard focus comes back to the right place after Crop Apply, Crop Cancel and Clear
- Cursor sliders read out their real values, and the center snaps to `0 s`
- Scales that make no sense are rejected
- The shortcuts list is up to date
- French and English wording is cleaner

## Accuracy and command line

- On a white background, yellow and green traces stay visible because both normal and inverted trace colors are checked
- Cropped Rohde and Schwarz RTB2004 captures line up with `--hdivs`
- Photos of scopes with a dark frame are checked for contrast more reliably
- FFT ticks on a linear scale are rounded
- Unit reading from the screen is stricter
- UART CSV keeps negative times as numbers
- `--baud` rejects hex and scientific values
- XY, UART and compare tables follow `--locale fr`
- New `--version` option

## Workflows and packaging

- The live site only updates after type checks, tests and bundle checks pass
- A release now checks that these notes match the version and runs every browser test
- `esbuild` is pinned in the dev packages

## Credits

Made by SunSinD. MIT license.
