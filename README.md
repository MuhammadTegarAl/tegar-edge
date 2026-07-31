# Tegar Pi Control

Web dashboard for remotely controlling the Raspberry Pi ACT LED, monitoring
temperature and humidity from a Xiaomi LYWSD03MMC BLE sensor, and opening an
on-demand webcam feed processed by Raspberry Pi edge vision.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Installable PWA

The dashboard includes a web app manifest, 192 px and 512 px icons, an Apple
touch icon, and a small service worker for the application shell. Use the
**Install app** action in a supported browser, or **Add to Home Screen** from
Safari's Share menu on iPhone. Live LED, climate, camera, and capture data still
require connectivity to their Raspberry Pi services.

## BLE environment sensor

The Raspberry Pi acts as a passive BLE gateway for the stock Xiaomi
LYWSD03MMC:

| Field | Value |
| --- | --- |
| Model | `LYWSD03MMC` |
| Bluetooth address | `A4:C1:38:4D:B0:03` |
| MQTT topic | `tegar-pi/.../environment` |

The stock Xiaomi advertisement is encrypted. Its 16-byte BLE bind key is stored
only in `/etc/tegar-environment-agent.env` on the Pi and is deliberately not
included in this project. Temperature, humidity, battery, signal strength, and
freshness are published as retained telemetry for the dashboard.

New sensor advertisements are also aggregated into minute, hour, day, and
month SQLite rollups on the Pi. The database has a strict 5 MiB page budget.
Minute rollups are retained for seven days, hourly for 120 days, daily for five
years, and monthly summaries remain subject to the same size cap. The stock
sensor does not expose a downloadable historical archive, so this history begins
when the gateway receives a new advertisement after deployment.

## Webcam

The private camera server detects the USB webcam at `/dev/video0`, listens only
on Pi loopback, and provides an annotated 640×360 MJPEG stream at a target of
10 frames per second. A shared OpenCV capture pipeline serves multiple viewers
without opening the webcam more than once. Tailscale Serve exposes that local
service over HTTPS only inside the `muhammadtegaral.github` tailnet:

`https://tegar-pi.tailbba591.ts.net`

The viewing device must be connected to the same Tailscale network. No camera
port is opened to the LAN or public internet.

## Edge computer vision

Computer vision runs continuously on the Raspberry Pi:

- OpenCV DNN with NanoDet detects 80 common COCO object classes.
- OpenCV YuNet detects face regions without identifying a person.
- Object and face boxes are rendered into the stream before it reaches the
  browser.

When a `person` detection reaches at least 60% confidence, the Pi stores a
timestamped annotated JPEG. While a qualifying person remains visible, another
capture may be stored every five seconds. The interval is configurable through
`TEGAR_PERSON_CAPTURE_INTERVAL_SECONDS`.

Event metadata is stored in SQLite and images are stored under
`/var/lib/tegar-camera/captures`. The archive has a strict 500 MiB budget and
deletes its oldest records and files automatically when the limit is exceeded.
The dashboard loads the most recent events through private Tailscale HTTPS.
The capture card provides server-side pagination with 10, 20, 50, or 100 images
per page and a confirmation-protected **Delete all** action.
Camera API CORS is currently limited to the local dashboard origins. Add the
exact production Vercel origin to `TEGAR_CAMERA_ALLOWED_ORIGINS` on the Pi when
the production URL is known.

Face detection does not perform face recognition, identify a person, or store
a biometric profile.

### Pi runtime

The edge service requires Debian's `python3-opencv` package. Model files are
installed under `/usr/local/share/tegar-camera`, while the Python service lives
at `/usr/local/lib/tegar-camera-server.py` and is managed by
`tegar-camera-server.service`.

On the current Raspberry Pi 3B+, capture and annotated rendering run at roughly
10 FPS. General object and face inference is intentionally scheduled at about
0.5 FPS with two OpenCV threads so the video remains smooth without re-triggering
the Pi's active undervoltage/throttling state.

## Deployment

The UI is a standard Next.js app and can be imported into Vercel. The Raspberry
Pi communicates through MQTT, so it does not need to share a Wi-Fi network with
the browser.

LED and environment telemetry still use the public EMQX prototype broker.
Camera frames, person captures, and the BLE bind key never use that broker.
Before exposing control functionality publicly, move the topics to a private
authenticated MQTT broker with ACLs.
