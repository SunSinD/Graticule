# Graticule 1.0.0

First public release.

## Highlights

- Turn a Siglent SDS2000X Plus or Rigol DS1054Z screenshot into data in under a second
- Universal mode with a draggable crop box for any other scope
- Measurements for every channel, plus a side by side check against the scope MEASURE bar
- Bode batch mode with gain and phase plots, the `-3 dB` cutoff, and a table where every cell can be edited
- 1:1 overlay to check the extraction right on top of the original screenshot
- English and French, with a decimal comma in French

## Exports

- SVG made for black and white printing. Each channel has its own line style so C1 to C4 stay readable without color
- 2x PNG for slides and reports
- CSV with a metadata header and a status column for every channel
- Tables in Word HTML, Markdown and TSV

## Honest gaps

Clipped, hidden or unclear parts of a trace are never joined or filled in. They show as dotted marks in the plot and as empty cells with a clear status in the CSV.

## Privacy

Everything runs in your browser. Nothing is uploaded and nothing is tracked.

## Command line

The `graticule` command uses the same engine as the web app and gives the same CSV byte for byte.

## Credits

Made by SunSinD. MIT license.
