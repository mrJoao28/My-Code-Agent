import { defineConfig } from "prisma/config";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { myagentHome } from "@myagent/shared/home";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: pathToFileURL(join(myagentHome(), "myagent.db")).href,
  },
});
