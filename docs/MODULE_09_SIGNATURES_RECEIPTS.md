# Módulo 09 — Firmas de reconocimiento de crédito y comprobantes digitales

> **Estado:** implementado (2026-10-23, fecha de la migración). Con este módulo las entregas **con crédito** del Módulo 08 quedan habilitadas: requieren la firma real del jugador capturada en el dispositivo del cajero.

**Regla final:** cada compra o recompra que genere crédito cuenta con una firma individual del jugador, hecha en el dispositivo del cajero sobre un resumen exacto e inmutable de esa compra. La firma no entrega fichas. El cajero confirma la entrega después, y solo entonces el Módulo 08 aplica inventario, pagos y crédito. Toda compra confirmada genera un comprobante digital, descargable en PNG y compartible manualmente. No hay PDF ni envío de WhatsApp.

## 1. Firma condicional

Solo se pide firma si el saldo por cobrar (`importe − pagos confirmados`) es mayor que cero, aunque sea parcial (FIR-01/02). Las transferencias pendientes forman parte de ese saldo. Una compra pagada por completo se entrega sin firma y sin socio autorizador.

## 2. Firma por recompra

Cada compra con crédito tiene su propia firma (FIR-03/04). Una firma pertenece a un solo snapshot (`snapshotId` único), y el snapshot a una sola compra y jugador. La base comprueba que una entrega solo use una firma VALID **de la misma compra** (trigger `purchase_deliveries_signature_check`) y que `signatureId` no se repita.

## 3. Flujo de captura

1. Compra con importe, pagos y socio autorizador (Módulo 08).
2. `POST /api/purchases/:id/signature-summary`: el servidor prepara el resumen.
3. Pantalla `/compras/[id]/firma`: el jugador revisa el resumen y el cajero marca que lo revisó. El jugador firma con el dedo o un stylus y puede borrar y repetir.
4. `POST /api/purchases/:id/signatures` envía los **trazos**, el id del resumen y su huella. El servidor genera el PNG, lo guarda en privado y registra la firma VALID.
5. «Firma registrada. El cajero debe confirmar la entrega.» El cajero confirma con `POST /api/purchases/:id/confirm-delivery` (Módulo 08).

El operador está autenticado; el jugador no necesita cuenta (FIR-08/09/10). Si el navegador se cierra tras firmar, la firma se conserva y la compra sigue pendiente; al volver se revalida todo.

## 4. Snapshot

`SignatureSnapshot` guarda exactamente lo que vio el jugador:

- jugador, sesión y mesa (con nombres históricos) y folio;
- tipo y número de compra **proyectados**;
- importe, pagos confirmados por método, transferencias pendientes y saldo a crédito;
- socio, medio y autorización;
- declaración con su versión, versión de la compra, fecha y responsable.

El navegador recibe el documento ya preparado; nunca construye importes. Es historia, no fuente del saldo actual. Es inmutable (trigger) y se reutiliza si el contenido no cambió (único por compra y contenido).

## 5. Declaración

La declaración vive en `signature.declaration.ts`, versionada (`2026-10-v1`), y conserva el texto pedido por el negocio. Un texto firmado nunca cambia: para modificarlo se agrega otra versión. Una compra no entregada con una versión anterior debe firmarse de nuevo.

## 6. Hash

La serialización es canónica (`src/lib/canonical-json.ts`): claves ordenadas e importes como texto decimal; si llega un número no entero, se rechaza. Se usa SHA-256 en dos huellas:

- **`contentHash`** (sin fecha de preparación) detecta cambios materiales.
- **`payloadHash`** (todo lo mostrado) es la huella de integridad que el cliente devuelve al firmar.

Antes de firmar y al entregar, el servidor reconstruye el contenido desde las columnas guardadas para detectar manipulación, y lo compara con el contenido vigente de la compra.

## 7. Almacenamiento privado

