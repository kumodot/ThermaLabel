# Vretti TP6-S BLE print protocol (from XLife Pro 3.18.1)

Version 1.0.0 of this spec. Companion code: `tp6s_protocol.js` (same folder).

Source of truth: decompiled Java (`com.printer.*`, `com.yk.*`) plus `lib/arm64-v8a/libykDataPacket.so`.
Addresses below are offsets in that `.so`.

## 0. Summary

* The printer speaks the "Cus" protocol of libykDataPacket: every message is
  `64 | cmd | seq | len_lo len_hi | payload | 00 00 00 00 | 9B`.
* For the TP6-S the app uses printer config `EM_300DPI_2INCH`. The image path has no compression,
  no checksum and no crypto. The image is sent as raw 1-bpp rows, 72 bytes per row (576 dots),
  4 rows per message.
* One page is `SET_SPEED(85)`, `SET_DENSITY(7|12|15)`, then N x `IMAGE_ROWS`, then `FEED(172)`.
* The app writes to FF02 **with response**, in chunks of (MTU-3) bytes. It does not use FF03 or any
  credits for this printer.

Everything in sections 2 to 4 was checked by running the real native code in Unicorn and comparing
byte for byte with the JS module (see section 6).

## 1. Connection sequence (Java, verified by reading the decompiled code)

Path: `PrinterManager$ConnectBleRunnable` -> `YkBleDataSplitManager(YKBleManager.UUID_CUS)` -> `YKBleManager`.

| Step | What the app does | Source |
|---|---|---|
| 0 | `YkDataPacket.init(0)` (native `setCodeMethod(0)`); TP6_S has `PrinterType.d() == 0` | ConnectBleRunnable, PrinterConstants$PrinterType |
| 1 | `connectGatt(ctx, autoConnect=false, cb, TRANSPORT_LE)` | YKBleManager.connect |
| 2 | `discoverServices()` | YKBleManager$1.onConnectionStateChange |
| 3 | Enable notifications on **FF01** (service FF00) and write CCCD 0x2902 = `01 00` | enableNotification |
| 4 | After the CCCD write succeeds, `requestMtu(512)`. If that fails (error -779) it retries with 240, 180 and then 23 | onDescriptorWrite -> onPrepare; ConnectBleRunnable$2.onError |
| 5 | `onMtuChanged(mtu)`: chunk size = mtu-3, then it writes `getBleTokenBytesCommand` = `64 80 ss 01 00 01 00 00 00 00 9B` | YkBleDataSplitManager.setCurMtu |
| 6 | +100 ms: `getSnCommand` = 3 messages: `64 12 ss 00 00 00 00 00 00 9B`, `64 17 ss 01 00 10 00 00 00 00 9B`, `64 17 ss 01 00 01 00 00 00 00 9B` | PrinterManager.Q0 -> $9 -> PrinterCus.t() |
| 7 | +200 ms: `getFirmwareVersionCommand` = `64 11 ss 00 00 00 00 00 00 9B` | Q0 -> $10 -> PrinterCus.w() |
| 8 | +3000 ms: an HTTP call only, nothing goes over BLE | Q0 -> $15 -> Printer.L() |

No time sync, no auth token and no density or speed setup happen at connect.
(`ss` = running sequence byte, see section 2.)

### Write path (all commands and print jobs)
`CusHelper.print(bytes)` -> `PrinterCus.m0` -> `PrinterManager.R0/f0` -> `YkBleDataSplitManager.writeData(bytes, 0)`:

* The whole byte array (all messages of a job, concatenated) is cut into `mMtu = MTU-3` byte pieces.
  The cuts ignore message boundaries, so the printer must reassemble the stream by framing.
* Pieces go one by one through `BluetoothGatt.writeCharacteristic` on **FF02** with the default write
  type (**write with response**). The next piece goes only after `onCharacteristicWrite` (`canWrite`
  flag). The Timer delay is 0 ms.
* Token flow control is off for this printer: `mCurToken` stays -1 because `setToken`/`setTokenUpdate`
  are only called for the Q2. **FF03 is never subscribed to by the app.** Your observed FF03 traffic
  (`01 07` = 7 credits?, `02 c0 00` = 192, `01 01` per write) comes from the BLE module. The app ignores
  it. With Web Bluetooth, use `writeValueWithResponse` and chunks of 180 bytes or less (the printer
  advertises 192 there, so at most 189).

## 2. Message framing (verified: `cusPkgMsg(CusMsgType, DataDP)` @0xe1f20)

