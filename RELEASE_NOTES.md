# Graticule 1.1.2

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

A fix release for offline mode, phones, Bode plots and the history.

## Offline

- Offline mode now serves the app from its own cache every time, so a reload with no connection opens Graticule instead of an error page
- The icons and the app manifest still work offline and update quietly in the background when you are online
- `graticule-portable.html` now shows its icon when opened from a local server too

## Phones

- With cursors on, swiping an empty part of the plot scrolls the page again. Dragging a cursor line still moves the cursor
- The 4 corners message in the crop bar gets its own full row on a narrow screen instead of being squeezed into a thin column

## Keyboard

- Escape closes the crop box, even when the Crop button still has focus
- Opening a point from the Bode table moves focus to Back to Bode, and going back puts focus on that point again
- Pressing E when the export buttons are not ready yet now shows a visible focus ring on the Export panel

## Bode and measurements

- Changing the scope profile on a Bode plot keeps your manual frequency edits
- Changing the input or output channel on a Bode plot clears old voltage, gain and phase edits from the previous channel pair
- When only one cutoff is found, the summary says if it is the lower or the upper cutoff, like the plot and the exported tables
- Bode points from a capture that could not be read are shown as rejected instead of stopping the whole plot
- Time scales too large to work with now give a clear error instead of wrong numbers
- Edge measurements like rise time, fall time and overshoot are more accurate
- CLI deskew with a scope profile now uses that scope's grid divisions

## Files

- PNG files are now checked with the zlib checksum too, so a damaged image is rejected instead of giving a broken plot

## History

- Moving a cursor right as a new extraction starts can no longer save the capture without its result
- Undoing an edit while the save is still running now saves the right version
- Turning off Keep history while a capture is being saved no longer leaves it in the browser storage

## Credits

Made by SunSinD. MIT license.
