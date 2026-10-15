import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tailwindShadowDomProperties } from "./tailwindProperties.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Library build: emits dist/voice.js + dist/voice.css.
//
// react/react-dom stay external (peer deps) so a host app never ends up
// with two copies of React -- the classic cause of "invalid hook call".
// framer-motion is bundled: it's an implementation detail of the widget,
// and a host shouldn't have to install it to use us.
export default defineConfig({
  plugins: [react(), tailwindcss(), tailwindShadowDomProperties()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.js"),
      formats: ["es"],
      fileName: () => "voice.js",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
      output: {
        assetFileNames: "voice.[ext]",
      },
    },
    cssCodeSplit: false,
  },
});
