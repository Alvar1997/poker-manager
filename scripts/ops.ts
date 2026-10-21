/**
 * Procedimientos operativos del Módulo 15 (CLI). NO hay equivalentes HTTP:
 * respaldos, verificación, pruebas de restauración y recuperación corren
 * aquí, con las variables de entorno del proceso (nunca del navegador).
 *
 *   npm run ops -- status
 *   npm run backup:run                  (respaldo manual)
 *   npm run backup:daily                (lo invoca la tarea programada)
 *   npm run ops -- backup:verify <id>
 *   npm run restore:test [-- <backupId>] [--keep]
 *   npm run restore:monthly             (tarea programada mensual)
 *   npm run integrity:run
 *   npm run recovery:execute -- <restoreRequestId>
 *
 * Salida: JSON con el resultado REAL. Código de salida ≠ 0 si falló o si
 * la configuración está incompleta (la tarea programada lo detecta).
 */
import { userInfo } from "node:os"

import { getBackupConfig } from "@/modules/backups/backup.config"
import {
  backupAutomationStatus,
  runBackup,
  verifyBackup,
} from "@/modules/backups/backup.service"
import { executeRecovery } from "@/modules/backups/recovery.service"
import { runRestoreTest } from "@/modules/backups/restore.service"
import { runIntegrityCheck } from "@/modules/integrity/integrity.service"
import { prisma } from "@/lib/prisma"

const [command, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((a) => a.startsWith("--")))
const args = rest.filter((a) => !a.startsWith("--"))

function out(result: unknown, ok: boolean) {
  console.log(
    JSON.stringify(
      result,
      (_k, v) => (typeof v === "bigint" ? Number(v) : v),
      2
    )
  )
  process.exitCode = ok ? 0 : 1
}

async function main() {
  switch (command) {
    case "status": {
      const config = getBackupConfig()
      const status = await backupAutomationStatus()
      return out(
        {
          configured: config.configured,
          missing: config.missing,
          restoreTestConfigured: Boolean(config.restoreTestUrl),
          recoveryTargetConfigured: Boolean(config.recoveryTargetUrl),
          keyFingerprint: config.keyFingerprint,
          automation: status.automation,
          lastSuccess: status.lastSuccess?.startedAt ?? null,
          lastFailure: status.lastFailure?.startedAt ?? null,
        },
        true
      )
    }
    case "backup:run": {
      const r = await runBackup({
        trigger: flags.has("--scheduled") ? "SCHEDULED" : "MANUAL",
      })
      return out(r, r.status === "SUCCESS" || r.status === "SKIPPED")
    }
    case "backup:verify": {
      if (!args[0]) throw new Error("Uso: backup:verify <backupId>")
      const r = await verifyBackup(args[0], null)
      return out(r, r.ok)
    }
    case "restore:test": {
      const r = await runRestoreTest({
        backupId: args[0],
        trigger: flags.has("--scheduled") ? "SCHEDULED" : "MANUAL",
        keep: flags.has("--keep"),
      })
      return out(r, r.status === "PASSED")
    }
    case "integrity:run": {
      const r = await runIntegrityCheck(null, {
        trigger: flags.has("--scheduled") ? "SCHEDULED" : "MANUAL",
      })
      return out(r, r.summary.overall !== "ERROR")
    }
    case "recovery:execute": {
      if (!args[0]) throw new Error("Uso: recovery:execute <restoreRequestId>")
      const r = await executeRecovery(args[0], userInfo().username)
      return out(r, r.passed)
    }
    default:
      throw new Error(
        "Comando desconocido. Usa: status | backup:run [--scheduled] | backup:verify <id> | restore:test [id] [--scheduled] [--keep] | integrity:run | recovery:execute <id>"
      )
  }
}

main()
  .catch((error: unknown) => {
    out(
      {
        status: "ERROR",
        error: error instanceof Error ? error.message : String(error),
      },
      false
    )
  })
  .finally(() => prisma.$disconnect())
