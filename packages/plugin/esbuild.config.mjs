import esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const serverBundlePath = resolve("../../build/.tmp/mcp-server.cjs");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
  plugins: [
    {
      name: "mcp-server-payload",
      setup(build) {
        build.onResolve({ filter: /^virtual:mcp-server-payload$/ }, (args) => ({
          path: args.path,
          namespace: "mcp-server-payload"
        }));
        build.onLoad({ filter: /.*/, namespace: "mcp-server-payload" }, async () => {
          const payload = await readFile(serverBundlePath, "utf8");
          return {
            contents: `export const MCP_SERVER_CJS = ${JSON.stringify(payload)};\n`,
            loader: "js"
          };
        });
      }
    }
  ]
});

if (watch) {
  await context.watch();
  console.log("Watching MCP Vault Bridge plugin...");
} else {
  await context.rebuild();
  await context.dispose();
}
