import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENV_PATH = join(process.cwd(), ".env");

function escapeEnvValue(value: string) {
  if (value.includes("\0")) throw new Error("Valor de ambiente inválido");
  for (const quote of ["'", "`", '"']) {
    if (!value.includes(quote) && !(quote === '"' && /\\[nr]/.test(value))) return quote + value + quote;
  }
  throw new Error("Valor não pode ser representado com segurança no arquivo .env");
}

export function upsertEnvValue(key: string, value: string, envPath = ENV_PATH) {
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
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

  writeFileSync(envPath, lines.join("\n"), "utf8");
  process.env[key] = value;
}
