<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/graticule-logo-dark.svg" />
    <img src="docs/media/graticule-logo.svg" alt="Graticule logo" width="88" />
  </picture>
</p>

<h1 align="center">Graticule</h1>

<p align="center">Graticule turns oscilloscope screenshots into clean plots and real data.</p>

<p align="center">
  <a href="https://sunsind.github.io/Graticule/"><strong>Open Graticule</strong></a><br />
  Runs in your browser. Nothing to install.
</p>

<p align="center">
  <picture><img src="docs/preview-before-after.png" alt="Original scope screenshot next to the clean plot in dark mode" width="100%" /></picture>
</p>

<p align="center">
  <picture><img src="docs/preview-app.png" alt="The Graticule app in dark mode" width="100%" /></picture>
</p>

<details>
<summary>Light mode screenshots</summary>

<p align="center">
  <picture><img src="docs/preview-before-after-light.png" alt="Original scope screenshot next to the print ready clean plot" width="100%" /></picture>
</p>

<p align="center">
  <picture><img src="docs/preview-app-light.png" alt="The Graticule app in light mode" width="100%" /></picture>
</p>

</details>

Drop a screenshot from your scope or take a photo of the screen on your phone, click Extract, and you get a print ready plot, a CSV of every trace, and a measurement table you can paste into Word or LaTeX. Everything runs in your browser, so your files never leave your device.

## What it does

- Reads the grid, the time scale and the volts per division from the screenshot
- Extracts every visible analog channel as time and voltage data
- Measures Vpp, Vmax, Vmin, Vavg, Vrms, period, frequency, duty cycle and the phase between the first two channels
- Measures rise time from 10 to 90%, fall time and overshoot on square waves
- Compares its numbers with the scope MEASURE bar on Siglent SDS2000X Plus
- Adds a math channel like `C1 - C2`, `C1 + C2` or `C1 × C2`
- Shows any two channels in XY mode, with the Lissajous phase and the Schmitt trigger thresholds
- Shows the spectrum of a channel with its fundamental, its harmonics and its THD
- Puts X1, X2, Y1 and Y2 cursors on the clean plot and reads Δt, 1/Δt, ΔV and phase
- Straightens tilted phone photos with a 4 corner box
- Builds a Bode plot from a folder of captures and finds the `-3 dB` cutoff, or both cutoffs for a band pass filter
- Exports a whole lab report as one zip with every plot, every CSV and the tables in Markdown, LaTeX and HTML
- Exports SVG, 2x PNG, CSV and tables for Word, Markdown, LaTeX or TSV
- Copies the plot straight to your clipboard so you can paste it into a report
- Works in English and French

## How to use it

1. Open the app
2. Drop a screenshot, paste one with Ctrl+V, press O, or click Add
3. Click Extract when you are ready. Nothing runs before that
4. Check the scales on the right and fix them if needed. The plot updates by itself
5. Pick a view at the top of the plot. Press 1 to 5 to switch faster
6. Zoom with the slider or with Ctrl and the mouse wheel. Click the zoom percentage to go back to 100%
7. Export with the buttons at the bottom right. Original and Overlay export the clean waveform, while Clean, XY, FFT and Bode export the view you are looking at

No screenshot handy? Click Try a sample on the empty screen to load a real scope capture, then click Extract.

Add several files or a whole folder, or tick two or more captures in the history. Then click Extract Bode to make a Bode plot, or Export all (.zip) to get a lab report.

## Views

After Extract, one row of tabs switches the view. The buttons next to the tabs change with the view, so you only see what you need.

| Tab | Key | What you see | Buttons |
| --- | --- | --- | --- |
| Original | 1 | Your screenshot | Crop, Zoom |
| Overlay | 2 or T | The extracted traces drawn 1:1 on top of your screenshot | Crop, Zoom |
| Clean | 3 | The print ready plot | Cursors, Zoom |
| XY | 4 | One channel against another | X, Y, Swap, Zoom |
| FFT | 5 | The spectrum of one channel | Channel, Window, Scale, Zoom |

The XY tab only shows up when two or more channels are on. The math channel counts.

## Math channel

