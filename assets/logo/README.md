# The mark

The source is `packages/web/public/favicon.svg` — the document with a link node
hanging off it. That SVG is the original; these PNGs are renders of it, kept here
because directory submissions and app listings want raster files at fixed sizes
and will not take an SVG.

| File | Use |
| --- | --- |
| `open-artifact-logo-1024.png` | Directory submissions. Start here; most want 512 or larger |
| `open-artifact-logo-512.png` | App listings, README headers |
| `open-artifact-logo-256.png` | Anywhere small |
| `open-artifact-icon-128.png` | The ChatGPT composer icon. Its floor is 48, but the file is what gets scaled, so give it the headroom |
| `open-artifact-icon-96.png` | A middle size, if something asks for one |
| `open-artifact-icon-48.png` | The stated minimum, for anything that insists on it exactly |

The mark was drawn for a 32px browser tab, so it survives being small: at 48
the document, its three lines and the link node are all still separate things.
That is the reason not to redraw it for small sizes.

## Regenerating them

If the mark changes, the SVG changes and these have to be rebuilt from it, or
they quietly become a different logo.

```bash
# Quick Look renders an SVG at its declared size, not the size you ask for, so
# the declared size is rewritten first. Without this you get a 32px mark sitting
# in the corner of a 1024px canvas.
sed 's|width="32" height="32"|width="1024" height="1024"|' \
  packages/web/public/favicon.svg > /tmp/big.svg
qlmanage -t -s 1024 -o /tmp /tmp/big.svg
mv /tmp/big.svg.png assets/logo/open-artifact-logo-1024.png

for size in 512 256; do
  sips -z $size $size assets/logo/open-artifact-logo-1024.png \
    --out assets/logo/open-artifact-logo-$size.png
done
```

macOS only, but it needs no dependencies — `qlmanage` and `sips` are both in the
box. On Linux, `rsvg-convert -w 1024 -h 1024` does the same job in one step.
