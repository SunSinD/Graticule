# Graticule 2.0.2

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

A small release that cleans up the XY and FFT views and fixes a few bugs found in 2.0.1.

## XY and FFT

- XY axes now use round tick values that are easy to read
- The FFT view zooms in on the harmonics so they are readable, and the harmonic labels no longer overlap
- In dark mode, the XY and FFT plots now blend into the page with no light box around them

## Accuracy

- UART decode now finds the right baud rate on a `0x55` byte
- Scope CSV compare now matches columns named `C1_V` and `C2_V`
- The command line tool now checks the units you type and tells you when one is wrong

## Docs

- The supported scopes table in the README is now honest. Siglent SDS2000X Plus and Rigol DS1054Z are native, and the other 6 scopes are partial and fall back to universal mode when the layout does not match
- The README explains which view each export button saves and what the dashed FFT line means
- New screenshots of the app

## Credits

Made by SunSinD. MIT license.
