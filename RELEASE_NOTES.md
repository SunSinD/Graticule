# Graticule 2.0.4

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

A fix release. It makes the saved history safer, the offline app more reliable and a lot of measurements more accurate.

## History and offline

- A capture that is too big to save no longer deletes your other saved captures. Graticule only clears room when the new capture really fits, and it stops trying again until the capture changes
- Two captures saved at the same moment no longer fight over the same space, and an older save can no longer replace a newer one
- Removing a capture or clearing the history is saved right away, even if you refresh the page just after
- After an update, the offline app no longer mixes files from the old and the new version, and tabs that were already open keep working
- A file the browser cannot store offline still loads instead of showing an offline error
- When the server has a problem, the app opens from its offline copy instead of showing an error page
- The offline cache now updates when the page itself or the app icons change

## App

- Notes about a channel now read as clean sentences, for example when the offset on screen does not match the zero marker or when a channel is not in volts
- Errors that have nothing to do with your file, like a report ZIP that fails, no longer start with Could not read this file
- Report ZIP file names made only of other alphabets, like Chinese, now fall back to graticule instead of png
- Very long file names are cut cleanly in the report ZIP
- En and em dashes in titles now work in the LaTeX report
- PNG files with photo data after the image data are now handled as photos and turned the right way up
- `.heif` files lose their extension in exported file names, same as `.heic`
- If part of the app fails to load once, it tries again next time instead of staying broken
- Installing the command line tool no longer pulls in the browser packages

## Accuracy

- Square waves are no longer mistaken for dashed cursors and masked out
- FFT is no longer thrown off by a tone below the main frequency, and THD is more accurate
- Scope CSV compare reads channel names written in full, and the new `--csv-column` option picks a CSV column by its label
- Cropped captures keep the right channel colors
- Rohde and Schwarz RTB2004 captures no longer lose the bottom of the grid, and their ticks are read correctly
- UART auto baud picks the right speed when two speeds look close
- Times in CSV and SVG files stay precise on captures with a large time offset
- Photos tilted up to 30 degrees are now caught and you are asked to straighten them
- Transparent pixels in PNG files are no longer read as scope labels or traces
- Siglent `-Duty` values are read correctly
- CSV, TSV and LaTeX exports escape special characters properly
- Recalculating a Bode sweep keeps the points you fixed by hand
- Bode reads the frequency from file names that have a dash separator before the number
- Very fast edges always show the same `<` symbol

## Credits

Made by SunSinD. MIT license.
