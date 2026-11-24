# Graticule 2.0.7

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

A fix and launch polish release.

## Fixes

- Bode reads the frequency from more file names, like `filter-1kHz.png`
- Compare reads the time unit from scope CSV headers like `Time (ms)`, and reads Tektronix CSV files with extra columns
- A quote in a title or a warning no longer breaks the comment lines at the top of a CSV
- The XY CSV keeps full time precision when rounding would give two points the same time
- UART decoding picks the right frame start more often when frames sit right next to each other

## History and offline

- Clearing the history in one tab and then renaming a capture in another tab no longer brings that capture back
- Two copies of Graticule hosted under different paths on the same site no longer delete each other's offline files

## Polish

- The empty screen has a small link to the source code on GitHub, so phone and tablet visitors can reach it too
- Links shared on social apps now show a title, a short description and a preview image
- The page title now says what Graticule does
- The French rise time label reads 10 à 90%
- The README has a Help add your scope section and a License section

## Credits

Made by SunSinD. MIT license.
