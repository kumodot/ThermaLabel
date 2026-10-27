# Changelog

## 0.7.1 (2026-10-26)

- Each label remembers the size it was designed for. Changing columns, rows or printer rescales from that size,
  and designs that don't match the current layout (older saves, templates made for another printer) fix
  themselves when opened. Before, labels could end up wider than their cell after several layout changes.
- MUNBYN 130B Bluetooth: uses the ISSC UART print service (the one MUNBYN's own web editor uses) instead of the
  first writable service, which was a WeChat AirSync channel. The device picker now lists only MUNBYN printers.

## 0.7.0 (2026-10-26)

- **MUNBYN 130B over USB cable**: TSPL, 203 dpi, 4 x 6 in labels (101.5 x 152 mm), density 0-15, speed 1-6.
  The browser hands the job to `tools/usb_bridge` (a small local Python bridge, 127.0.0.1:5758) which prints it
  through the Windows RAW queue. The MUNBYN Label Printer app 1.2.0+ works as a fallback bridge (port 5757).
- **MUNBYN 130B over Bluetooth (experimental)**.
- **iPhone / iPad**: a banner explains that Bluetooth printing needs the free Bluefy browser, with a link and *Copy link*.
- Switching printers keeps the design proportional and sets that printer's default label length.
- Fix: preview for print widths that aren't a multiple of 8 dots.

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
