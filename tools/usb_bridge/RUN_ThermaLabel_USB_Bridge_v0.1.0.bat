@echo off
title ThermaLabel USB bridge v0.1.0
rem Lets ThermaLabel (browser) print to a USB label printer through the Windows print queue.
rem Keep this window open while printing; close it when done.
python -c "import win32print" 2>nul || (
  echo Installing pywin32...
  python -m pip install -q pywin32
)
python "%~dp0thermalabel_usb_bridge.py"
pause