```
offset  0     1     2     3        4        5 .. 5+n-1   5+n .. 8+n    9+n
        0x64  cmd   seq   len&ff   len>>8   payload      00 00 00 00   0x9B
```
* `seq`: one global counter in the library (byte at .bss 0x1abdcc), `seq = (seq+1) & 0x3F`,
  pre-incremented for **every** message the library builds (connect queries included). The first
  message after load has seq 1. It wraps 63 -> 0.
* The 4 bytes before 0x9B are always zero in host->printer messages. `cusSetChecksum` and `crypto()`
  exist in the library but nothing calls them.
* Printer->host messages do carry a checksum in that slot (`cusCalChecksum` @0xe0a90):
  `0x12345678 + sum(frame[0 .. len-6]) + frame[len-1]` (the 0x9B), stored little-endian.
  Check with the heartbeat `64 ff 0b 08 00 b6 07 03 10 09 03 46 56 | 01 5a 34 12 | 9b`: sum = 0x389,
  and 0x12345678 + 0x389 = 0x12345A01.

## 3. Print job for one page (verified by emulation)

Java: `PrinterTwoInch.o()` ->
`YkDataPacket.getPrintImgWithTypeCommand("EM_300DPI_2INCH", bmp, 85, density, isFirst, isLast, false, 0f, 0f, 576, true)`

* `bmp` is first scaled to 576 px wide (`YkUtil.scalingBitmap`, keeping aspect) and converted to
  ARGB_8888. Before that the app has already dithered or thresholded it in Java
  (`BinaryBitmapProcessUtils`), so the native side normally sees pure black and white.
* `density` = `PrinterUtils.O(DENSITY_7_12_15, level)`: level 1 -> **7**, 2 (default) -> **12**, 3 -> **15**.
* Native: `getPrintSepImgWithTypeCommand` @0xdeabc -> `pkgSepImgWithType(DataDP,...)` @0xccb04 ->
  `getPrinterConfigByName("EM_300DPI_2INCH")` -> `pkgPrintLabelWithConfig` @0xd2008. That function
  interprets the config's key/value list with the `AstraP1` command class.

Config `EM_300DPI_2INCH` (dumped from the live map in the emulator):

| key | value | meaning |
|---|---|---|
| pointsPerMM | 12 | ~300 dpi |
| dotsNum | 576 | line width in dots (72 bytes, 48 mm) |
| pkgLength | 4 | rows per image message |
| protoVer | 1 | AstraP1 |
| alignment | 1 | image is right-aligned in the 576-dot line |
| setSpeed | 50 | default speed, used only if the passed speed is outside 10..255 |
| setDensity | 12 | default density, used only if the passed density is outside 0..15 |
| ImgWithRightMargin | 0 | right margin in dots |
| feed | 172 | dots fed after the image (~14.3 mm) |

No key in this config has an isFirst/isLast condition. **isFirst, isLast, the third bool and both
floats have no effect on the bytes** (checked in emulation).

Messages, in order:

| # | cmd | payload | source |
|---|---|---|---|
| 1 | `0A` SET_SPEED | 1 byte: speed (app sends 85 = `55`) | AstraP1::setSpeed @0xd854c |
| 2 | `09` SET_DENSITY | 1 byte: 7 / 12 / 15 | AstraP1::setDensity @0xd85f8 |
| 3..n | `00` IMAGE_ROWS | up to 4 rows x 72 bytes = 288 bytes. The last message holds the remaining 1 to 4 rows and is **not** padded | AstraP1::print -> cusGetImgPrintDataWithPaddingOffsetR @0xe260c |
| n+1 | `02` FEED | u16 LE dots: `AC 00` (172) | AstraP1::feedPaper @0xd83f4 |

Image row format (`cusConvertImgDataWithPadding` @0xe21f0):
* 72 bytes per row, **MSB first** (bit 7 of byte 0 = leftmost dot), **1 = black (burn)**.
* Pixel to bit: `gray = (R*171>>9) + (G*171>>9) + (B*171>>9)`; black if `gray < 128`.
  Alpha is ignored, so transparent black prints black. Pure gray: 0..128 is black, 129..255 is white.
* If the bitmap is narrower than 576, it is right-aligned (left padding = 576 - w). If wider, the
  left part is cut off.

Example: an all-black 576x4 page, starting from seq 0:
```
64 0a 01 01 00 55 00 00 00 00 9b
64 09 02 01 00 0c 00 00 00 00 9b
64 00 03 20 01 [288 x ff] 00 00 00 00 9b
64 02 04 02 00 ac 00 00 00 00 00 9b
```

