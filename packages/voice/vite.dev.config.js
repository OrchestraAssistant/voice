import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dev-only server for dev/stress.html -- the "hostile host" harness that
// mounts the rim into a page doing everything a real app might do to break
// an overlay (transformed/contained ancestors, !important resets, top-layer
// chrome). Never part of the published package; `files` in package.json
// ships dist/ only.
export default defineConfig({
  root: "dev",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  // Proxy /voice to a local voice backend on :3002 -- your mounted handler, or
  // a relay. Without it the harness cannot reach the backend at all: this page
  // is served over https through the tunnel, and an https page fetching
  // http://localhost is blocked as mixed content, so pointing the widget
  // straight at :3002 fails silently and the settings tab just has nothing to
  // offer.
  server: {
    host: true,
    port: 5174,
    // Vite rejects a Host header it does not recognise with a 400 ("Blocked
    // request"). Served through the hub tunnel the host is *.hub.tailnet, so
    // allow it -- this is a dev-only harness, never shipped.
    allowedHosts: true,
    proxy: { "/voice": "http://localhost:3002" },
  },
});
