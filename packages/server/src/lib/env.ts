import { readPrivateConfig, writePrivateConfig } from "./private-config";
import { readModelConfig } from "./model-config";
import { join } from "node:path";
import { myagentHome } from "@myagent/shared/home";
import { parse } from "dotenv";

const ENV_PATH = join(myagentHome(), "config.env");

export function loadGlobalConfig(envPath = ENV_PATH, modelPath = join(myagentHome(), "models.json")) {
  const models = readModelConfig(modelPath);
  const current = readPrivateConfig(envPath);
  if (current === undefined) return;
  const customKeys = new Set(models.flatMap(model => model.apiKeyEnv ? [model.apiKeyEnv] : []));
  for (const [key, value] of Object.entries(parse(current))) {
    if ((customKeys.has(key) || /^(MYAGENT_[A-Z0-9_]+_API_KEY|OLLAMA_BASE_URL|OLLAMA_API_KEY|TAVILY_API_KEY|MYAGENT_ENABLE_CHATGPT|MYAGENT_GIT_ALLOWED_HOSTS)$/.test(key)) && process.env[key] === undefined) process.env[key] = value;
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
  const current = readPrivateConfig(envPath) ?? "";
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

  writePrivateConfig(envPath, lines.join("\n"));
  process.env[key] = value;
}
