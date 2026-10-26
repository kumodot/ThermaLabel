"""
tp6s_speedtest.py  v0.2.0

Speed test for the Vretti TP6-S on Windows 11.
Connects with bleak, optionally asks Windows for a throughput-optimized BLE
connection (BluetoothLEPreferredConnectionParameters, Windows 11 only), then
prints a test label using the TP6-S protocol (see docs/TP6S_PROTOCOL.md) and
reports how long the transfer took.

Usage:
    python tp6s_speedtest.py            # with the fast connection request
    python tp6s_speedtest.py --no-boost # plain connection, for comparison
    python tp6s_speedtest.py --chunk 180 --height-mm 30
"""

import argparse
import asyncio
import sys
import time
from datetime import date

from bleak import BleakClient, BleakScanner
from PIL import Image, ImageDraw, ImageFont

VERSION = "0.2.0"

WRITE_UUID = "0000ff02-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ff01-0000-1000-8000-00805f9b34fb"
FLOW_UUID = "0000ff03-0000-1000-8000-00805f9b34fb"

DOTS = 576          # dots per line (EM_300DPI_2INCH)
BPL = 72            # bytes per line
LINES_PER_MSG = 4
DOTS_PER_MM = 12
FEED_DOTS = 172

_seq = 0


def pack(cmd, payload=b""):
    """64 | cmd | seq | len LE | payload | 00 00 00 00 | 9B"""
    global _seq
    _seq = (_seq + 1) & 0x3F
    n = len(payload)
    return bytes([0x64, cmd, _seq, n & 0xFF, n >> 8]) + bytes(payload) + b"\x00\x00\x00\x00\x9b"


def connect_sequence():
    return [
        (0.0, pack(0x80, b"\x01")),                                                 # BLE token
        (0.1, pack(0x12) + pack(0x17, b"\x10") + pack(0x17, b"\x01")),              # serial number
        (0.2, pack(0x11)),                                                          # firmware
    ]


def build_label(text, height_mm):
    h = height_mm * DOTS_PER_MM
    img = Image.new("L", (DOTS, h), 255)
    d = ImageDraw.Draw(img)
    t = 6
    d.rectangle([0, 0, DOTS - 1, t - 1], fill=0)
    d.rectangle([0, h - t, DOTS - 1, h - 1], fill=0)
    d.rectangle([0, 0, t - 1, h - 1], fill=0)
    d.rectangle([DOTS - t, 0, DOTS - 1, h - 1], fill=0)
    try:
        big = ImageFont.truetype("arialbd.ttf", int(h * 0.32))
        small = ImageFont.truetype("arial.ttf", int(h * 0.13))
    except OSError:
        big = small = ImageFont.load_default()
    d.text((20, int(h * 0.38)), text, font=big, fill=0, anchor="lm")
    d.text((20, int(h * 0.75)), f"{date.today().isoformat()}  |  py v{VERSION}", font=small, fill=0, anchor="lm")
    for x in range(0, DOTS, 5 * DOTS_PER_MM):
        d.rectangle([x, h - 22, x + 2, h - 7], fill=0)
    return img


def image_to_job(img, density=12, speed=85):
    img = img.convert("L")
    w, h = img.size
    assert w == DOTS
    px = img.load()
    rows = bytearray(BPL * h)
    for y in range(h):
        base = y * BPL
        for x in range(w):
            if px[x, y] < 128:
                rows[base + (x >> 3)] |= 0x80 >> (x & 7)
    out = bytearray()
    out += pack(0x0A, bytes([speed]))
    out += pack(0x09, bytes([density]))
    step = BPL * LINES_PER_MSG
    for o in range(0, len(rows), step):
        out += pack(0x00, rows[o:o + step])
    out += pack(0x02, bytes([FEED_DOTS & 0xFF, FEED_DOTS >> 8]))
    return bytes(out)


def parse_status(data):
    if len(data) >= 17 and data[0] == 0x64 and data[1] == 0xFF:
        p = data[5:5 + (data[3] | data[4] << 8)]
        flags = p[2] | (p[3] << 8)
        batt = p[7] if len(p) > 7 else None
        return f"battery {batt}%  ready {bool(flags & (1 << 12))}  printing {bool(flags & (1 << 3))}  paperOut {bool(flags & (1 << 11))}"
    return None


