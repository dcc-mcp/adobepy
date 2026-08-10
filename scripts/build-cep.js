#!/usr/bin/env node
"use strict";

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const targets = {
  "after-effects": { entry: "bridges/cep/after-effects/src/main.ts", outfile: "bridges/cep/after-effects/dist/main.js" },
  illustrator: { entry: "bridges/cep/illustrator/src/main.ts", outfile: "bridges/cep/illustrator/dist/main.js" },
};

async function buildTarget(name) {
  const target = targets[name];
  if (!target) throw new Error(`unknown CEP target: ${name}`);
  await esbuild.build({
    entryPoints: [path.join(root, target.entry)],
    outfile: path.join(root, target.outfile),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2018",
    sourcemap: true,
    logLevel: "silent",
  });
  fs.copyFileSync(
    path.join(root, "bridges/cep/core/host/dom.jsx"),
    path.join(path.dirname(path.join(root, target.outfile)), "dom.jsx"),
  );
  console.log(`built ${name}: ${target.outfile}`);
}

async function main() {
  const requested = process.argv[2] || "all";
  const names = requested === "all" ? Object.keys(targets) : [requested];
  for (const name of names) await buildTarget(name);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
