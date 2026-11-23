# Graticule 2.0.3

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

A small release that makes the app easier to try and easier to read on a phone.

## Try a sample

- The empty screen now has a small Try a sample button. It loads a real scope screenshot so you can see what Graticule does before you have your own
- The sample only stages the screenshot. Nothing runs until you click Extract, same as with your own files
- The sample is built into the app, so it works offline, in the portable file and with no network at all
- The button only shows when your history is empty, so it stays out of the way once you start using the app

## Phone

- The XY and FFT plots are drawn at a smaller size on narrow screens, so the axis and harmonic labels are readable on a phone without zooming
- Exported SVG and PNG files keep the full size, whatever screen you use

## Plots and accuracy

- The FFT plot now expands its frequency range when there is a strong tone above the main harmonics, and keeps the last tick at the edge of the axis
- XY plots leave less empty margin around the trace and show distinct labels on very narrow voltage ranges
- UART auto baud now handles repeated `E0` bytes cleanly
- Scope CSV compare prefers real waveform columns over offset columns and keeps units on repeated headers
- English gap labels now say hidden by a menu, matching the French wording

## Credits

Made by SunSinD. MIT license.
