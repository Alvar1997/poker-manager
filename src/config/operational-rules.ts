/**
 * Reglas operativas INVARIABLES en esta versión de Poker Manager.
 *
 * Son reglas del dominio, no preferencias: por eso viven como constantes
 * tipadas (no como columnas editables) y ningún formulario puede
 * desactivarlas. Las únicas políticas persistidas son las de efectivo
 * (OperationalSettings: ZERO_OPENING_BALANCE / FULL_WITHDRAWAL, con sus
 * invariantes como CHECK en la base), que son
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
    id: "NO_CREDIT_LIMIT",
    title: "Crédito sin límite",
    description:
      "No existe límite de crédito por jugador ni límite global. Crédito ilimitado no significa sin control: cada compra a crédito queda asociada a un jugador, al socio que la autorizó, firmada y auditada.",
    enforcedBy: "Módulo 03 (política) y Módulo 08",
  },
  {
    id: "CREDIT_PARTNER_AUTHORIZATION",
    title: "Todo crédito identifica al socio que lo autorizó",
    description:
      "Cualquier compra con saldo por cobrar registra qué socio activo autorizó el crédito (verbal o por mensaje), quién lo capturó y cuándo. No hay aprobación en línea: el cajero registra la autorización comunicada.",
    enforcedBy: "Módulo 08 (servidor + base de datos)",
  },
  {
    id: "SIGNATURE_ON_CREDIT_DELIVERY",
    title: "Firma obligatoria solo en compras a crédito",
    description:
      "Si la compra deja cualquier saldo por cobrar (aunque sea parcial), el jugador firma en el celular del cajero la versión exacta de la compra. Las compras totalmente pagadas no requieren firma.",
    enforcedBy:
      "Módulo 08 (bloqueo de entrega + CHECK en base de datos) y Módulo 09 (captura)",
  },
  {
    id: "PURCHASES_BY_NOMINAL_AMOUNT",
    title: "Compras solo por importe",
    description:
      "El cajero captura únicamente el importe solicitado; no se piden ni guardan denominaciones. El inventario compartido se descuenta por valor nominal y las cantidades físicas se verifican en los arqueos.",
    enforcedBy: "Módulos 04 y 08",
  },
  {
    id: "CARD_TERMINAL_PAYMENTS",
    title: "Tarjetas por terminal física",
    description:
      "Débito y crédito se cobran en la terminal: solo un cobro aprobado cuenta como pago, no aumenta el efectivo y queda «por liquidar» hasta el depósito bancario, que no reconoce la venta otra vez. Nunca se guardan datos de la tarjeta.",
    enforcedBy: "Módulos 05 y 08",
  },
  {
    // Módulo 11: sustituye a AUTO_DEBT_COMPENSATION (ya no se compensa por existir deuda).
    id: "OPTIONAL_DEBT_COMPENSATION",
    title: "Compensación de deudas opcional",
    description:
      "Al liquidar, el cajero decide explícitamente si compensa deuda: no compensar, compensar parcialmente o el máximo posible. Nunca se compensa solo porque exista deuda, y la compensación no es entrada de efectivo ni de banco.",
    enforcedBy: "Liquidaciones (Módulo 11)",
  },
  {
    id: "FIFO_COMPENSATION",
    title: "Compensación FIFO",
    description:
      "Si el cajero decide compensar, el importe se distribuye automáticamente empezando por la deuda más antigua; no se eligen deudas a mano.",
    enforcedBy: "Liquidaciones (Módulo 11)",
  },
  {
    id: "SETTLEMENT_SIGNATURE_ALWAYS",
    title: "Firma en toda liquidación",
    description:
      "Toda liquidación requiere la firma del jugador en el celular del cajero, incluso si devuelve $0 en fichas. La firma no recibe fichas ni mueve dinero: el cajero confirma la recepción después.",
    enforcedBy: "Liquidaciones (Módulo 11)",
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
    id: "SHARED_CHIP_INVENTORY",
    title: "Un inventario de fichas para ambas mesas",
    description:
      "Las mesas 25/25 y 10/10 comparten un solo inventario físico de fichas: denominaciones y existencias comunes. Los movimientos conservan su mesa, sesión y jugador solo como trazabilidad. Un inventario compartido + dos mesas + una caja central.",
    enforcedBy:
      "Corrección previa al Módulo 06 (índice único: un solo inventario activo)",
  },
  {
    id: "ZERO_OPENING_BALANCE",
    title: "La caja abre en $0.00",
    description:
      "El efectivo físico de cada sesión inicia SIEMPRE en $0.00: no hay fondo inicial (ni obligatorio ni automático) y no se arrastra efectivo de la sesión anterior. El banco y las deudas no se reinician.",
    enforcedBy:
      "Módulo 05 (libro por sesión + CHECK en base de datos) y Sesiones",
  },
  {
    id: "CHIP_COUNT_BEFORE_OPENING",
    title: "Sin arqueo de fichas no hay apertura",
    description:
      "Antes de habilitar una sesión se realiza y concilia el arqueo general del inventario compartido (uno solo, no uno por mesa) y se confirma que el efectivo es $0.00.",
    enforcedBy: "Módulo 05 (precondición de apertura) y Sesiones",
  },
  {
    id: "NO_NEGATIVE_CASH",
    title: "Sin saldo negativo de efectivo",
    description:
      "Ninguna salida puede dejar la caja en negativo. Si falta dinero, primero debe entrar dinero real (cobro, aportación o traslado confirmado).",
    enforcedBy: "Módulo 05 (bloqueo transaccional + CHECK en base de datos)",
  },
  {
    id: "NO_OPERATING_EXPENSES",
    title: "Sin gastos operativos desde la caja",
    description:
      "La caja no paga comida, bebidas, insumos, servicios ni otros gastos. Solo hay salidas financieras legítimas: liquidaciones, retiros, traslados y reversos.",
    enforcedBy: "Módulo 05 (catálogo cerrado de movimientos)",
  },
  {
    id: "MANUAL_BANK_VERIFICATION",
    title: "Transferencias verificadas manualmente",
    description:
      "Una transferencia pendiente no es un cobro. SUPERADMIN, PARTNER o CASHIER la confirman tras verificarla en el banco, sin aprobación adicional; se contabiliza una sola vez.",
    enforcedBy: "Módulo 05",
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
      "Solo las compras confirmadas que generan crédito registran un evento pendiente (outbox); el envío por WhatsApp ocurre después, con consentimiento vigente y canal configurado. Pendiente: el número exclusivo aún no está disponible.",
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
      "Los saldos monetarios y las existencias físicas de fichas se manejan de forma independiente: el valor nominal de las fichas nunca es dinero en caja.",
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
