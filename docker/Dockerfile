# Pi Crust in a container: Electron on a virtual display (TigerVNC Xvnc), viewed in your browser through noVNC.
# Build and run: see docker/README.md.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      # Electron / Chromium runtime libraries
      libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxshmfence1 libdrm2 libxkbcommon0 libatk-bridge2.0-0 libcups2 libsecret-1-0 \
      # virtual display + VNC server that resizes to the browser window (TigerVNC), a window manager, the browser client
      tigervnc-standalone-server tigervnc-tools openbox novnc websockify \
      # forwards localhost ports to services on the host (HOST_PORTS)
      socat \
      # what the app and Pi use at run time
      git openssh-client ripgrep fd-find rsync zsh procps dbus-x11 xclip curl ca-certificates fonts-noto fonts-noto-color-emoji \
      # a Chromium for Pi extensions that drive "chrome" through Playwright (Google ships no Chrome for Linux arm64)
      chromium \
      # node-pty build
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# fd as Pi expects it; Chromium where Playwright's "chrome" channel looks; git trusts the mounted repos (owned by your
# user on the host, root in here)
RUN ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && mkdir -p /opt/google/chrome && ln -s /usr/bin/chromium /opt/google/chrome/chrome \
    && git config --system --add safe.directory '*'

# Pi itself (ends up at /usr/local/bin/pi, which Pi Crust looks for)
RUN npm i -g @earendil-works/pi-coding-agent --allow-scripts=koffi,protobufjs,@google/genai

WORKDIR /opt/pi-crust
COPY package.json package-lock.json ./
# Fetch Electron's Linux binary now (not on first start) and build node-pty for it
RUN npm ci && node node_modules/electron/install.js && npx --no-install @electron/rebuild -f -w node-pty
COPY . .

COPY docker/openbox-rc.xml /etc/xdg/openbox/rc.xml
# Our noVNC page (⌘ → Ctrl, clipboard sync) at http://localhost:6080/; the stock one stays at /vnc.html
COPY docker/web/index.html /usr/share/novnc/index.html
# No browser in here: opened links go to the clipboard
COPY docker/xdg-open /usr/local/bin/xdg-open
RUN chmod +x /usr/local/bin/xdg-open
COPY docker/entrypoint.sh /usr/local/bin/pi-crust-entrypoint
RUN chmod +x /usr/local/bin/pi-crust-entrypoint

ENV DISPLAY=:99 SHELL=/bin/zsh SCREEN=1600x1000 PI_CRUST_CWD=/workspace BROWSER=/usr/local/bin/xdg-open
# Pi's OAuth callback servers listen on all interfaces, so your browser's redirect to localhost:<port> (published
# ports 53692 Claude, 1455 ChatGPT) reaches them
ENV PI_OAUTH_CALLBACK_HOST=0.0.0.0
# git reads the config the entrypoint writes: your host's .gitconfig plus container overrides
ENV GIT_CONFIG_GLOBAL=/root/.gitconfig-container
WORKDIR /workspace
# 6080 = Pi Crust in the browser (gate -> noVNC), 53692 + 1455 = login callbacks (Claude, ChatGPT)
EXPOSE 6080 53692 1455
ENTRYPOINT ["pi-crust-entrypoint"]
