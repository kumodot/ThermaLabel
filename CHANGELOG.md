# Changelog

## 0.6.0 (2026-10-26)

- Renamed to **ThermaLabel**: a label maker for small Bluetooth thermal printers, not only the TP6-S.
- *Printer* selector with a driver interface (`js/drivers/`). Vretti TP6-S is the first driver; MUNBYN 130B planned.
- *Auto* transfer (new default): starts paced, switches to safe mid-print when credits come back slowly.
  Windows without the boost helper goes from ~90 s to about 30 s per 30 mm label.
- *About* dialog.
- Food label preset leaves more room inside double and thick frames; fitted text keeps a small side margin.
- Repo layout without a build step: `css/`, `js/`, `fonts/`, `index.html` redirect through `version.json`.
- Designs and templates from the TP6-S Label Maker 0.5.x are carried over when opened from the same place.
- Self-test with golden vectors from the vendor library (`node docs/selftest/selftest_tp6s.mjs`).

## 0.5.2 (2026-10-26)

- Paced transfer no longer uses setTimeout (stretched by background/efficiency throttling).
- Transfer diagnostics in the log.

## 0.5.1 (2026-10-26)

- Changing columns/rows and going back no longer shrinks text.

## 0.5.0 (2026-10-26)

- First label maker (as "TP6-S Label Maker"): editor, tiling, frames, fonts, date tokens, quick fill, templates.

## Probe and test pages (tools/probes)

- 0.4.3: paced transfer in the print test page.
- 0.4.0: first successful TP6-S print with the reverse-engineered protocol.
- 0.1.0 to 0.3.1: BLE probes (service discovery, ESC/POS, cat printer and Marklife guesses).
