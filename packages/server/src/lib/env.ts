import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENV_PATH = join(process.cwd(), ".env");

function escapeEnvValue(value: string) {
  return JSON.stringify(value);
}

export function upsertEnvValue(key: string, value: string) {
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=`);
  const nextLine = `${key}=${escapeEnvValue(value)}`;
  const index = lines.findIndex((line) => pattern.test(line));

  if (index >= 0) {
    lines[index] = nextLine;
  } else {
    if (lines.length === 1 && lines[0] === "") {
      lines[0] = nextLine;
    } else {
      lines.push(nextLine);
    }
  }

  writeFileSync(ENV_PATH, lines.join("\n"), "utf8");
  process.env[key] = value;
}