No había infraestructura de archivos ni credenciales de almacenamiento de objetos. Se implementó un adaptador (`evidence-storage.ts`) con driver **PostgreSQL privado**:

- El binario se guarda en `evidence_blobs`, tabla aparte; nunca en `chip_purchases` ni en Base64.
- Los metadatos van en `stored_files`: clave aleatoria no enumerable, SHA-256, MIME, tamaño, estado, compra y fechas.
- Nada se guarda en el disco del servidor, en carpetas públicas ni con URL pública.
- Solo `/api/purchases/:id/signature-evidence` lo sirve, tras autorizar, con `Cache-Control: private, no-store`.

Se puede registrar otro driver (S3/R2 privado) con la misma interfaz cuando existan credenciales; **no se incluye ni se simula**.

**Consistencia:** subida PENDING fuera de la transacción → validación y promoción a ACTIVE dentro de la transacción de la firma → si falla, el archivo pasa a ORPHANED y se borra su contenido. `cleanupOrphanedFiles` recupera fallos parciales (PENDING antiguos). Una evidencia ACTIVE nunca se borra ni se sustituye (triggers).

## 8. Integridad de evidencias

- La firma llega como trazos: coordenadas enteras en un lienzo lógico de 1000 × 400, sin presión ni tiempos.
- El servidor rechaza trazos vacíos o triviales (puntos, longitud, ancho y alto mínimos) y genera un PNG en escala de grises determinista, sin metadatos (`signature.strokes.ts`).
- No se puede subir una imagen arbitraria (FIR-11/12): el schema rechaza cualquier campo extra.
- La huella de la imagen se verifica al servirla y al entregar.

No es verificación biométrica de la identidad ni firma electrónica avanzada: es evidencia operativa de aceptación, respaldada por el historial y la auditoría.

## 9. Invalidación

Todo cambio material antes de entregar incrementa la versión de la compra (`bumpPurchaseVersionInTx`) e invalida la firma VALID en la misma transacción (`invalidatePurchaseSignaturesInTx`), con motivo, responsable y fecha. Son cambios materiales:

- el importe;
- un pago nuevo, retirado o resuelto en terminal;
- un socio o autorización nuevos;
- una transferencia verificada o rechazada;
- la declaración o la numeración proyectada (esto lo detecta la preparación).

La firma anterior se conserva como evidencia (`INVALIDATED`) y se pide un snapshot y una firma nuevos. Cancelar la compra deja la firma en `CANCELLED`. Después de entregar, la base impide invalidarla: un abono posterior no afecta la firma original.

## 10. Firma y entrega separadas

Firmar **no** genera salida de fichas, pagos, crédito confirmado, movimientos de banco o efectivo ni comprobante (FIR-16; probado). La entrega sigue siendo exclusiva del Módulo 08 (FIR-17). Al cancelar: la firma se conserva, no hay deuda, se libera la reserva y no hay entrega.

## 11. Confirmación transaccional

El verificador real (`moduleSignatureVerifier` → `findValidPurchaseSignatureInTx`) corre **dentro** de la transacción de entrega, con la compra ya bloqueada. Bloquea la firma VALID (`FOR UPDATE`) y comprueba:

- el jugador;
- la versión;
- la integridad del snapshot;
- que el contenido vigente sea exactamente el firmado;
- la evidencia ACTIVE con su huella.

Como todo cambio material bloquea antes la compra, una invalidación simultánea espera o hace fallar la entrega (probado). Si al asignar la numeración real el tipo o número no coincide con lo firmado (otra compra del jugador se entregó antes), se rechaza: «La compra cambió… firmar nuevamente». Después se ejecuta el flujo existente del Módulo 08: salida nominal, asientos, deuda y outbox, una sola vez.

## 12. Comprobante digital

Se crea un `PurchaseReceipt` en la **misma** transacción de cada entrega confirmada, con o sin crédito. Hay uno por compra y la base solo lo permite para compras CONFIRMED.