async def request_fast_connection(client):
    """Ask Windows 11 for a throughput-optimized connection. Returns the request object (keep it alive)."""
    try:
        from winrt.windows.devices.bluetooth import (
            BluetoothLEDevice,
            BluetoothLEPreferredConnectionParameters,
        )
    except ImportError as e:
        print(f"  winrt Bluetooth module not available: {e}")
        return None
    dev = getattr(getattr(client, "_backend", None), "_requester", None)
    if dev is None:
        addr = int(client.address.replace(":", ""), 16)
        dev = await BluetoothLEDevice.from_bluetooth_address_async(addr)
    try:
        req = dev.request_preferred_connection_parameters(
            BluetoothLEPreferredConnectionParameters.throughput_optimized
        )
        print(f"  Fast connection request status: {req.status}")
        return (dev, req)
    except Exception as e:
        print(f"  Fast connection request failed: {e}")
        return None


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-boost", action="store_true", help="don't request a throughput-optimized connection")
    ap.add_argument("--chunk", type=int, default=0, help="bytes per write (0 = MTU - 3)")
    ap.add_argument("--height-mm", type=int, default=30)
    ap.add_argument("--density", type=int, default=12)
    ap.add_argument("--speed", type=int, default=85)
    ap.add_argument("--text", default="Hello TP6-S")
    ap.add_argument("--rate", type=int, default=0,
                    help="bytes/s for paced write-without-response (0 = write with response)")
    args = ap.parse_args()

    print(f"TP6-S speed test v{VERSION}")
    print("Scanning for TP6-S...")
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: (d.name or "").upper().startswith(("TP6", "ETP6")), timeout=10
    )
    if not dev:
        print("Printer not found. Is it on, and the phone app closed?")
        return 1
    print(f"Found {dev.name} [{dev.address}]")

    async with BleakClient(dev) as client:
        print(f"Connected. MTU reported by Windows: {client.mtu_size}")
        keep = None
        if not args.no_boost:
            keep = await request_fast_connection(client)
            await asyncio.sleep(1.0)  # give the link time to switch parameters

        last_status = {"t": 0}

        def on_notify(_, data: bytearray):
            s = parse_status(bytes(data))
            if s and time.time() - last_status["t"] > 4:
                print(f"  status: {s}")
                last_status["t"] = time.time()

        await client.start_notify(NOTIFY_UUID, on_notify)

        credits = {"n": 0, "seen": False}

        def on_flow(_, data: bytearray):
            if len(data) >= 2 and data[0] == 0x01:
                credits["n"] += data[1]
                credits["seen"] = True
            elif len(data) >= 3 and data[0] == 0x02:
                print(f"  FF03 MTU: {data[1] | data[2] << 8}")

        if args.rate:
            await client.start_notify(FLOW_UUID, on_flow)
            await asyncio.sleep(0.3)
            print(f"  FF03 credits at start: {credits['n']}")

        t = 0.0
        for delay, msg in connect_sequence():
            if delay > t:
                await asyncio.sleep(delay - t)
                t = delay
            await client.write_gatt_char(WRITE_UUID, msg, response=True)

        job = image_to_job(build_label(args.text, args.height_mm), args.density, args.speed)
        chunk = args.chunk or max(20, client.mtu_size - 3)
        n = (len(job) + chunk - 1) // chunk
        mode = f"paced {args.rate} B/s, no response" if args.rate else "with response"
        print(f"Printing {args.height_mm} mm label: {len(job)} bytes in {n} writes of {chunk} B "
              f"({'boost' if keep else 'no boost'}, {mode})")
        t0 = time.perf_counter()
        if args.rate:
            # Paced write-without-response: hold a fixed byte rate and also respect FF03 credits.
            per_chunk = chunk / args.rate
            sent = 0
            for o in range(0, len(job), chunk):
                w0 = time.perf_counter()
                while credits["n"] <= 0 and credits["seen"]:
                    if time.perf_counter() - w0 > 1.0:
                        print("  no credit for 1 s, forcing one")
                        credits["n"] = 1
                        break
                    await asyncio.sleep(0.002)
                credits["n"] -= 1
                await client.write_gatt_char(WRITE_UUID, job[o:o + chunk], response=False)
                sent += 1
                target = t0 + sent * per_chunk
                now = time.perf_counter()
                if target > now:
                    await asyncio.sleep(target - now)
        else:
            for o in range(0, len(job), chunk):
                await client.write_gatt_char(WRITE_UUID, job[o:o + chunk], response=True)
        dt = time.perf_counter() - t0
        print(f"Sent in {dt * 1000:.0f} ms  ({dt * 1000 / n:.1f} ms per write)")
        await asyncio.sleep(3)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
