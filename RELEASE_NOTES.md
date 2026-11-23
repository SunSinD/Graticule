# Graticule 2.0.1

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

A small release that fixes bugs found in 2.0.0.

## Lab report zip

- Clicking Clear while Export all (.zip) is running now stops the export. No zip is downloaded and the progress message goes away
- The math channel is now part of the zip, in the plots, the CSV files and the report tables

## Math channel

- You can now type your own V/div for a `C1 × C2` channel, like `5 V²`
- Picking the channel already used on the other side now swaps the two channels instead of doing nothing
- Vpp and Vrms no longer show a plus sign, and a rise time at the limit of the screen now shows `<` like the other channels
- Pressing Escape in a label or scale field now undoes your typing and keeps the cursor in the field

## Bode

- The Bode title now shows on the plot and goes in the downloaded CSV and tables
- Your zoom level is kept when you open a point with Inspect and come back to the Bode plot

## Views

- The FFT tab only shows up when there is a channel to analyze
- When you turn off a channel that XY or FFT needs, Graticule goes back to the Clean view
- XY and FFT show a short message while they load instead of the original screenshot
- The Schmitt trigger thresholds in XY mode now use V² when the X axis is a `×` math channel

## Accuracy

- More accurate FFT, THD, XY, UART decode and scope CSV compare results in edge cases
- The FFT table and the THD messages are now fully translated in French
- The French rise time row now says 10 to 90% like the English one

## Phones

- The `+ M` button, the channel buttons and the math channel fields are bigger and easier to tap

## Credits

Made by SunSinD. MIT license.
