import dotenv from "dotenv";
import { resolve } from "node:path";
import { defineConfig, env } from "prisma/config";

dotenv.config({
  path: resolve(import.meta.dirname, "../../.env"),
});

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
