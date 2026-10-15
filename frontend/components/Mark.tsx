import Link from "next/link";

/** The Load line mark: a ring, a horizontal line through it and the lower half filled, like the Plimsoll line that shows a ship is safely loaded. */
export function Mark({ size = 34, ring = "var(--ink)", fill = "var(--yellow)" }: { size?: number; ring?: string; fill?: string }) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label="Lading mark">
      <path d="M20 60a40 40 0 0 0 80 0z" fill={fill} />
      <circle cx="60" cy="60" r="40" fill="none" stroke={ring} strokeWidth="9" />
      <rect x="4" y="56" width="104" height="8" fill={ring} />
      <rect x="106" y="44" width="8" height="32" fill={ring} />
    </svg>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="l-brand" aria-label="Lading home">
      <Mark size={32} />
      <span>Lading</span>
    </Link>
  );
}
