import { createHash } from "node:crypto"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"

import type { Client } from "pg"

/**
 * Instantánea LÓGICA de PostgreSQL (Módulo 15).
 *
 * Por qué no `pg_dump`: Neon corre PostgreSQL 18 y el único `pg_dump`
 * disponible en la infraestructura del proyecto es 16 (no puede volcar un
 * servidor más nuevo). Esta exportación no depende de binarios externos.
 *
 * Consistencia: TODA la lectura ocurre en UNA transacción REPEATABLE READ
 * READ ONLY. Las evidencias privadas viven en la misma base
 * (`evidence_blobs`), así que datos, firmas y archivos quedan en el MISMO
 * punto de recuperación (no son dos respaldos «a la misma hora»).
 *
 * Formato (texto, una línea por registro, luego gzip + AES-256-GCM):
 *   H\t{cabecera}
 *   T\t<tabla>\t{columnas}
 *   R\t<tabla>\t<fila JSON tal como la entrega PostgreSQL>
 *   E\t{fin}
 * Cada tabla lleva conteo y SHA-256 de sus filas en orden de clave primaria.
 */

export const SNAPSHOT_FORMAT = "poker-manager-logical-v1"
const BATCH = 1000

export type TableStat = { rows: number; sha256: string }
export type EvidenceEntry = {
  fileId: string
  storageKey: string
  purpose: string
  status: string
  sha256: string
  sizeBytes: number
  /** Huella real del contenido en el instante del respaldo (null = falta). */
  actualSha256: string | null
  purchaseId: string | null
  settlementId: string | null
  signatureId: string | null
}

export type SnapshotHeader = {
  format: string
  recoveryPoint: string
  serverVersion: string
  schemaVersion: string | null
  migrations: string[]
}

export type SnapshotStats = {
  header: SnapshotHeader
  tables: Record<string, TableStat>
  evidence: EvidenceEntry[]
  rowCount: number
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`

export async function listTables(client: Client): Promise<string[]> {
  const r = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  )
  return r.rows.map((x) => x.table_name)
}

async function orderBy(client: Client, table: string) {
  const r = await client.query<{ attname: string }>(
    `SELECT a.attname FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
    [`public.${ident(table)}`]
  )
  return r.rows.length
    ? r.rows.map((x) => ident(x.attname)).join(", ")
    : "t::text"
}

async function* tableRows(client: Client, table: string) {
  const order = await orderBy(client, table)
  for (let offset = 0; ; offset += BATCH) {
    const r = await client.query<{ j: string }>(
      `SELECT row_to_json(t)::text AS j FROM ${ident(table)} t ORDER BY ${order} LIMIT ${BATCH} OFFSET ${offset}`
    )
    for (const row of r.rows) yield row.j
    if (r.rows.length < BATCH) break
  }
}

