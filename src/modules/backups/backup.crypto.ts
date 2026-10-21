import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { open } from "node:fs/promises"
import { PassThrough, pipeline, type Readable, Transform } from "node:stream"

/**
 * Cifrado de artefactos (AES-256-GCM). Formato del archivo:
 *   "PMBK1" (5 bytes) | IV (12 bytes) | texto cifrado | etiqueta GCM (16 bytes)
 * La clave nunca se escribe en el archivo ni en el manifiesto (solo su huella).
 */

export const MAGIC = Buffer.from("PMBK1")
const IV_LEN = 12
const TAG_LEN = 16
export const HEADER_LEN = MAGIC.length + IV_LEN

/** Transform que cifra y antepone cabecera; agrega la etiqueta al final. */
export function encryptStream(key: Buffer): Transform {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  let headerSent = false
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!headerSent) {
        this.push(Buffer.concat([MAGIC, iv]))
        headerSent = true
      }
      cb(null, cipher.update(chunk))
    },
    flush(cb) {
      if (!headerSent) this.push(Buffer.concat([MAGIC, iv]))
      const final = cipher.final()
      cb(null, Buffer.concat([final, cipher.getAuthTag()]))
    },
  })
}

/**
 * Abre un artefacto cifrado y devuelve un Readable con el texto plano. La
 * etiqueta GCM se valida al final: si el archivo fue alterado, el stream
 * emite error (nunca entrega datos manipulados como válidos).
 */
export async function decryptFile(
  path: string,
  key: Buffer,
  transforms: Transform[] = []
): Promise<Readable> {
  const fh = await open(path, "r")
  const { size } = await fh.stat()
  if (size < HEADER_LEN + TAG_LEN) {
    await fh.close()
    throw new Error("Artefacto demasiado corto o vacío")
  }
  const header = Buffer.alloc(HEADER_LEN)
  await fh.read(header, 0, HEADER_LEN, 0)
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    await fh.close()
    throw new Error("Formato de artefacto desconocido")
  }
  const tag = Buffer.alloc(TAG_LEN)
  await fh.read(tag, 0, TAG_LEN, size - TAG_LEN)
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    header.subarray(MAGIC.length)
  )
  decipher.setAuthTag(tag)
  const body = fh.createReadStream({
    start: HEADER_LEN,
    end: size - TAG_LEN - 1,
  })
  body.on("close", () => void fh.close().catch(() => {}))
  // pipeline propaga cualquier error (p. ej. etiqueta GCM inválida) al
  // stream que recibe el consumidor: nunca queda un error sin manejar.
  const out = new PassThrough()
  pipeline([body, decipher, ...transforms, out], (err) => {
    if (err) out.destroy(err)
  })
  return out
}
