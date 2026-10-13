/**
 * Resolución y salvaguarda de la base de pruebas. Las pruebas de
 * integración y E2E VACÍAN tablas: nunca deben apuntar a una base real.
 */
export function resolveTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    throw new Error(
      "Falta TEST_DATABASE_URL. Levanta una base desechable (p. ej. " +
        "`npx prisma dev -n poker-test -d`) y exporta su URL TCP — ver docs/SETUP.md."
    )
  }

  const host = new URL(url).hostname
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(host)
  if (!isLocal && process.env.ALLOW_REMOTE_TEST_DATABASE !== "1") {
    throw new Error(
      `TEST_DATABASE_URL apunta a ${host}. Las pruebas borran datos: solo se ` +
        "permite una base local (o define ALLOW_REMOTE_TEST_DATABASE=1 si es " +
        "una rama desechable)."
    )
  }
  return url
}
