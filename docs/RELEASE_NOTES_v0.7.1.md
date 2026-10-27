## ThermaLabel v0.7.1

- **MUNBYN 130B, USB cable**: second printer. TSPL, 203 dpi, 4 x 6 in labels, *Darkness* 0-15 and *Motor speed* 1-6. Run `tools/usb_bridge/RUN_ThermaLabel_USB_Bridge_v0.1.0.bat` while printing: it passes the job to the Windows print queue.
- **MUNBYN 130B, Bluetooth (beta)**: prints through the same BLE service MUNBYN's own web editor uses.
- **iPhone / iPad**: banner pointing to the free Bluefy browser, with *Copy link*.
- **Printer switching** keeps the design proportional and sets the new printer's default label length.
- **Fix**: labels no longer end up bigger than their cell after changing columns, rows or printer; each label remembers the size it was designed for.
- **Fix**: preview rows for print widths that aren't a multiple of 8 dots.

Run: open `ThermaLabel_v0.7.1.html` in Chrome or Edge, or online at https://kumodot.github.io/ThermaLabel/
