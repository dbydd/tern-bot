# Tern-Bot sandbox image: a real Linux desktop an agent can drive and a
# person can spectate.
#
#   Xvfb          the virtual display every GUI program draws into
#   chromium      the browser the bot drives over CDP (port 9222)
#   x11vnc        mirrors the display so noVNC can show it
#   noVNC         the browser-viewable desktop (port 6080)
#   xdotool       pointer and keyboard input for non-CDP GUI targets
#   imagemagick   screenshots of the X display
#
# The bot talks to this container twice: over CDP for browser use (AX tree +
# screenshot), and over xdotool/import for anything outside the browser.
FROM debian:12

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV SCREEN=1440x900x24

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      xdotool \
      imagemagick \
      curl \
      ca-certificates \
      fonts-dejavu-core \
      fonts-noto-color-emoji \
      git \
      python3 \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# The image supplies the standard ACP CLI; each worker receives its HOME configuration
# from ~/.config/tern-bot/sandbox-cfg/ at dispatch time.
RUN curl -fsSL https://bun.sh/install | bash \
    && install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun \
    && bun add -g @oh-my-pi/pi-coding-agent \
    && ln -sf /root/.bun/bin/omp /usr/local/bin/omp \
    && omp --version

COPY entrypoint.sh /usr/local/bin/tern-bot-entrypoint.sh
RUN chmod 0755 /usr/local/bin/tern-bot-entrypoint.sh

# 6080 noVNC  9223 Chromium CDP (proxied to 127.0.0.1:9222)  8080 App
EXPOSE 6080 9223 8080

ENTRYPOINT ["/usr/local/bin/tern-bot-entrypoint.sh"]
CMD ["sleep", "infinity"]
