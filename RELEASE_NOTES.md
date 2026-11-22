# Graticule 1.1.0

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

## Highlights

- Eight native scopes. New in this release: Siglent SDS800X HD and Keysight DSOX1000
- Measurement cursors on the clean plot. Press C, drag X1, X2, Y1 and Y2, and read Δt, 1/Δt, ΔV and phase. The cursors also go into the SVG and PNG exports
- 4 corner crop to straighten tilted phone photos. The Straighten button on the photo check opens it for you, and the 1:1 overlay still lines up with the original photo
- Copy the plot as a white 2x PNG with the Copy button or Ctrl+C, then paste it into your report
- A title for the plot and a label for each channel, like Vin and Vout. They show up in the SVG, the PNG, the CSV and the tables
- LaTeX tables next to Word, Markdown and TSV
- Rise time from 10 to 90%, fall time and overshoot in the measurements
- Band pass Bode plots now show the low and the high cutoff

## Fixes and polish

- Cancel, Crop and Clean Plot now close the crop box on scopes found in universal mode
- Bode batch mode keeps the crop and the scales you set on each capture
- Every cell in the Bode table saves when you press Enter or leave the cell. Escape puts the old value back
- Clear asks you to confirm before it deletes the history
- Opening a capture no longer rewrites it in the browser storage, and one broken saved capture can no longer wipe the rest
- The history keeps 50 captures even when you add more than 50 at once
- Crop corners are bigger for touch and move with the arrow keys. Enter applies and Escape cancels
- Smoother zoom with a trackpad. Click the zoom percentage to go back to 100%
- Photos stay smooth when zoomed out and only show sharp pixels when zoomed in
- The remove button in the history is always visible on touch screens
- Add and camera buttons in the top bar on phones
- The drop zone only shows up when you drag files
- Removing a capture from a Bode selection of two opens the one left
- Better French labels
- The keyboard stays inside the shortcuts window while it is open
- PNG and copy errors now show a message in the Export panel

## Offline and command line

- The offline app updates itself to the new version and cleans up old caches
- The `graticule` command can deskew a photo with `--deskew` and write LaTeX tables with `--format latex`

## Credits

Made by SunSinD. MIT license.