Click `+ M` under Channels when two or more channels are on. Pick the two channels and the operation, like `C1 - C2` for the voltage across a part. The scale is set by itself, and you can type your own V/div or label. Untick M to remove it.

The math channel shows up on the plot, in the results, in the CSV, in the tables, in XY mode and in the FFT.

## XY mode

XY mode puts one channel on each axis, like the XY mode of a real scope. Swap flips the two axes. The results show the range of each axis, the phase from the Lissajous figure when both signals are sine waves, and the low and high thresholds of a Schmitt trigger when the plot is a hysteresis loop. Gaps and clipped parts are left out and the results tell you about them.

## Spectrum and THD

The FFT tab shows the spectrum of one channel in dBV or in volts. Pick the window that fits your signal. Hann is a good default and Flat top gives the most accurate peak heights.

The results show the fundamental, the THD up to H10 and the H2 to H5 harmonics in dBc. The dashed line is a fixed guide 50 dB below the peak. Values under it are pixel noise, so a very clean sine shows a THD below 0.5%. When the THD cannot be trusted, like on a clipped signal or with too few cycles, Graticule says why instead of showing a number.

## Lab report zip

Tick two or more captures in the history and click Export all (.zip). Graticule extracts the ones that are not done yet, then downloads `graticule-report.zip` with:

- `report.md`, `report.tex` and `report.html`, with a section, a figure and a table for each capture
- every plot as SVG and 2x PNG, and every trace as CSV, in the `captures` folder

Each capture keeps its own title and labels. Open the HTML file in Word or paste the LaTeX into your report.

## Cursors

Click Cursors or press C on a clean plot. Two dashed lines measure time and two dotted lines measure voltage. Drag them with the mouse or your finger, or click one and move it with the arrow keys. Hold Shift to move faster.

The bar above the plot shows X1, X2, Δt, 1/Δt, Y1, Y2 and ΔV. When the channel has a period, it also shows the phase between X1 and X2. Pick the channel from the menu on the left of the bar when more than one trace is on.

While the cursors are on, they are also drawn in the SVG, the PNG and the copied plot.

## Report ready figures

Type a title in the Export panel to replace the file name on the plot. Give each channel a label like Vin or Vout under Channels. The title and the labels show up in the SVG, the PNG, the CSV and the copied tables, and the title also names the files you download.

Bode plots have their own title field too. It goes on the Bode plot, in the CSV and in the tables, and it names the SVG and CSV files.

Click Copy or press Ctrl+C to copy a white 2x PNG of the plot. Paste it right into Word, Google Docs or PowerPoint.

Copy table gives you the measurements for Word, Markdown, LaTeX or TSV.

## History

Every capture you add stays in the history on the left, with its scales, its title, its labels, its cursors and its result. Click one to open it again. The history is saved in your browser, so it is still there after a refresh. It keeps your last 50 captures.

Clear asks you to confirm before it deletes anything. Turn off Keep history at the bottom of the history panel to stop saving. On a phone the history panel sits at the bottom of the page and only shows up once you add a capture, so add one first to reach Keep history. Your saved captures are deleted right away, and the ones from this visit stay open until you close the tab.

## Phone photos

On phones and tablets, tap the camera button to take a photo of the scope screen. Big photos are scaled down to 1920 px and turned the right way up. Graticule then checks the photo, and if it is blurry, tilted, low contrast, too small or has glare, it tells you what to fix. You can retake the photo or use it anyway.

When a photo is tilted, click Straighten. Drag the 4 corners onto the 4 corners of the grid and click Apply crop. Graticule flattens the grid before it reads the traces, and the 1:1 overlay still lines up with the tilted photo.

A real screenshot from the scope always gives better results than a photo.

## Supported scopes

| Scope | Support |
| --- | --- |
| Siglent SDS2000X Plus | Native |
| Rigol DS1054Z | Native |
| Siglent SDS1000X E | Partial (falls back to universal) |
| Rigol DHO924 | Partial (falls back to universal) |
| Rohde & Schwarz RTB2004 | Partial (falls back to universal) |
| Tektronix DPO7104C | Partial (falls back to universal) |
| Siglent SDS800X HD | Partial (falls back to universal) |
| Keysight DSOX1000 | Partial (falls back to universal) |
| Anything else | Universal mode with a crop box |

