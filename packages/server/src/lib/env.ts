import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { myagentHome } from "@myagent/shared/home";
import { parse } from "dotenv";

const ENV_PATH = join(myagentHome(), "config.env");

export function loadGlobalConfig(envPath = ENV_PATH, modelPath = join(myagentHome(), "models.json")) {
  if (!existsSync(envPath)) return;
  const customKeys = new Set<string>();
  try {
    const models: unknown = existsSync(modelPath) ? JSON.parse(readFileSync(modelPath, "utf8")) : [];
    if (Array.isArray(models)) for (const model of models) {
      const key = model?.apiKeyEnv;
      if (typeof key === "string" && /^[A-Z_][A-Z0-9_]*$/.test(key)
          && !/^(PATH|HOME|USERPROFILE|SYSTEMROOT|TEMP|TMP|NODE_.+|BUN_.+|LD_.+|DYLD_.+|MYAGENT_(HOME|CONFIG_DIR|WORKSPACE_ROOTS|API_TOKEN|SANDBOX_IMAGE))$/.test(key)) customKeys.add(key);
    }
  } catch { /* Um registro inválido não concede variáveis extras. */ }
  for (const [key, value] of Object.entries(parse(readFileSync(envPath, "utf8")))) {
    if ((customKeys.has(key) || /^(MYAGENT_[A-Z0-9_]+_API_KEY|OLLAMA_BASE_URL|OLLAMA_API_KEY|TAVILY_API_KEY)$/.test(key)) && process.env[key] === undefined) process.env[key] = value;
  }
}

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

  mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
  writeFileSync(envPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  process.env[key] = value;
}
