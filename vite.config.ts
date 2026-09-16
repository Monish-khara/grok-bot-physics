import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4738,
    strictPort: true,
    host: "127.0.0.1",
  },
});
