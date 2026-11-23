import { defineConfig } from "vite";

// API_PORT lets several dev servers run side by side, each talking to its own API.
const apiPort = process.env.API_PORT || 8787;

export default defineConfig({
  server: { port: 5173, proxy: { "/api": `http://localhost:${apiPort}` } },
});
