"use client";

import { useEffect, useState } from "react";

export const PAGE_SIZE = 25;

export function usePagination<T>(items: T[], pageSize = PAGE_SIZE) {
  const [page, setPage] = useState(1);

  useEffect(() => { setPage(1); }, [items.length]);

  const totalPages = Math.ceil(items.length / pageSize);
  const start = (page - 1) * pageSize;
  const paged = items.slice(start, start + pageSize);

  return { page, setPage, paged, totalPages, total: items.length, start };
}

function pageNumbers(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages: (number | "…")[] = [1];
  if (current > 3) pages.push("…");

  const lo = Math.max(2, current - 1);
  const hi = Math.min(total - 1, current + 1);
  for (let i = lo; i <= hi; i++) pages.push(i);

  if (current < total - 2) pages.push("…");
  pages.push(total);
  return pages;
}

export function Pagination({
  page,
  total,
  pageSize = PAGE_SIZE,
  onChange,
}: {
  page: number;
  total: number;
  pageSize?: number;
  onChange: (p: number) => void;
}) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  return (
    <div className="pagination">
      <span className="pagination-info">{totalPages} pages · {total} total</span>
      <button className="btn-page" disabled={page === 1} onClick={() => onChange(page - 1)}>←</button>
      {pageNumbers(page, totalPages).map((p, i) =>
        p === "…"
          ? <span key={`ellipsis-${i}`} className="pagination-ellipsis">…</span>
          : <button
              key={p}
              className={`btn-page ${p === page ? "btn-page-active" : ""}`}
              onClick={() => onChange(p)}
            >{p}</button>
      )}
      <button className="btn-page" disabled={page === totalPages} onClick={() => onChange(page + 1)}>→</button>
    </div>
  );
}