async function readHeader(client: Client): Promise<SnapshotHeader> {
  const [{ now, version }] = (
    await client.query<{ now: Date; version: string }>(
      `SELECT clock_timestamp() AS now, current_setting('server_version') AS version`
    )
  ).rows
  let migrations: string[] = []
  try {
    migrations = (
      await client.query<{ migration_name: string }>(
        `SELECT migration_name FROM "_prisma_migrations"
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
      )
    ).rows.map((r) => r.migration_name)
  } catch {
    migrations = []
  }
  return {
    format: SNAPSHOT_FORMAT,
    recoveryPoint: now.toISOString(),
    serverVersion: version,
    schemaVersion: migrations.at(-1) ?? null,
    migrations,
  }
}

/** Manifiesto de evidencias: archivo ↔ firma ↔ compra/liquidación + huellas. */
export async function readEvidence(client: Client): Promise<EvidenceEntry[]> {
  const r = await client.query<{
    id: string
    storageKey: string
    purpose: string
    status: string
    sha256: string
    sizeBytes: number
    actual: string | null
    purchaseId: string | null
    settlementId: string | null
    signatureId: string | null
  }>(`
    SELECT f."id", f."storageKey", f."purpose"::text AS purpose, f."status"::text AS status,
      f."sha256", f."sizeBytes", encode(sha256(b."bytes"), 'hex') AS actual,
      f."purchaseId", f."settlementId",
      COALESCE(ps."id", ss."id") AS "signatureId"
    FROM "stored_files" f
    LEFT JOIN "evidence_blobs" b ON b."storageKey" = f."storageKey"
    LEFT JOIN "purchase_signatures" ps ON ps."fileId" = f."id"
    LEFT JOIN "settlement_signatures" ss ON ss."fileId" = f."id"
    ORDER BY f."id"`)
  return r.rows.map((x) => ({
    fileId: x.id,
    storageKey: x.storageKey,
    purpose: x.purpose,
    status: x.status,
    sha256: x.sha256,
    sizeBytes: Number(x.sizeBytes),
    actualSha256: x.actual,
    purchaseId: x.purchaseId,
    settlementId: x.settlementId,
    signatureId: x.signatureId,
  }))
}

/** Problemas de evidencias (archivo activo faltante o alterado). */
export function evidenceProblems(entries: EvidenceEntry[]) {
  return entries
    .filter((e) => e.status === "ACTIVE")
    .filter((e) => e.actualSha256 === null || e.actualSha256 !== e.sha256)
    .map((e) => ({
      fileId: e.fileId,
      problem: e.actualSha256 === null ? "missing" : "hash-mismatch",
    }))
}

/**
 * Genera la instantánea (líneas de texto) dentro de una transacción
 * consistente y llena `stats` al terminar.
 */
export async function* exportSnapshot(
  client: Client,
  stats: Partial<SnapshotStats>
): AsyncGenerator<Buffer> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  try {
    const header = await readHeader(client)
    stats.header = header
    yield Buffer.from(`H\t${JSON.stringify(header)}\n`)
    const tables = await listTables(client)
    const tableStats: Record<string, TableStat> = {}
    let total = 0
    for (const table of tables) {
      const cols = (
        await client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
          [table]
        )
      ).rows.map((c) => c.column_name)
      yield Buffer.from(`T\t${table}\t${JSON.stringify({ columns: cols })}\n`)
      const hash = createHash("sha256")
      let n = 0
      let chunk: string[] = []
      for await (const j of tableRows(client, table)) {
        hash.update(j).update("\n")
        n += 1
        chunk.push(`R\t${table}\t${j}\n`)
        if (chunk.length >= 200) {
          yield Buffer.from(chunk.join(""))
          chunk = []
        }
      }
      if (chunk.length) yield Buffer.from(chunk.join(""))
      tableStats[table] = { rows: n, sha256: hash.digest("hex") }
      total += n
    }
    stats.evidence = await readEvidence(client)
    stats.tables = tableStats
    stats.rowCount = total
    yield Buffer.from(
      `E\t${JSON.stringify({ tables: tables.length, rows: total })}\n`
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  }
}

export type ParsedLine =
  | { kind: "H"; header: SnapshotHeader }
  | { kind: "T"; table: string; columns: string[] }
  | { kind: "R"; table: string; json: string }
  | { kind: "E"; info: { tables: number; rows: number } }

export function parseLine(line: string): ParsedLine {
  const k = line.slice(0, 1)
  if (line[1] !== "\t") throw new Error("Línea de respaldo inválida")
  const rest = line.slice(2)
  if (k === "H") return { kind: "H", header: JSON.parse(rest) }
  if (k === "E") return { kind: "E", info: JSON.parse(rest) }
  const tab = rest.indexOf("\t")
  if (tab < 0) throw new Error("Línea de respaldo inválida")
  const table = rest.slice(0, tab)
  const payload = rest.slice(tab + 1)
  if (k === "T")
    return { kind: "T", table, columns: JSON.parse(payload).columns }
  if (k === "R") return { kind: "R", table, json: payload }
  throw new Error(`Tipo de línea desconocido: ${k}`)
}

/** Recorre una instantánea en texto plano (ya descifrada y descomprimida). */
export async function* readSnapshot(
  plain: Readable
): AsyncGenerator<ParsedLine> {
  const rl = createInterface({ input: plain, crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.length === 0) continue
    yield parseLine(line)
  }
}

/** Recalcula conteos y huellas de una instantánea (verificación). */
export async function digestSnapshot(plain: Readable) {
  let header: SnapshotHeader | null = null
  let ended: { tables: number; rows: number } | null = null
  const hashes = new Map<string, ReturnType<typeof createHash>>()
  const counts = new Map<string, number>()
  for await (const l of readSnapshot(plain)) {
    if (l.kind === "H") header = l.header
    else if (l.kind === "T") {
      hashes.set(l.table, createHash("sha256"))
      counts.set(l.table, 0)
    } else if (l.kind === "R") {
      const h = hashes.get(l.table)
      if (!h) throw new Error(`Fila de una tabla no declarada: ${l.table}`)
      h.update(l.json).update("\n")
      counts.set(l.table, (counts.get(l.table) ?? 0) + 1)
    } else ended = l.info
  }
  const tables: Record<string, TableStat> = {}
  for (const [t, h] of hashes)
    tables[t] = { rows: counts.get(t) ?? 0, sha256: h.digest("hex") }
  return { header, ended, tables }
}

/** Compara dos mapas de tablas (conteo + huella). Devuelve diferencias. */
export function compareTables(
  expected: Record<string, TableStat>,
  actual: Record<string, TableStat>
) {
  const problems: { table: string; expected: string; actual: string }[] = []
  for (const [t, e] of Object.entries(expected)) {
    const a = actual[t]
    if (!a)
      problems.push({
        table: t,
        expected: `${e.rows} filas`,
        actual: "ausente",
      })
    else if (a.rows !== e.rows || a.sha256 !== e.sha256)
      problems.push({
        table: t,
        expected: `${e.rows} filas · ${e.sha256.slice(0, 12)}`,
        actual: `${a.rows} filas · ${a.sha256.slice(0, 12)}`,
      })
  }
  for (const t of Object.keys(actual))
    if (!expected[t])
      problems.push({
        table: t,
        expected: "ausente",
        actual: `${actual[t].rows} filas`,
      })
  return problems
}

/** Recalcula conteos y huellas DIRECTAMENTE de una base (p. ej. restaurada). */
export async function digestDatabase(client: Client, tables: string[]) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  try {
    const out: Record<string, TableStat> = {}
    for (const t of tables) {
      const hash = createHash("sha256")
      let n = 0
      for await (const j of tableRows(client, t)) {
        hash.update(j).update("\n")
        n += 1
      }
      out[t] = { rows: n, sha256: hash.digest("hex") }
    }
    await client.query("COMMIT")
    return out
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  }
}

/**
 * Carga una instantánea en una base de destino YA MIGRADA y VACÍA, en una
 * sola transacción. `session_replication_role = replica` desactiva
 * triggers y llaves foráneas durante la carga (las filas vienen de una
 * base consistente); requiere privilegios suficientes en el destino.
 */
export async function loadSnapshot(client: Client, plain: Readable) {
  // Las migraciones siembran catálogos (contenedores, folios, cuentas): el
  // destino AISLADO se vacía en la MISMA transacción antes de cargar.
  const existing = (await listTables(client)).filter(
    (t) => t !== "_prisma_migrations"
  )
  const loaded: Record<string, number> = {}
  let current: string | null = null
  let batch: string[] = []
  const flush = async () => {
    if (!current || batch.length === 0) return
    await client.query(
      `INSERT INTO ${ident(current)} SELECT * FROM json_populate_recordset(NULL::${ident(current)}, $1::json)`,
      [`[${batch.join(",")}]`]
    )
    loaded[current] = (loaded[current] ?? 0) + batch.length
    batch = []
  }
  await client.query("BEGIN")
  try {
    await client.query("SET LOCAL session_replication_role = replica")
    if (existing.length)
      await client.query(`TRUNCATE TABLE ${existing.map(ident).join(", ")}`)
    for await (const l of readSnapshot(plain)) {
      if (l.kind === "T") {
        await flush()
        current = l.table
        loaded[l.table] = 0
      } else if (l.kind === "R") {
        if (l.table === "_prisma_migrations") continue
        batch.push(l.json)
        if (batch.length >= 500) await flush()
      }
    }
    await flush()
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  }
  return loaded
}
