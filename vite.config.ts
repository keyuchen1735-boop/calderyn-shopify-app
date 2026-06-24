import { vitePlugin as remix } from "@remix-run/dev";
import { vercelPreset } from "@vercel/remix/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

declare module "@remix-run/node" {
  interface Future {
    v3_singleFetch: true;
  }
}

const appUrl = new URL(process.env.SHOPIFY_APP_URL || "http://localhost");
const host = appUrl.hostname;
const hmrEnabled = process.env.ENABLE_DEV_HMR === "true";
const hmrConfig =
  host === "localhost"
    ? {
        protocol: "ws" as const,
        host: "localhost",
        port: 64999,
        clientPort: 64999,
      }
    : {
        protocol: "wss" as const,
        host,
        port: Number(process.env.FRONTEND_PORT) || 8002,
        clientPort: 443,
      };

export default defineConfig({
  server: {
    allowedHosts: [host],
    port: Number(process.env.PORT || 3000),
    strictPort: true,
    hmr: hmrEnabled ? hmrConfig : false,
    fs: {
      strict: true,
      allow: ["app", "node_modules"],
      deny: [".env", ".env.*", "*.pem", "*.key", "*.crt", ".git/**"],
    },
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  },
  plugins: [
    {
      name: "reject-disabled-websocket-upgrades",
      configureServer(server) {
        if (hmrEnabled) return;
        server.httpServer?.on("upgrade", (_request, socket) => {
          socket.write(
            "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
          socket.destroy();
        });
      },
    },
    remix({
      ignoredRouteFiles: ["**/.*"],
      presets: [vercelPreset()],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_lazyRouteDiscovery: true,
        v3_singleFetch: true,
        v3_routeConfig: true,
      },
    }),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
    sourcemap: false,
    minify: "esbuild",
  },
  esbuild: {
    legalComments: "none",
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react", "@shopify/polaris"],
  },
}) satisfies UserConfig;
