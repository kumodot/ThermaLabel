# Adding a printer

Each printer is a driver file in `js/drivers/` that registers itself on `window.ThermaLabelDrivers`.
The editor, tiling, fonts, frames and templates are shared; the driver only knows dots, bytes and
Bluetooth. Load the file with a `<script>` tag in the app HTML, before `js/main.js`.

## Interface

```js
window.ThermaLabelDrivers.myprinter = {
  id: 'myprinter',
  name: 'Brand Model',                 // shown in the Printer selector
  protocolVersion: '1.0.0',
  dotsPerLine: 576,                    // printable width in dots
  dotsPerMm: 12,                       // 8 = 203 dpi, 12 = 300 dpi
  paperWidthMm: 57,                    // roll width, for the on-screen paper
  densities: [['Light', 7], ['Medium', 12], ['Dark', 15]],
  defaultDensity: 12,
  speeds: [50, 85],                    // values for Settings > Motor speed
  defaultSpeed: 85,
  transfers: [['auto', 'Auto'], ['safe', 'Safe']],
  defaultLengthMm: 30,

  monoFromRgba(rgba, width, height),   // -> Uint8Array, packed rows, MSB first, 1 = black
                                       //    (the preview is drawn from this, so match the printer)
  async connect({ log, onStatus }),    // -> conn with conn.device (BluetoothDevice)
                                       //    onStatus({ battery, charging, paperOut, coverOpen,
                                       //               overheat, lowBattery, printing, ready })
  async print(conn, { mono, width, height }, { density, speed, mode, rate, log, onProgress }),
                                       // -> stats { bytes, ms, pacedBytes, safeBytes, creditWait, forced }
  async feed(conn),
  disconnect(conn),
};
```

## Checklist for a new model

1. Find the BLE services with `tools/probes/ble_printer_probe_v0.3.1.html` (name, services, which
   characteristics are writable / notify).
2. Work out the job format (TSPL, ESC/POS raster, or a vendor framing like the TP6-S).
3. Write the driver, add a self-test under `docs/selftest/` if you have reference output.
4. Measure transfer speed and note what makes the printer stall or power off in a `docs/TRANSFER_NOTES_<model>.md`.
5. Add the model to the README "Where it works" table.

## Planned: MUNBYN 130B

4" shipping label printer, 203 dpi (8 dots/mm, 832 dots per line on 104 mm). Probably TSPL. First step is
checking whether its Bluetooth is BLE (works with Web Bluetooth) or classic SPP only (would need Web Serial,
desktop Chrome only).