**Contenido** (snapshot inmutable con huella):

- folio, fecha, jugador, sesión, mesa, tipo y número;
- importe entregado y pagos por método **al momento de la entrega** (una transferencia verificada después no lo altera);
- pagos confirmados, transferencia pendiente, crédito inicial y socio;
- estado de entrega, cajero, firma y referencias de operación.

Nunca incluye denominaciones, teléfonos ni datos de tarjeta. Para compras confirmadas antes de este módulo (no había en Neon), se genera desde la entrega registrada al consultarlo. Pantalla: `/compras/[id]/comprobante`.

## 13. Imagen PNG

`GET /api/purchases/:id/receipt/image` genera el PNG en el servidor con `next/og`, que ya trae Next, sin dependencias nuevas.

- **Origen y consistencia:** se construye desde el snapshot confirmado (no es una captura de pantalla) y usa los mismos renglones (`receiptLines`) que la pantalla.
- **Firma:** se incluye solo si el usuario tiene `signatures:read`.
- **Descarga:** `Content-Disposition: attachment`; en la respuesta no hay PDF.

## 14. Compartición manual

En la pantalla del comprobante:

- **Descargar imagen.**
- **Compartir:** usa el menú nativo del dispositivo (`navigator.share` con archivo) si existe; si no, descarga la imagen para compartirla a mano.
- **Copiar resumen** (texto sin datos sensibles).

Nada se envía automáticamente y no se afirma que algo se envió («Se abrió el menú para compartir»). No hay enlaces públicos.

## 15. Seguridad

- Autenticación y permisos en el servidor.
- Evidencia privada, sin URLs públicas y con claves no enumerables.
- La firma de otra compra responde 404.
- Validación de MIME y tamaño (≤ 200 KB), PNG sin metadatos.
- Anti-reutilización: snapshot único por firma, una VALID por compra y entrega solo con firma de la misma compra.
- Anti-manipulación: triggers de inmutabilidad y doble huella.
- Anti-replay: claves de idempotencia y versión esperada.
- Auditoría sin imágenes.

Un usuario desactivado pierde el acceso de inmediato (Módulo 01). La retención y eliminación de evidencias quedan sujetas a una política formal: no hay borrado.

## 16. Permisos

| Acción                                  | Permiso              | SUPERADMIN | PARTNER | CASHIER |
| --------------------------------------- | -------------------- | :--------: | :-----: | :-----: |
| Preparar resumen y capturar firma       | `signatures:capture` |     ✅     |   ✅    |   ✅    |
| Ver estado y evidencia de firma         | `signatures:read`    |     ✅     |   ✅    |   ✅    |
| Ver, descargar y compartir comprobantes | `purchases:read`     |     ✅     |   ✅    |   ✅    |
| Confirmar la entrega (Módulo 08)        | `purchases:create`   |     ✅     |   ✅    |   ✅    |

Nadie puede editar o sustituir una firma, marcarla válida, reutilizarla, borrar comprobantes ni entregar con crédito sin firma: no existe el endpoint y la base lo impide.

## 17. Endpoints

| Método y ruta                                  | Permiso              | Descripción                                |
| ---------------------------------------------- | -------------------- | ------------------------------------------ |
| `GET /api/purchases/:id/signature-summary`     | `signatures:read`    | Estado y último resumen (lectura)          |
| `POST /api/purchases/:id/signature-summary`    | `signatures:capture` | Prepara/reutiliza el snapshot              |
| `POST /api/purchases/:id/signatures`           | `signatures:capture` | Captura (trazos + id y huella del resumen) |
| `GET /api/purchases/:id/signatures/status`     | `signatures:read`    | Firma vigente e historial                  |
| `GET /api/purchases/:id/signature-evidence`    | `signatures:read`    | PNG privado (`?signatureId=` opcional)     |
| `GET /api/purchases/:id/receipt`               | `purchases:read`     | Comprobante digital                        |
| `GET /api/purchases/:id/receipt/image`         | `purchases:read`     | PNG descargable                            |
| `POST /api/purchases/:id/receipt/share-events` | `purchases:read`     | Registra que se solicitó compartir         |

