# Graticule 1.1.3

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

A fix release for uploads, Bode plots, cursors, exports and the history.

## Uploads

- One damaged or unreadable image no longer cancels the whole upload. The other files are added and a message names the files that were skipped
- Choosing a new file after a bad photo can no longer delete the open capture by mistake when the pick fails
- Image previews are cleaned up properly, even when the page closes during an upload

## Bode

- A damaged PNG in a Bode batch shows up as a rejected row instead of stopping the whole batch
- You can type a frequency and a gain for that row, and it joins the plot as a manual point
- Opening that row explains why it could not be read, and the export buttons stay off instead of exporting the whole Bode plot
- The cutoff in the summary shows a dash before anything is extracted, instead of saying not found
- Sine fits stay accurate at very high frequencies and very small voltages

## Cursors

- Two cursors on the same spot now read exactly 0 for Δt and a dash for 1/Δt, instead of tiny leftover numbers
- A cursor move right before a reload, a tab switch or closing the app on a phone is saved right away instead of being lost

## Exports

- Your custom title now goes into the CSV file too, on a `# title:` line
- The CLI takes `--title` for the waveform CSV
- Scale steps keep working on very large and very small values

## Files

- Interlaced PNG files are now read by the core decoder
- Damaged PNG files are rejected with a clear error instead of giving a broken plot

## History

- Saved captures with missing parts are ignored when the app loads instead of breaking a view
- The app still opens when the browser blocks storage, like in some private windows or embedded pages

## Credits

Made by SunSinD. MIT license.
