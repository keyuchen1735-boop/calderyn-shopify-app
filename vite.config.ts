import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

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
    reactRouter(),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
    sourcemap: false,
    minify: "esbuild",
  },
  // GSAP (used only by the client-side dashboard hero) is imported through a
  // server-reachable route module, so it lands in the server build. Left as an
  // external it resolves locally but breaks on Vercel: gsap exposes subpaths
  // like "gsap/CustomEase" only via a wildcard `exports` glob that Vercel's
  // dependency tracer (nft) cannot expand, so the file is absent in the lambda
  // and the import throws at module-init (every route 500s). Bundling gsap into
  // the server build removes the trace dependency entirely.
  ssr: {
    noExternal: ["gsap", "@gsap/react"],
  },
  esbuild: {
    legalComments: "none",
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react", "@shopify/polaris"],
  },
}) satisfies UserConfig;
