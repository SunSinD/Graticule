# Graticule 2.0.8

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

Download the portable HTML file below to use it offline in a desktop browser.

A small fix release for Hantek screenshots and manual scales.

## Fixes

- Universal mode finds the grid on some 800 × 480 Hantek screenshots and skips the yellow readouts and trigger marker. Enter the time and voltage scales shown on the scope
- Cropping within the detected grid keeps the correct division spacing, and reopening the crop restores the guides
- An aligned 4 corners crop gives the same result as a rectangle crop on these captures
- Clean plots and SVG exports use the detected grid for voltage labels and division spacing
- Pressing Enter on an unread time or voltage scale confirms the value shown
- The portable HTML file has no separate icon file to load and shows when capture history can only be kept for the current session

## Docs

- The README links directly to the portable file and release downloads
- Use the scope waveform export whenever possible. A screenshot provides estimated data

## Credits

Made by SunSinD. MIT license.
