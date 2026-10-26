# Transfer notes: Vretti TP6-S (speed and stability)

Findings from testing on a Windows 11 PC with the TP6-S. Test job: one 30 mm label,
576 x 360 dots, 26,854 bytes.

## GATT layout

| UUID | Role |
|---|---|
| `0xFF00` | Service |
| `0xFF01` | Notify: printer replies and a status heartbeat every ~5 s |
| `0xFF02` | Write / write without response: all commands and data |
| `0xFF03` | Notify: flow control from the BLE chip. `01 NN` = NN more credits, `02 LO HI` = MTU (192) |

On connect the printer sends `01 07` (7 credits) and `02 c0 00` (MTU 192) on FF03.

## Results

| Method | Time | Notes |
|---|---|---|
| Browser, write with response, 180 B chunks | 28 s | ~190 ms per write. Works, prints in steps |
| Browser, write with response, 100 B chunks | 42 s | Slower: more round trips |
| Python (bleak), write with response, 237 B, no boost | 30 s | Windows negotiated MTU 240 |
| Python, write with response, 237 B, Windows 11 "ThroughputOptimized" | 19 s | Faster connection interval helps |
| Python, **20 B without response, FF03 credits, paced 3 KB/s**, boost | 9 s | Works |
| Python, same, paced 6 KB/s | 6.6 s | Works |
| Python, same, paced 10 KB/s | 6.3 s | Works, this is the ceiling |
| Browser, same paced method, no boost | 84-94 s | Credits come back slowly on the default Windows link |
| Browser, same paced method, right after a Python boost run | 11 s | Windows kept the fast link for a while |
| **Browser paced + `tp6s_boost` helper running** | **6 s** | **Recommended on Windows** |
| Without response, 40 B or 100 B packets | - | Printer stops returning credits and powers off |
| Without response, 20 B, no pacing (burst in ~1 s) | - | Printer powers off |

## Takeaways

- **Auto mode (app default since 0.6.0):** starts paced, measures throughput over the first 60 packets and switches
  to safe mid-stream when paced is below 1.5 KB/s (default Windows link). Fast links (Windows with the boost, and
  probably Android/macOS) stay paced. Switching is safe because the printer reads one continuous byte stream.
- **The big one:** paced printing is limited by how fast FF03 credits come back, which depends on the
  BLE connection interval. On the default Windows link that is ~90 s per 30 mm label. With Windows 11's
  throughput-optimized connection it is ~6 s. The browser can't ask for it, but any process can for the
  same physical link: run `tools/python/tp6s_boost_v0.1.0.py` while the web app is connected.

- Without response, the BLE chip only handles **20-byte** packets reliably. Each packet costs one
  credit, and the chip returns credits with `01 01` as it drains.
- Bursts make it power off, so the app caps the byte rate as well as following the credits.
- Write with response works with large chunks, but on Windows each round trip is slow (150-260 ms),
  so the printer starves and prints in steps.
- The official Android app writes with response using MTU 512 and gets a fast connection
  interval from the phone, which is why it prints continuously.
- The `speed` byte (cmd `0x0A`, the app sends 85) did not make printing continuous at 180.
  Higher values seemed slower. Not fully understood yet.
- Windows 11 can request a faster connection (`BluetoothLEPreferredConnectionParameters.ThroughputOptimized`),
  but only from native code, not from the browser. See `tools/python/tp6s_speedtest_v0.2.0.py`.
