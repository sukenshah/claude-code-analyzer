import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "serve-repo-docs",
      configureServer(server) {
        server.middlewares.use("/docs", (req, res, next) => {
          const filePath = path.resolve(__dirname, "../docs", (req.url ?? "").replace(/^\//, ""));
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath);
            if (ext === ".svg") res.setHeader("Content-Type", "image/svg+xml");
            fs.createReadStream(filePath).pipe(res as NodeJS.WritableStream);
          } else {
            next();
          }
        });
      },
    },
  ],
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
