import type { LucideIcon } from "lucide-react"
import {
  Building2,
  CreditCard,
  Hash,
  Landmark,
  Layers,
  MessageCircle,
  ScrollText,
  Table2,
  Wallet,
} from "lucide-react"

import {
  PERMISSIONS,
  roleHasPermission,
  type Permission,
  type Role,
} from "@/config/permission-matrix"

/**
 * Secciones de Configuración (Módulo 02). `permission` es la capacidad
 * para VERLA; editar siempre exige `settings:manage` (solo SUPERADMIN) y
 * se valida en el servidor.
 */
export type SettingsSection = {
  id: string
  title: string
  description: string
  href: string
  icon: LucideIcon
  permission: Permission
}

export const SETTINGS_BASE_PATH = "/dashboard/configuracion"

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "general",
    title: "Datos generales",
    description: "Nombre del negocio, moneda, zona horaria y formatos.",
    href: `${SETTINGS_BASE_PATH}/general`,
    icon: Building2,
    permission: PERMISSIONS.CATALOGS_READ,
  },
  {
    id: "caja",
    title: "Caja central",
    description: "La caja financiera única del negocio.",
    href: `${SETTINGS_BASE_PATH}/caja`,
    icon: Wallet,
    permission: PERMISSIONS.SETTINGS_READ,
  },
  {
    id: "mesas",
    title: "Mesas",
    description: "Catálogo de mesas, ciegas y juego de fichas asignado.",
    href: `${SETTINGS_BASE_PATH}/mesas`,
    icon: Table2,
    permission: PERMISSIONS.CATALOGS_READ,
  },
  {
    id: "fichas",
    title: "Juegos de fichas",
    description: "Juegos físicos independientes y sus denominaciones.",
    href: `${SETTINGS_BASE_PATH}/fichas`,
    icon: Layers,
    permission: PERMISSIONS.CATALOGS_READ,
  },
  {
    id: "pagos",
    title: "Métodos de pago",
    description: "Efectivo y transferencia bancaria.",
    href: `${SETTINGS_BASE_PATH}/pagos`,
    icon: CreditCard,
    permission: PERMISSIONS.CATALOGS_READ,
  },
  {
    id: "banco",
    title: "Cuenta bancaria",
    description: "Cuenta única que recibe las transferencias.",
    href: `${SETTINGS_BASE_PATH}/banco`,
    icon: Landmark,
    permission: PERMISSIONS.SETTINGS_READ,
  },
  {
    id: "folios",
    title: "Folios",
    description: "Formato y consecutivos de los documentos.",
    href: `${SETTINGS_BASE_PATH}/folios`,
    icon: Hash,
    permission: PERMISSIONS.SETTINGS_READ,
  },
  {
    id: "reglas",
    title: "Reglas operativas",
    description: "Políticas de caja, crédito, firmas y auditoría.",
    href: `${SETTINGS_BASE_PATH}/reglas`,
    icon: ScrollText,
    permission: PERMISSIONS.CATALOGS_READ,
  },
  {
    id: "whatsapp",
    title: "WhatsApp",
    description: "Notificaciones automáticas de créditos (pendiente).",
    href: `${SETTINGS_BASE_PATH}/whatsapp`,
    icon: MessageCircle,
    permission: PERMISSIONS.SETTINGS_READ,
  },
]

export function settingsSectionsFor(role: Role): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => roleHasPermission(role, s.permission))
}

export function settingsSection(id: string): SettingsSection {
  const section = SETTINGS_SECTIONS.find((s) => s.id === id)
  if (!section) throw new Error(`Sección de configuración desconocida: ${id}`)
  return section
}
