/**
 * @fileoverview Runtime configuration loading for packaged and development app launches.
 *
 * Finder-launched macOS apps do not inherit shell exports. This module loads
 * Browserbase environment values from predictable local files before the
 * Browserbase client is constructed.
 */

import { app } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENV_FILENAMES = [".env", "browserbase.env"];

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
  } else {
    const commentIndex = value.search(/\s#/);
    if (commentIndex !== -1) {
      value = value.slice(0, commentIndex).trim();
    }
  }

  return [key, value];
}

function loadEnvFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (!entry) {
      continue;
    }

    const [key, value] = entry;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return true;
}

export function getConfigSearchPaths(): string[] {
  const searchDirectories = [
    process.cwd(),
    app.getPath("userData"),
    os.homedir(),
  ];

  return searchDirectories.flatMap((directory) =>
    ENV_FILENAMES.map((filename) => path.join(directory, filename))
  );
}

export function loadEnvironmentConfig(): string[] {
  const loadedFiles: string[] = [];

  for (const filePath of getConfigSearchPaths()) {
    try {
      if (loadEnvFile(filePath)) {
        loadedFiles.push(filePath);
      }
    } catch (error) {
      console.warn(`Failed to load config file ${filePath}:`, error);
    }
  }

  return loadedFiles;
}
