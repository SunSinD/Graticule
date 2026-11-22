# Graticule

Graticule turns oscilloscope screenshots into clean plots and real data. Drop a PNG from your scope and you get a print ready plot, a CSV of every trace, and a measurement table you can paste into Word.

Everything runs in your browser. Your files never leave your computer.

## What it does

- Reads the screen layout, the time scale and the volts per division straight from the screenshot
- Extracts every visible channel as time and voltage data
- Measures Vpp, Vmax, Vmin, Vavg, Vrms, period, frequency, duty cycle and the phase between C1 and C2
- Compares its numbers with the values shown in the scope MEASURE bar, so you can see how far apart they are
- Builds a Bode plot from a folder of captures, finds the `-3 dB` cutoff and lets you fix any value by hand
- Exports SVG, 2x PNG, CSV and tables in Word HTML, Markdown or TSV
- Works in English and French, with a decimal comma in French

## Supported scopes

| Scope | Support |
| --- | --- |
| Siglent SDS2000X Plus | Full native profile |
| Rigol DS1054Z | Full native profile |
| Anything else | Universal mode with a crop box you place by hand |

In universal mode you drag the four corners of the crop box onto the outer edge of the grid and set how many divisions it has. Then type the time scale and the volts per division in the panel on the right.

## Honest data

Graticule never guesses where it cannot see. When a trace is clipped off the screen, hidden behind a cursor or a menu, or crosses another trace, that part is marked instead of filled in.

- In the plot, the line stops and a dotted mark shows the missing span
- In the CSV, the voltage cell is empty and the status column says why, for example `clipped_high` or `masked_cursor`
- In Bode mode, rejected captures stay in the table with a plain reason and are never joined to the curve

## Using it

1. Open the app
2. Drop a screenshot on the page, paste one with Ctrl+V, or press O to open a file
3. Drop several files or a whole folder to start a Bode batch
4. Check the detected profile and scales on the right, and change them if needed
5. Export with the buttons at the bottom right

You can also try one of the three samples on the start screen.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| O | Open a file |
| Ctrl+V | Paste a screenshot |
| E | Go to exports |
| T | Show or hide the 1:1 overlay |
| ? | Show or hide the shortcuts |

The 1:1 overlay draws what Graticule found right on top of your screenshot, so you can check it pixel by pixel.

### Scales

The time and volts per division steppers follow the same 1, 2, 5 steps as a real scope. You can also type a value like `200u`, `0,5 ms` or `2 V`.

## Command line

The same engine runs in Node, so the CSV from the command line matches the one from the browser byte for byte.

```sh
npm run cli -- capture.png --csv --out capture.csv
npm run cli -- capture.png --svg --locale fr --out capture.svg
npm run cli -- --bode ./sweep --table
```

With no output flag it prints a table.

## Accuracy and verification

Every bundled sample is checked against independent manual graticule counts within 3% on voltage, frequency, gain and phase.

| Check | Result |
| --- | --- |
| Siglent SDS2000X Plus local regression | 28 of 28 captures matched, including inverted and digital captures |
| Rigol DS1054Z fixture | Verified native grid, timebase and channel scale OCR |
| Active filter Bode sweep (10 captures) | 10 of 10 accepted, 4.03 dB passband, 990 Hz cutoff, R2 >= 0.998 |
| Browser and Node CLI parity | Identical CSV output byte for byte |
| Paired scope CSV bench check | Pending final bench captures before tagging 1.0.0 |

## Development

You need Node 22 or newer.

```sh
npm install
npm run dev
npm run typecheck
npm test
npm run test:e2e
npm run check:prose
npm run build
```

The web app is built with Vite and React. The extraction engine in `src/core` has no browser or Node dependencies and runs inside a Web Worker in the browser.

## License

MIT. Copyright 2026 SunSinD.
