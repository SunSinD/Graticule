# Graticule 1.0.0

First public release. Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

## Highlights

- Native support for six scopes: Siglent SDS2000X Plus, Siglent SDS1000X E, Rigol DS1054Z, Rigol DHO924, Rohde & Schwarz RTB2004 and Tektronix DPO7104C
- Universal mode with a draggable crop box for any other scope
- A clear Extract button. Nothing runs until you ask, and changing a scale after that updates the plot by itself
- History that stays in your browser, with a Keep history switch to turn it off and delete it
- Zoom from 50% to 300% on plots and screenshots, and up to 250% on Bode plots
- Phone photos with a quality check that tells you when to retake the picture
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

## Offline and privacy

Everything runs in your browser. Nothing is uploaded and nothing is tracked. The website works offline after your first visit and can be installed like an app. `graticule-portable.html` is a single file you can open anywhere with no internet.

## Command line

The `graticule` command uses the same engine as the web app and gives the same CSV byte for byte.

## Credits

Made by SunSinD. MIT license.
