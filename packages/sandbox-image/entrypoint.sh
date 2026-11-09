#!/bin/sh
# Boots the pieces a spectated, agent-driven desktop needs, then runs the
# container's command.
set -eu

SCREEN="${SCREEN:-1440x900x24}"
DISPLAY="${DISPLAY:-:99}"
export DISPLAY

mkdir -p /tmp/tern-bot-chrome /workspace

# 1. Virtual display
rm -f "/tmp/.X11-unix/X${DISPLAY#:}"
Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp >/tmp/xvfb.log 2>&1 &

i=0
while [ ! -e "/tmp/.X11-unix/X${DISPLAY#:}" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "tern-bot: Xvfb did not come up" >&2
    exit 1
  fi
  sleep 0.1
done

# 2. Chromium with CDP on 127.0.0.1:9222 and wildcard origins
chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  --user-data-dir=/tmp/tern-bot-chrome \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate,BackForwardCache \
  --window-position=0,0 \
  --window-size=1440,900 \
  about:blank >/tmp/chromium.log 2>&1 &

# 3. Expose 0.0.0.0:9223 -> 127.0.0.1:9222 so host-mapped CDP ports work
python3 -c '
import asyncio

async def pipe(r, w):
    try:
        while data := await r.read(65536):
            w.write(data)
            await w.drain()
    except Exception:
        pass
    finally:
        w.close()

async def handle(cr, cw):
    try:
        sr, sw = await asyncio.open_connection("127.0.0.1", 9222)
        await asyncio.gather(pipe(cr, sw), pipe(sr, cw))
    except Exception:
        cw.close()

async def main():
    srv = await asyncio.start_server(handle, "0.0.0.0", 9223)
    async with srv:
        await srv.serve_forever()

asyncio.run(main())
' >/tmp/cdp-proxy.log 2>&1 &

# 4. VNC mirror of the display
x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &

# 5. noVNC on 6080
if [ -d /usr/share/novnc ]; then
  websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
fi

# 6. Workspace HTTP server on 8080 so anything written to /workspace is immediately viewable
python3 -m http.server 8080 --bind 0.0.0.0 --directory /workspace >/tmp/workspace-http.log 2>&1 &

exec "$@"