La entrega sigue siendo `POST /api/purchases/:id/confirm-delivery`. No hay otro endpoint que descuente inventario.

## 18. Modelos

`SignatureSnapshot`, `PurchaseSignature` (`VALID`/`INVALIDATED`/`CANCELLED`), `StoredFile` (`PENDING`/`ACTIVE`/`ORPHANED`), `EvidenceBlob` y `PurchaseReceipt` (`AVAILABLE`/`VOIDED`). `PurchaseDelivery.signatureId` pasa a ser llave foránea hacia `PurchaseSignature`.

**Migración:** `20261023120000_module09_signatures_receipts`, aditiva. No crea firmas ni comprobantes para datos previos.

**Restricciones:**

- CHECKs de importes y numeración del snapshot.
- Una VALID por compra.
- Transiciones e inmutabilidad por triggers en snapshots, firmas, archivos, contenido binario y comprobantes.
- Comprobante solo para compras CONFIRMED.

## 19. Auditoría

Eventos:

- Resumen y firma: `SIGNATURE_SUMMARY_PREPARED`, `SIGNATURE_CAPTURED`, `SIGNATURE_REJECTED` (intento con trazo inválido, resultado FAILURE), `SIGNATURE_INVALIDATED`, `SIGNATURE_CANCELLED` y `SIGNATURE_EVIDENCE_VIEWED`.
- Entrega: `PURCHASE_DELIVERY_CONFIRMED`, además de `PURCHASE_CONFIRMED` del Módulo 08.
- Comprobante: `RECEIPT_CREATED`, `RECEIPT_DOWNLOADED`, `RECEIPT_SHARED_MANUALLY_REQUESTED` y `RECEIPT_VOIDED`.
- Archivos: `EVIDENCE_FILE_ORPHANED`.

Cada evento registra operador, compra, jugador, sesión, ids de evidencia y la huella del snapshot como `snapshotDigest`. **Nota:** el saneador de auditoría elimina las claves que contienen «hash», por eso las huellas se guardan como `…Digest`. La imagen nunca va a la bitácora.

## 20. Concurrencia

Todo se serializa con el bloqueo de la compra (`FOR UPDATE`), en este orden: sesión → compra → firma, y archivo después. Probado:

- Tres firmas simultáneas: una VALID y dos archivos ORPHANED sin contenido.
- Dos entregas simultáneas: una sola salida, deuda y comprobante.
- Una invalidación simultánea a una entrega: nunca se entrega con una firma invalidada.
- Un reverso o un pago posterior no alteran el comprobante.

## 21. Idempotencia

Hay claves únicas en la firma (doble clic y red: la misma firma, sin duplicar archivos ACTIVE), en la entrega (Módulo 08) y en el comprobante (uno por compra; consultarlo de nuevo no lo duplica). La preparación del resumen es idempotente por contenido.

## 22. Pruebas

- **Unitarias** (`src/modules/signatures/signature.test.ts`, 14):
  - firma condicional y bloqueos;
  - trazos vacíos o triviales y coordenadas (sin presión);
  - PNG válido, determinista y sin metadatos;
  - la captura no acepta imágenes ni importes;
  - JSON canónico y huella sensible a cada cambio material;
  - declaración versionada;
  - renglones y texto del comprobante sin denominaciones, PNG disponible y ausencia de PDF;
  - permisos.
- **Integración** (`tests/integration/signatures.int.test.ts`, 19; PostgreSQL real con almacenamiento privado real en PostgreSQL):
  - todo el flujo y la firma sin entrega;
  - una sola salida y una sola deuda;
  - comprobante y PNG;
  - cancelación, invalidaciones (importe, socio, pago, numeración) y pago posterior;
  - concurrencia e idempotencia;
  - inmutabilidad en la base y reverso que conserva la evidencia;
  - API sin URLs públicas, 401 sin sesión o con usuario desactivado, 404 para la firma de otra compra, sin ruta PDF;
  - auditoría.
  - Las 33 pruebas del Módulo 08 ahora usan la **firma real** (ya no hay verificador simulado).
