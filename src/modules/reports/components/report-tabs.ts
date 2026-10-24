export const REPORTS_BASE = "/dashboard/reportes"

export const REPORT_TABS = [
  { slug: "", label: "Dashboard" },
  { slug: "creditos", label: "Créditos" },
  { slug: "abonos", label: "Abonos" },
  { slug: "sesiones", label: "Sesiones" },
  { slug: "mesas", label: "Mesas" },
  { slug: "compras", label: "Compras" },
  { slug: "liquidaciones", label: "Liquidaciones" },
  { slug: "finanzas", label: "Finanzas" },
  { slug: "fichas", label: "Fichas" },
  { slug: "jugadores", label: "Jugadores" },
  { slug: "comparativos", label: "Comparativos" },
  { slug: "rake-propinas", label: "Rake y propinas" },
] as const
