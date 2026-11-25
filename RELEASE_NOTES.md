# Graticule 2.0.9

Try it live at [sunsind.github.io/Graticule](https://sunsind.github.io/Graticule/).

Download [the offline HTML file](https://github.com/SunSinD/Graticule/releases/latest/download/graticule-portable.html) to use it on a PC with no internet and nothing to install.

## New

- BMP screenshots are read directly in the browser, in the background worker and in the command line, including `--bode` folders and `compare`
- The command line `.tgz` now carries everything it needs, so `npm install -g --offline ./graticule-2.0.9.tgz` works on a PC with no internet. It needs Node 22 or newer
- A quiet Offline copy link next to the source code link downloads the HTML file. It is hidden when you already use the HTML file

## Hantek DSO2000 fixes

- The C3 trigger arrow no longer leaks into the extracted traces
- A crop that is not centered on the grid keeps the right scales
- Graticule now says when it found a Hantek grid and asks for the time and volt scales shown on the scope
- The hidden area percentage in the JSON output now counts the Hantek annotations and trigger marker

## Scale fields

- A time unit typed in a volt field, or a volt unit typed in a time field, is refused instead of read as a number
- The plus and minus buttons stop at the largest and smallest scale a field accepts

## Docs

- The README links straight to the offline HTML file and explains the three ways to use Graticule offline
- The README and release notes pass the prose check 100%

## Credits

Made by SunSinD. MIT license.