Partial scopes are read on their own when the screenshot matches a layout we tested. With any other layout, Graticule drops cleanly into universal mode so you can place the crop box yourself.

Native and partial scopes are found by themselves. You can also pick one by hand in the Profile menu. Siglent screenshots saved with inverted colors, with a white background, are read too.

In universal mode you drag the crop box onto the edge of the grid, then type the time scale and the volts per division. Click Cancel or the Clean tab if the box is already right. Crop has two shapes. Rectangle is best for screenshots and 4 corners is best for photos.

## Honest data

Graticule never guesses what it cannot see. When a trace is clipped, hidden by a cursor or a menu, or crosses another trace, that part is marked instead of filled in.

- The plot shows a dotted mark where data is missing
- The CSV leaves the cell empty and says why, like `clipped_high`
- In Bode mode, bad captures stay in the table with a reason and are never joined to the curve
- When an edge is too fast to measure, the rise or fall time shows as less than the value Graticule can see

## Shortcuts

| Key | Action |
| --- | --- |
| O | Add images |
| Ctrl+V | Paste a screenshot |
| E | Go to exports |
| 1 to 5 | Original, Overlay, Clean, XY, FFT |
| T | Show or hide the 1:1 overlay |
| C | Show or hide the cursors |
| Ctrl+C | Copy the plot |
| Ctrl and wheel | Zoom the plot |
| Arrows | Move a crop corner or a cursor |
| Enter | Apply the crop |
| Escape | Cancel the crop or what you are typing |
| ? | Show or hide the shortcuts |

## Offline

Graticule works without internet. After your first visit the website keeps working offline, and you can install it like an app from your browser. When a new version comes out, the app updates itself the next time you open it online.

You can also download `graticule-portable.html` from the latest release. It is one file that opens in any browser, with no install and no internet.

## Command line

The same engine runs in Node and gives the exact same CSV as the browser.

```sh
npm run cli -- capture.png --csv --out capture.csv
npm run cli -- capture.png --csv --title "Lab 3 Schmitt trigger" --out capture.csv
npm run cli -- capture.png --svg --locale fr --out capture.svg
npm run cli -- capture.png --table --format latex
npm run cli -- photo.png --deskew 120,80,1800,60,1820,1010,100,1030 --csv --out photo.csv
npm run cli -- --bode ./sweep --table
npm run cli -- capture.png --math sub --math-a C1 --math-b C2 --csv --out math.csv
npm run cli -- capture.png --xy C1,C2 --svg --out xy.svg
npm run cli -- capture.png --fft C1 --window hann --table
npm run cli -- capture.png --decode uart --channel C1 --baud auto --table
npm run cli -- compare capture.png scope.csv --channel C1
npm run cli -- compare capture.png scope.csv --channel C1 --csv-column "CH1 Voltage"
```

`compare` checks a screenshot against the CSV saved by the scope itself and tells you how far apart they are. Add `--csv-column` to pick the scope CSV column by its label. `--decode uart` reads the bytes of a serial signal from the trace.

To use it without the source code, download the `.tgz` file from a release and install it once.

```sh
npm install -g ./graticule-2.0.6.tgz
graticule --version
```

## Accuracy

Measured across synthetic ground truth, 28 local Siglent captures, 18 public web screenshots from multiple scopes, and a public Rigol PNG and CSV capture pair.

| Check | Result |
| --- | --- |
| Synthetic ground truth (7 captures) | 0.24 px median vertical error (0.48 px p95), 0.015% median Vrms error |
| Siglent SDS2000X Plus | 28 of 28 local captures and 2 public captures matched |
| Rigol DS1054Z | 9 public captures matched, 0.57 px median error on C1 versus scope CSV |
| Other scopes and schematics | 7 public captures sent cleanly to universal mode with zero false matches |
| Active filter sweep (10 captures) | 10 of 10 accepted, 990 Hz cutoff, 0.003 dB median gain error |
| Browser and CLI | Exact same CSV byte for byte |

## Development

You need Node 22 or newer.

```sh
npm install
npm run dev
npm test
npm run build
npm run build:portable
```

Built with Vite and React. The engine in `src/core` has no browser or Node dependencies and runs in a Web Worker.
