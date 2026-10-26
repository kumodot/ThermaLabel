"""
tp6s_boost.py  v0.1.0

Windows 11 helper: asks Windows for a throughput-optimized BLE connection to the TP6-S
while the BROWSER app holds the connection. Windows applies connection parameters per
physical link, so the web app gets the fast link too (paced printing ~11 s instead of ~90 s).

Run it after the web app is connected, keep it running while printing.

Usage:
    python tp6s_boost.py                 # finds the printer by name among connected devices
    python tp6s_boost.py --address 03:03:2B:BF:1B:FA
"""

import argparse
import asyncio
import time

from winrt.windows.devices.bluetooth import (
    BluetoothConnectionStatus,
    BluetoothLEDevice,
    BluetoothLEPreferredConnectionParameters,
)
from winrt.windows.devices.enumeration import DeviceInformation

VERSION = "0.1.0"


async def find_connected(name_prefixes=("TP6", "ETP6")):
    selector = BluetoothLEDevice.get_device_selector_from_connection_status(BluetoothConnectionStatus.CONNECTED)
    # pywinrt exposes the AQS overload under different names depending on the version
    finder = getattr(DeviceInformation, "find_all_async_aqs_filter", None)
    infos = await (finder(selector) if finder else DeviceInformation.find_all_async(selector))
    for info in infos:
        if (info.name or "").upper().startswith(name_prefixes):
            return await BluetoothLEDevice.from_id_async(info.id)
    return None


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", help="printer MAC, e.g. 03:03:2B:BF:1B:FA")
    ap.add_argument("--seconds", type=int, default=0, help="stop after N seconds (0 = until Ctrl+C)")
    args = ap.parse_args()
    print(f"TP6-S boost v{VERSION}")

    dev = None
    while dev is None:
        if args.address:
            dev = await BluetoothLEDevice.from_bluetooth_address_async(int(args.address.replace(":", ""), 16))
            if dev and dev.connection_status != BluetoothConnectionStatus.CONNECTED:
                dev = None
        else:
            dev = await find_connected()
        if dev is None:
            print("  Waiting for the printer to be connected (connect it in the web app)...")
            await asyncio.sleep(3)

    print(f"Found {dev.name}, status {dev.connection_status}")
    req = dev.request_preferred_connection_parameters(BluetoothLEPreferredConnectionParameters.throughput_optimized)
    print(f"  Throughput-optimized request status: {req.status} (1 = success). Keep this window open.")
    t0 = time.time()
    try:
        while not args.seconds or time.time() - t0 < args.seconds:
            await asyncio.sleep(2)
            if dev.connection_status != BluetoothConnectionStatus.CONNECTED:
                print("  Printer disconnected, waiting for reconnect...")
                req.close()
                while dev.connection_status != BluetoothConnectionStatus.CONNECTED:
                    await asyncio.sleep(2)
                req = dev.request_preferred_connection_parameters(BluetoothLEPreferredConnectionParameters.throughput_optimized)
                print(f"  Reconnected, request status: {req.status}")
    except KeyboardInterrupt:
        pass
    finally:
        req.close()
        print("Boost released.")


if __name__ == "__main__":
    asyncio.run(main())
