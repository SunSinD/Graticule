# Graticule 2.0.6

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

A small fix and polish release.

## Fixes

- RGB captures keep a single channel that sits below zero instead of dropping it
- Export all in Bode view now uses the profile picked for the Bode plot, so the zip matches that plot exactly
- Dropping a file that is not an image, such as a text file, now says that only image files can be read instead of doing nothing
- Dropping images together with other files loads the images and quietly skips the rest

## Polish

- After Extract, keyboard focus moves to the Clean Plot tab instead of getting lost
- The shortcuts panel opened with `?` has a small link to the source code on GitHub
- Preview screenshots are refreshed for 2.0.6

## Credits

Made by SunSinD. MIT license.
