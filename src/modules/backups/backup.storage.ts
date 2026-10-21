import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { chmod, link, mkdir, readdir, rm, stat, unlink } from "node:fs/promises"
import { dirname, join, normalize, relative, resolve, sep } from "node:path"
import type { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

/**
 * Destino de respaldos en SISTEMA DE ARCHIVOS (único driver configurable
 * hoy en el proyecto: no hay credenciales de almacenamiento externo). Los
 * artefactos se escriben de forma atómica (temporal + enlace sin
 * sobrescritura), se dejan de solo lectura y nunca se reemplazan.
 * Recomendado: un volumen externo o una carpeta sincronizada fuera del
 * equipo operativo (separación del entorno).
 */

export class FilesystemBackupStorage {
  readonly driver = "filesystem"
  constructor(private readonly root: string) {}

  private abs(rel: string) {
    const target = resolve(this.root, normalize(rel))
    const r = relative(resolve(this.root), target)
    if (r.startsWith("..") || r.includes(`..${sep}`))
      throw new Error("Ruta de respaldo fuera del destino")
    return target
  }

  async ensureWritable() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const probe = join(this.root, `.probe-${process.pid}-${Date.now()}`)
    await pipeline(
      (async function* () {
        yield Buffer.from("ok")
      })(),
      createWriteStream(probe, { flags: "wx", mode: 0o600 })
    )
    await unlink(probe)
  }

  /** Escribe `source` en `rel` (falla si ya existe). Devuelve tamaño y SHA-256. */
  async put(rel: string, source: Readable | AsyncIterable<Buffer>) {
    const final = this.abs(rel)
    await mkdir(dirname(final), { recursive: true, mode: 0o700 })
    const tmp = `${final}.partial-${process.pid}-${Date.now()}`
    const hash = createHash("sha256")
    let size = 0
    try {
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const c of chunks) {
            hash.update(c)
            size += c.length
            yield c
          }
        },
        createWriteStream(tmp, { flags: "wx", mode: 0o600 })
      )
      // link() falla si el destino existe: nunca se sobrescribe un respaldo.
      await link(tmp, final)
      await chmod(final, 0o400)
    } finally {
      await unlink(tmp).catch(() => {})
    }
    return { path: rel, sizeBytes: size, sha256: hash.digest("hex") }
  }

  pathOf(rel: string) {
    return this.abs(rel)
  }

  async exists(rel: string) {
    try {
      await stat(this.abs(rel))
      return true
    } catch {
      return false
    }
  }

  async sha256(rel: string) {
    const hash = createHash("sha256")
    let size = 0
    for await (const c of createReadStream(
      this.abs(rel)
    ) as AsyncIterable<Buffer>) {
      hash.update(c)
      size += c.length
    }
    return { sha256: hash.digest("hex"), sizeBytes: size }
  }

  async remove(rel: string) {
    await rm(this.abs(rel), { force: true })
  }

  async list(dir = "") {
    const out: string[] = []
    const walk = async (d: string) => {
      let entries: string[] = []
      try {
        entries = await readdir(this.abs(d))
      } catch {
        return
      }
      for (const e of entries) {
        const rel = d ? `${d}/${e}` : e
        const st = await stat(this.abs(rel))
        if (st.isDirectory()) await walk(rel)
        else out.push(rel)
      }
    }
    await walk(dir)
    return out
  }
}
