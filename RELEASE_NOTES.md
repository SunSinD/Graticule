# Graticule 2.0.0

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

A big release with a math channel, XY mode, a spectrum view with THD, lab report exports and a cleaner layout.

## Views

- One row of tabs now holds every view: Original, Overlay, Clean, XY and FFT
- Press 1 to 5 to switch views. T still toggles the overlay and C still toggles the cursors
- The buttons next to the tabs change with the view, so there are never more than four
- Before Extract you only see your image and the Extract button

## Math channel

- Click `+ M` to add `C1 - C2`, `C1 + C2` or `C1 × C2`, or any other pair of channels
- The scale is picked by itself, and you can set your own V/div and label
- The math channel shows up on the plot, in the results, in the CSV, in the tables, in XY mode and in the FFT

## XY mode

- Plot one channel against another, like the XY mode of a real scope
- Swap the axes with one click
- The results show the range of each axis, the Lissajous phase for sine waves and the thresholds of a Schmitt trigger loop
- Export the XY plot as SVG, PNG or CSV

## Spectrum and THD

- The FFT tab shows the spectrum of any channel in dBV or in volts
- Pick a Hann, Rect, Flat top or Blackman window
- The results show the fundamental, the THD up to H10 and the H2 to H5 harmonics in dBc
- A dashed line marks the pixel noise floor. A very clean sine shows a THD below 0.5% instead of a fake number
- When the THD cannot be trusted, like on a clipped signal, the results say why
- Export the spectrum as SVG, PNG, CSV or a table

## Results

- The phase now works between any two channels, like C1 and C3, not only C1 and C2
- Rows with no value for any channel are hidden on screen. Exported tables stay complete

## Lab report zip

- Tick two or more captures and click Export all (.zip)
- Graticule extracts the ones that are not done yet and shows its progress
- You get `report.md`, `report.tex` and `report.html`, plus every plot as SVG and PNG and every trace as CSV

## Bode

- Bode plots have a title field. It goes on the plot and names the downloaded files
- Extract Bode still works the same way

## Layout

- The empty screen on a computer no longer shows a side panel full of empty fields
- On phones, a capture menu at the top lets you switch captures without scrolling down
- On phones, the Profile and scale settings fold into a Settings section so the results and exports stay close
- Status messages sit right above the plot on phones

## Scopes

- Siglent screenshots saved with inverted colors are now read correctly

## Command line

- `compare` checks a screenshot against the CSV saved by the scope
- `--decode uart` reads serial bytes from a trace
- `--math`, `--xy` and `--fft` give the same results as the app

## Credits

Made by SunSinD. MIT license.