Several pages or copies: `PrinterHelper.E()` marks the first and last `PrintConfig`, but each page
is its own complete job (speed, density, rows, feed). `CusHelper` reports "print completed" when a
status frame arrives with `isPrinting = 0` after a job was started. The UI then moves on to the next
page. (This last part is inferred from the Java flow, not tested.)

## 4. Other commands (verified by emulation)

| command | bytes (seq = ss) |
|---|---|
| BLE token query (sent at connect) | `64 80 ss 01 00 01 00 00 00 00 9b` |
| get SN (3 messages) | `64 12 ss 00 00 …9b` + `64 17 ss 01 00 10 …9b` + `64 17 ss 01 00 01 …9b` |
| get firmware version | `64 11 ss 00 00 00 00 00 00 9b` |
| get printer status | `64 10 ss 00 00 00 00 00 00 9b` |
| get paper type | `64 72 ss 01 00 01 00 00 00 00 9b` |
| set auto-off time | `64 08 ss 01 00 <code> 00 00 00 00 9b` (codes used by the app: 0, 1, 3, 6, 18, 30, 60) |

## 5. Status heartbeat on FF01 (nice to have)

Incoming cmd -> handler (`cusUnpkgReceivedMsgDataType` @0xe8a64, jump table @0x6825f):
`FF` -> status (type 1), `80`/`81` with 18 bytes -> status (types 3/4), `F1` -> firmware info,
`F2` -> serial number, `73` -> paper type, `FE` -> firmware upgrade state. Others are not decoded here.

18-byte status frame (`cusUnpkgPrinterStatus` @0xe8ce4; names from the JNI `getPrinterInfo`
constructor order; values checked in emulation):

| payload byte | meaning |
|---|---|
| 0-1 | int16 LE raw voltage. App stores `raw*3340*280/409600` as `voltage` (1974 -> 4507) |
| 2-3 | u16 LE flags: bit0 isTurnOn (+isCutterReady), 1 isBtConnected, 2 isCharging, 3 isPrinting, 4 isSuspent, 5 isUsbBusy, 6 isBtBusy, 7 isMotorOutSync, 8 isUncap (cover open), 9 isLowBattery, 10 isOverHeating, 11 isPaperOut, 12 isAllowPrint, 13 isValidPaper, 14 isUpgrading, 15 isUsbConnected/isPaperLoaded |
| 4 | density |
| 5 | autoOffTime |
| 6 | speed |
| 7 | batteryPercentage (only in the 18-byte form) |

Your sample `b6 07 03 10 09 03 46 56` decodes to: on, BT connected, allowed to print, not printing,
paper OK, density 9, autoOff 3, speed 70, battery 86 %.
A 17-byte form also exists; there battery % comes from a voltage table, which I did not decode.

## 6. Validation status

**Verified, byte for byte.** A Unicorn emulator harness (not included in this repo) loads
`libykDataPacket.so`, applies all relocations, runs `init_array`, stubs libc, and provides a fake
JNIEnv and AndroidBitmap. It then calls the real
`Java_com_yk_common_YkDataPacket_getPrintSepImgWithTypeCommand` after `init(0)`.
The native output was captured for 12 test images:

* white 576x8, black 576x40, text-like 576x123, random RGBA 576x37, colour gradient with alpha, 384x50
  (right-align), 301x9, 600x10 (crop), density 16 / speed 300, -1 / -1, 0 / 0 (fallback to defaults),
  and 576x1000 (sequence wrap)
* plus the token, SN, firmware, status, paper-type and auto-off commands

`tp6s_protocol.js` run on the same inputs produced identical bytes for **all** of them.

**Verified by reading code only (no hardware):** the connect order and timing, the MTU logic, write
with response, chunking, and FF03 being ignored.

**Since confirmed on hardware (2026-10-26):** printing works; 180-byte splits with response work; see TRANSFER_NOTES.md for transfer limits.

**Inferred / not verified:**
* That the printer firmware accepts the stream split at arbitrary 180-byte boundaries. The app splits
  at MTU-3, normally 509 or 189, so the printer must already handle mid-message splits.
* The print-complete detection flag, and the 17- and 22-byte status variants.
* What FF03 means.
* Whether the printer actually needs the token, SN and firmware queries before a job. They are cheap,
  so send them.
* Nothing has been tested on a real TP6-S yet.
