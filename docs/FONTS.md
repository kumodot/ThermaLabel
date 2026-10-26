# Fonts

All fonts live in `fonts/` and are embedded in `css/fonts.css` as base64 WOFF2 (regenerate with `python tools/make_fonts_css.py`) (latin subset, which covers Portuguese,
Spanish and French accents). Files come from the Fontsource packages on npm (v5.3.0).

| Font | Weight | License |
|---|---|---|
| Inter | 400, 700, 900 | SIL Open Font License 1.1 |
| Roboto Condensed | 700 | SIL Open Font License 1.1 |
| Bebas Neue | 400 | SIL Open Font License 1.1 |
| Archivo Black | 400 | SIL Open Font License 1.1 |
| Fredoka | 600 | SIL Open Font License 1.1 |
| Caveat | 700 | SIL Open Font License 1.1 |
| Permanent Marker | 400 | Apache License 2.0 |
| Pacifico | 400 | SIL Open Font License 1.1 |
| Space Mono | 700 | SIL Open Font License 1.1 |

Both licenses allow embedding and redistribution with the app.

Thin or light weights were left out on purpose: at 300 dpi, 1-bit, thin strokes break up.
