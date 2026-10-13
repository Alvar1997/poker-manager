/**
 * Reglas operativas INVARIABLES en esta versión de Poker Manager.
 *
 * Son reglas del dominio, no preferencias: por eso viven como constantes
 * tipadas (no como columnas editables) y ningún formulario puede
 * desactivarlas. Las únicas políticas persistidas son las de efectivo
 * (OperationalSettings: NEW_FUND_PER_SESSION / FULL_WITHDRAWAL), que son
 * de valor único en esta versión. Cambiar una regla aquí requiere una
 * decisión de negocio documentada en docs/BUSINESS_RULES.md.
 *
 * `enforcedBy` indica honestamente dónde se aplica: hoy la mayoría se
 * aplicará en módulos futuros (compras, sesiones, liquidaciones…).
 */

export type OperationalRule = {
  id: string
  title: string
  description: string
  /** Módulo que la aplica (o "Módulo 02" si ya se aplica en la configuración). */
  enforcedBy: string
}

export const OPERATIONAL_RULES: readonly OperationalRule[] = [
  {
    id: "CREDIT_ALLOWED",
    title: "Compras a crédito permitidas",
    description:
      "Una compra o recompra puede quedar total o parcialmente a crédito. El crédito es una cuenta por cobrar, no dinero recibido.",
    enforcedBy: "Compras y recompras",
  },
  {
    id: "CREDIT_NO_EXTERNAL_APPROVAL",
    title: "Crédito sin autorización externa",
    description: "El cajero puede otorgar crédito sin aprobación de un socio.",
    enforcedBy: "Compras y recompras",
  },
  {
    id: "SIGNATURE_ON_CHIP_DELIVERY",
    title: "Firma obligatoria en entregas de fichas",
    description:
      "Cada entrega de fichas requiere la firma del jugador en el celular del cajero.",
    enforcedBy: "Entregas y firma",
  },
  {
    id: "AUTO_DEBT_COMPENSATION",
    title: "Compensación automática de deudas",
    description:
      "Al liquidar, las deudas pendientes del jugador se compensan automáticamente.",
    enforcedBy: "Liquidaciones",
  },
  {
    id: "FIFO_COMPENSATION",
    title: "Compensación FIFO",
    description: "Las deudas se compensan empezando por la más antigua.",
    enforcedBy: "Liquidaciones",
  },
  {
    id: "OPENING_COUNT_REQUIRED",
    title: "Arqueo inicial obligatorio",
    description:
      "Toda sesión se abre con conteo de efectivo y fichas, confirmado por el cajero sin autorización externa.",
    enforcedBy: "Sesiones",
  },
  {
    id: "CLOSING_COUNT_REQUIRED",
    title: "Arqueo final obligatorio",
    description:
      "Antes de retirar el efectivo al cierre se realiza el arqueo final.",
    enforcedBy: "Cierre de sesión",
  },
  {
    id: "SINGLE_CASH_BOX",
    title: "Una sola caja central",
    description:
      "Todo el dinero de todas las mesas entra y sale de la Caja Central (MAIN). No hay cajas por mesa.",
    enforcedBy: "Módulo 02 (restricción en base de datos)",
  },
  {
    id: "NEW_FUND_PER_SESSION",
    title: "Fondo nuevo en cada sesión",
    description:
      "Cada sesión inicia con un fondo de efectivo nuevo, de importe variable; no se arrastra efectivo de la sesión anterior. El fondo no es ingreso ni ganancia.",
    enforcedBy: "Sesiones",
  },
  {
    id: "FULL_WITHDRAWAL_ON_CLOSE",
    title: "Retiro total de efectivo al cierre",
    description:
      "Tras el arqueo final se retira todo el efectivo; el esperado queda en cero. El retiro no es gasto ni utilidad. Banco y cuentas por cobrar continúan entre sesiones.",
    enforcedBy: "Cierre de sesión",
  },
  {
    id: "CREDIT_WHATSAPP_NOTIFICATION",
    title: "Notificación automática de compras a crédito",
    description:
      "Se envía por WhatsApp después de confirmar la compra. Pendiente: el número exclusivo aún no está disponible.",
    enforcedBy: "Notificaciones automáticas (Módulo 13)",
  },
  {
    id: "LOCAL_TIME_MONTERREY",
    title: "Hora local America/Monterrey",
    description:
      "Las fechas se guardan en UTC y se muestran en la zona horaria del negocio.",
    enforcedBy: "Módulo 00 (src/lib/format.ts)",
  },
  {
    id: "MONEY_AND_CHIPS_INDEPENDENT",
    title: "Dinero y fichas por separado",
    description:
      "Los saldos monetarios y las existencias físicas de fichas se manejan de forma independiente; cada juego de fichas tiene su propio inventario.",
    enforcedBy: "Módulo 02 (modelo) e inventario de fichas",
  },
  {
    id: "NO_EDIT_CONFIRMED_OPERATIONS",
    title: "Operaciones confirmadas no editables",
    description:
      "Las operaciones financieras confirmadas no se editan; se corrigen con movimientos auditados.",
    enforcedBy: "Módulos de operación",
  },
  {
    id: "MANDATORY_AUDIT",
    title: "Auditoría obligatoria",
    description: "Toda acción relevante queda en la auditoría inmutable.",
    enforcedBy: "Módulos 01 y 02 (y todos los siguientes)",
  },
] as const
