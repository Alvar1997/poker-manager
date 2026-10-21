import { ArrowLeft } from "lucide-react"
import Link from "next/link"

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {label}
    </Link>
  )
}