- **E2E** (`tests/e2e/signatures.spec.ts`, Chrome + iPhone):
  - compra a crédito, socio VERBAL, resumen del servidor, firma dibujada en el canvas (mouse y eventos táctiles, sin desplazar la página) y borrar y repetir;
  - verificación de que firmar no entregó, entrega por el cajero, comprobante y descarga PNG;
  - recompra que exige su propia firma e invalidación por cambio de importe;
  - compra pagada sin firma con comprobante;
  - 401 sin sesión;
  - diseño móvil sin desplazamiento horizontal.

## 23. Reversos

El reverso completo de compras es del Módulo 16: al ejecutarse llama a `voidReceiptInTx` (referencia = folio `REV-`) y emite un comprobante complementario; la firma y el contenido originales no cambian. Una solicitud de reverso (Módulo 08) conserva comprobante y firma intactos. `voidReceiptInTx` (contrato) marca el comprobante como VOIDED con motivo y referencia, sin tocar su contenido ni la firma; la pantalla y el PNG muestran «ANULADO».

## 24. Integración con los Módulos 08, 10 y 13

- **08:** el verificador real está registrado por defecto (`moduleSignatureVerifier`). Además, la confirmación de entrega crea el comprobante y las ediciones invalidan las firmas.
- **10 (entregado):** los abonos posteriores no modifican el snapshot ni el comprobante de la compra; tienen su propio comprobante de abono (mismo generador PNG). La deuda vigente y su historial se consultan en `/creditos/[id]`.
- **13:** este módulo no envía nada. El evento `PURCHASE_CREDIT_CONFIRMED` del outbox sigue siendo la entrada para WhatsApp; la imagen PNG puede adjuntarse cuando el Módulo 13 lo implemente con consentimiento vigente.

## Integración con el Módulo 11 (implementada)

- La infraestructura de firmas se reutiliza para liquidaciones con tablas propias (`settlement_signature_snapshots`, `settlement_signatures`): trazos → PNG en el servidor, `evidence-storage` con propósito `SETTLEMENT_SIGNATURE` y `StoredFile.settlementId`, huella canónica y declaración versionada (`settlement.declaration.ts`). La firma es obligatoria en TODA liquidación (incluso $0); una firma de compra nunca sirve para una liquidación.
- Los comprobantes de liquidación (recepción + anexos por pago) usan el mismo `renderDocumentPng`. Ver `docs/MODULE_11_SETTLEMENTS.md` §4–5 y §24–25.

## Integración con el Módulo 12 (implementada)

- El comprobante de cierre de sesión (`ClosureReport`) usa el mismo `renderDocumentPng` y las mismas acciones de compartición manual (`ReceiptActions`: descargar, menú nativo, copiar texto). Sin PDF, sin WhatsApp y sin enlaces públicos. Ver `docs/MODULE_12_CLOSURE.md` §22–23.

## Mesa interactiva (rediseño) — ver `docs/POKER_TABLE_UX_REDESIGN.md`

La firma de una compra a crédito se captura dentro del panel de compra de la mesa con el mismo resumen preparado por el servidor y `SignatureCapture` (que acepta `onDone` opcional). Comprobantes accesibles desde el asiento.

## Conciliación global de fichas (corrección transversal)

Ningún jugador se lleva fichas: el resultado individual no es faltante y el balance nominal GLOBAL de la sesión debe quedar en $0 con todos los jugadores terminados; una diferencia bloquea el cierre hasta que un socio la concilie. Ver `docs/CHIP_GLOBAL_RECONCILIATION.md`.
