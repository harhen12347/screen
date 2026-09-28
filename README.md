# TURMO Screen Bridge

This is a static browser application: `index.html`, `style.css`, and `app.js` run the preview, screen capture, and TURMO serial sender. The page does not call the Python metrics API. It uses the USB2 framebuffer protocol recovered from the bundled TURMO application.

## Open the page

GitHub Actions publishes the static app to GitHub Pages whenever changes are pushed to `main`. The site URL is <https://harhen12347.github.io/screen/>. The first deployment can take a few minutes; check the repository's **Actions** tab for the `Deploy static site to GitHub Pages` workflow. For local use, serve the static files from `http://localhost` with any static-file server. Web Serial and screen capture require a secure context (HTTPS or localhost); `file://` and plain LAN HTTP are not reliable origins for these APIs.

Click **Connect TURMO Display** and select the screen's COM/CDC serial port. By default the app tries 921600, 460800, then 115200 baud and accepts a rate only after the device acknowledges a correctly sized full framebuffer; a single rate can also be selected manually. Each attempt sends the vendor reset, framebuffer-size command, full initial image, and render command. Choose panel size, orientation, pixel format, RGB565 byte order, and brightness. **Push Frame Now** sends one forced full frame; **Auto-Sync Screen** opts into updates at the selected 1–15 FPS target, subject to actual transfer/ack time. Turning it off lets an active protocol transaction finish, then stops background serial traffic. Frame data uses asynchronous 4 KiB writes and stream backpressure without an artificial per-chunk delay. **Send Test Pattern** transmits full red, green, and blue blocks without delta encoding. Click **Share / Extend Screen** to pick a screen, window, or tab; stop sharing to return to the built-in clock/link dashboard.

## Device and protocol notes

The theme files contain multiple panel dimensions, including 480×320 and 320×480; the page defaults to 480×320 and lets you select either. The serial sender follows the USB2 path in the bundled driver: initial full framebuffer, command/acknowledgement exchange, then CRC16-protected 32-bit changed-pixel runs in BGRA32 mode. These runs are the device's documented delta format; a separate bounding-box packet format is not documented. RGB565 packing is available for raw full-frame experiments, with selectable byte order, but the recovered protocol only documents BGRA32. If RGB565 produces corruption, return to BGRA32; the hardware may not support RGB565 on this protocol.

The device must expose a browser-selectable serial port. Web Serial cannot bypass a Windows display-class/UMDF driver or claim an interface that the operating system has bound to another driver. If Chrome's port chooser doesn't list a TURMO COM/CDC port, this browser-only route can't reach that installation of the display.

The vendor's serial framebuffer transfer is bandwidth-limited: a 480×320 initial BGRA32 frame is 614,400 bytes, around 53 seconds at true 115200 baud or 6.7 seconds at 921600 baud before protocol overhead. Small deltas can transfer much faster; full-screen motion remains limited by serial bandwidth, so the FPS control is a target rather than a guarantee. Brightness is sent using the vendor command and may reset the framebuffer, so a full redraw follows a brightness change.

The Python metrics server and `requirements.txt` are not used by this page; they remain in the repository from the earlier dashboard version.