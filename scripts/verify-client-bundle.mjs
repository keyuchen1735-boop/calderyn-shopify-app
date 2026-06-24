import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../build/client/", import.meta.url));
const forbidden = [
  "sourceMappingURL",
  "/@vite/client",
  "__vite_ping",
  "__activate_edit_mode",
  "__deactivate_edit_mode",
  "__edit_mode_available",
  "__edit_mode_dismissed",
  "window.omelette",
  "data-omelette-chrome",
  "vibecod",
  "vibe-coded",
];

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

const outputFiles = await files(root);
const maps = outputFiles.filter((file) => extname(file) === ".map");
if (maps.length > 0) {
  throw new Error(`Client source maps must not ship:\n${maps.join("\n")}`);
}

for (const file of outputFiles.filter((path) => /\.(?:js|css|html)$/.test(path))) {
  const contents = await readFile(file, "utf8");
  for (const marker of forbidden) {
    if (contents.toLowerCase().includes(marker.toLowerCase())) {
      throw new Error(`Forbidden client marker "${marker}" found in ${file}`);
    }
  }
}

console.log(`Verified ${outputFiles.length} client files: no source maps, HMR client, or dev bridges.`);
