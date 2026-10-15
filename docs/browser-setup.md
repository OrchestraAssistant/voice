# Getting a browser for `voice-probe --browser`

The readiness stage drives a real Chrome or Chromium. The probe does not ship
one; it uses a browser that already exists, through `puppeteer-core`, which you
install yourself:

```
npm install -D puppeteer-core
```

Then give it a browser. Two ways, best first.

## Best: connect to a browser that is already running (no binary, no libs)

If any Chrome/Chromium is running with a debugging port — one the agent
launched, a `browserless` container, anything speaking CDP — point the probe at
it:

```
# start one if needed (any chrome/chromium binary; the agent likely has one):
chrome --headless=new --no-sandbox --remote-debugging-port=9222 about:blank &

export VOICE_BROWSER_ENDPOINT=http://localhost:9222   # http URL, or a ws:// endpoint
npx voice-probe .voice/manifest.json <running-app-url> --login spec.json --browser
```

The probe CONNECTS over CDP and detaches when done — it needs no local binary and
no system libraries, and it will not touch a browser it did not start. This is
the clean path.

## Fallback: launch a binary

With nothing to connect to, the probe launches the first browser it finds:
`VOICE_BROWSER` if set, then the usual install paths (`/usr/bin/google-chrome`,
`chromium`, Edge, Brave, and the Playwright/Puppeteer caches).

If launching fails with a missing shared library
(`libglib-2.0.so.0: cannot open shared object file` and similar), the binary is
there but its system libraries are not. Fix it without root or apt:

```
# 1. Download the Chromium binary (no root; lands in ~/.cache/ms-playwright,
#    which the probe's finder checks automatically)
npx playwright install chromium

# 2. Install its graphics/runtime libraries via conda-forge (no root)
micromamba create -y -n browser -c conda-forge \
  nss nspr glib atk-1.0 at-spi2-atk at-spi2-core dbus libcups libxcb \
  libxkbcommon alsa-lib mesalib xorg-libx11 xorg-libxext xorg-libxcomposite \
  xorg-libxdamage xorg-libxfixes xorg-libxrandr xorg-libxtst cairo pango expat

# 3. Point the loader at those libs and run the probe
export LD_LIBRARY_PATH="$HOME/.micromamba/envs/browser/lib:$LD_LIBRARY_PATH"
# (adjust the path to your micromamba root if different)
npx voice-probe .voice/manifest.json <running-app-url> --login spec.json --browser
```

In a container with no sandboxing capabilities, Chrome must run with
`--no-sandbox` (the probe passes it). The dbus warnings Chromium prints at
launch are harmless in headless mode.

If none of this is available, the probe skips readiness with a reason and every
other stage still runs — you just won't get `readyWhen` markers. The manifest
and the judgement pass do not need a browser at all.
