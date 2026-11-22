# Graticule

Graticule turns oscilloscope screenshots into clean plots and real data.

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

Drop a PNG from your scope and you get a print ready plot, a CSV of every trace, and a measurement table you can paste into Word. Everything runs in your browser, so your files never leave your computer.

## What it does

- Reads the grid, the time scale and the volts per division from the screenshot
- Extracts every visible channel as time and voltage data
- Measures Vpp, Vmax, Vmin, Vavg, Vrms, period, frequency, duty cycle and the phase between C1 and C2
- Compares its numbers with the scope MEASURE bar
- Builds a Bode plot from a folder of captures and finds the `-3 dB` cutoff
- Exports SVG, 2x PNG, CSV and tables for Word, Markdown or TSV
- Works in English and French

## How to use it

1. Open the app
2. Drop a screenshot, paste one with Ctrl+V, or press O
3. Look at the clean plot right away, or switch to Original to see your screenshot
4. Check the scales on the right and fix them if needed
5. Export with the buttons at the bottom right

Drop several files or a whole folder to make a Bode plot. You can also start with one of the three samples.

## Supported scopes

| Scope | Support |
| --- | --- |
| Siglent SDS2000X Plus | Full |
| Rigol DS1054Z | Full |
| Anything else | Universal mode with a crop box |

In universal mode you drag the crop box onto the edge of the grid, then type the time scale and the volts per division.

## Honest data

Graticule never guesses what it cannot see. When a trace is clipped, hidden by a cursor or a menu, or crosses another trace, that part is marked instead of filled in.

- The plot shows a dotted mark where data is missing
- The CSV leaves the cell empty and says why, like `clipped_high`
- In Bode mode, bad captures stay in the table with a reason and are never joined to the curve

## Shortcuts

| Key | Action |
| --- | --- |
| O | Open a file |
| Ctrl+V | Paste a screenshot |
| E | Go to exports |
| T | Show or hide the 1:1 overlay |
| ? | Show or hide the shortcuts |

## Command line

The same engine runs in Node and gives the exact same CSV as the browser.

```sh
npm run cli -- capture.png --csv --out capture.csv
npm run cli -- capture.png --svg --locale fr --out capture.svg
npm run cli -- --bode ./sweep --table
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
```

Built with Vite and React. The engine in `src/core` has no browser or Node dependencies and runs in a Web Worker.
