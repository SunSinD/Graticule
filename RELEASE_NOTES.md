# Graticule 1.1.1

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

A fix release that cleans up the app on phones and fixes small bugs found after 1.1.0.

## Phones

- The empty screen on a phone now only shows the Add images and Take photo buttons, centered, with no empty panels below
- The history only shows up on a phone once it has something in it
- The top bar stays on one row. The shortcuts button is gone on phones and tablets, and the Add and camera buttons in the top bar only show up once a capture is open
- The empty screen says Add an oscilloscope screenshot or take a photo on phones, since there is nothing to drop or paste
- The plot buttons fill clean full rows on a narrow screen, with no sideways scrolling
- Dragging a cursor with your finger moves the cursor instead of scrolling the page

## Fixes

- Escape now really cancels what you typed in the title, a channel label or a scale field
- The phase between cursors stays between 0 and 360°
- Pressing C while the crop box is open no longer throws away the corners you moved
- The 4 corners message now says the corners must make a convex box, placed clockwise from the top left
- When a crop box is open and the extraction finishes, the box moves to the screen it found, unless you already moved it
- Unticking or removing captures in Bode mode opens the one left, not a capture you had open before
- Changing the scope or the gate while a Bode plot is still working no longer gets stuck on Working or loses your change
- A capture opened from the Bode table keeps its title and channel labels in the exports
- Copying the plot works in more browsers

## Exports

- The title you type now names the downloaded SVG, PNG and CSV files and shows up on the copied tables
- File names are made safe for Windows, macOS and Linux
- Safer escaping in CSV, TSV, Markdown, LaTeX and SVG when titles or channel labels have special characters

## Measurements, Bode and offline

- Fixed ringing overshoot math so damped steps measure the settled level, and smooth sine or triangle waves no longer get fake step times
- Bode plots handle duplicate frequencies, band stop crossings and manual edits kept across gate changes
- Checksum checks reject corrupt PNG files, and 4 corner deskew checks that the corners start at the top left
- Improved channel reading on Keysight DSOX1000 and trigger masking on Siglent SDS800X HD
- Offline mode precaches the whole app on your first visit, including the extraction worker, so extractions work offline right away
- `graticule-portable.html` runs cleanly whether opened as a local file or from a local server
- Hardened command line output checks so bad paths never leave partial files

## History

- The history remembers which captures you opened last, even after a reload, so the oldest ones go first when it is full
- When the browser storage is full, Graticule makes room by removing the oldest saved captures, then saves again
- A capture is only marked as saved once the browser storage really has it

## Credits

Made by SunSinD. MIT license.
