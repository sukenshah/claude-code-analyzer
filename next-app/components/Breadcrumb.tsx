import Link from "next/link";

interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="breadcrumb-item">
            {i > 0 && <span className="breadcrumb-sep">/</span>}
            {isLast || !crumb.href ? (
              <span className={isLast ? "breadcrumb-current" : "breadcrumb-label"}>
                {crumb.label}
              </span>
            ) : (
              <Link href={crumb.href} className="breadcrumb-link">{crumb.label}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
