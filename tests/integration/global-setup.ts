import { execSync } from "node:child_process"

import { resolveTestDatabaseUrl } from "./test-db"

/** Aplica las migraciones versionadas a la base de pruebas antes de correr. */
export default function setup() {
  const url = resolveTestDatabaseUrl()
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DIRECT_URL: url },
  })
}
