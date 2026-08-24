"use strict";

const fs = require("fs");
const path = require("path");

function fail(message) {
  throw new Error(`release version projection failed: ${message}`);
}

function parseArgs(argv) {
  const options = { root: ".", expected: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--root" && argument !== "--expected") {
      fail(`unknown argument ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) {
      fail(`missing value for ${argument}`);
    }
    if (argument === "--root") {
      options.root = value;
    } else {
      options.expected = value;
    }
    index += 1;
  }
  return options;
}

function readJson(root, relativePath) {
  const filePath = path.join(root, relativePath);
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`cannot read ${relativePath}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON in ${relativePath}: ${error.message}`);
  }
}

function readPyprojectVersion(root) {
  const relativePath = "pyproject.toml";
  let text;
  try {
    text = fs.readFileSync(path.join(root, relativePath), "utf8");
  } catch (error) {
    fail(`cannot read ${relativePath}: ${error.message}`);
  }
  let inProject = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inProject = trimmed === "[project]";
      continue;
    }
    if (inProject) {
      const version = line.match(/^version\s*=\s*"([^"]+)"\s*$/);
      if (version) {
        return version[1];
      }
    }
  }
  fail(`${relativePath} [project] has no string version`);
}

function assertVersion(label, value, expected) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} is missing`);
  }
  if (value !== expected) {
    fail(`${label} is ${JSON.stringify(value)}, expected ${JSON.stringify(expected)}`);
  }
}

function check(options) {
  const root = path.resolve(options.root);
  const packageJson = readJson(root, "package.json");
  const packageLock = readJson(root, "package-lock.json");
  const expected = options.expected || packageJson.version;

  assertVersion("package.json version", packageJson.version, expected);
  assertVersion("pyproject.toml project.version", readPyprojectVersion(root), expected);
  assertVersion("package-lock.json version", packageLock.version, expected);
  assertVersion(
    'package-lock.json packages[""].version',
    packageLock.packages && packageLock.packages[""] && packageLock.packages[""].version,
    expected
  );

  const releaseManifestPath = path.join(root, ".github", "release-please-manifest.json");
  const packageManifestPath = path.join(root, "package-manifest.json");
  let manifestFound = false;
  if (fs.existsSync(releaseManifestPath)) {
    const releaseManifest = readJson(root, path.join(".github", "release-please-manifest.json"));
    assertVersion("release-please manifest version", releaseManifest["."], expected);
    manifestFound = true;
  }
  if (fs.existsSync(packageManifestPath)) {
    const packageManifest = readJson(root, "package-manifest.json");
    assertVersion("package manifest version", packageManifest.version, expected);
    manifestFound = true;
  }
  if (!manifestFound) {
    fail("no release or package manifest is present");
  }

  process.stdout.write(`Release version projection is consistent at ${expected}.\n`);
}

try {
  check(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
