import { useEffect, useState, type ReactNode } from 'react';

import type { TableColumn } from './adminConsole.types';

type AdminConsoleTableProps<T extends { id?: string | number }> = {
  title: string;
  actionText: string;
  onAction?: () => void;
  columns: TableColumn<T>[];
  data: T[];
  emptyText?: string;
  addForm?: ReactNode;
};

const PAGE_SIZE = 10;

function PaginationControls({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  return (
    <nav className="admin-console__pagination" aria-label="Table pagination">
      <button
        type="button"
        className="admin-console__secondary-action"
        onClick={() => onPageChange(page - 1)}
        disabled={page === 1}
      >
        Previous
      </button>
      <span aria-current="page">
        Page {page} of {pageCount}
      </span>
      <button
        type="button"
        className="admin-console__secondary-action"
        onClick={() => onPageChange(page + 1)}
        disabled={page === pageCount}
      >
        Next
      </button>
    </nav>
  );
}

export function AdminConsoleTable<T extends { id?: string | number }>({
  title,
  actionText,
  onAction,
  columns,
  data,
  emptyText = 'No records found.',
  addForm,
}: AdminConsoleTableProps<T>) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(data.length / PAGE_SIZE));
  const visibleRows = data.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount));
  }, [pageCount]);

  return (
    <div className="admin-console__section">
      <div className="card">
        <div className="card__header" style={{ whiteSpace: 'nowrap' }}>
          <h2>{title}</h2>

          {!addForm && actionText && (
            <button
              type="button"
              onClick={onAction}
              className="btn btn--primary"
            >
              {actionText}
            </button>
          )}
        </div>
      </div>

      {addForm && <div className="admin-console__form">{addForm}</div>}

      <div className="admin-console__table-wrap">
        <table className="admin-console__table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={String(column.key)}>{column.label}</th>
              ))}
            </tr>
          </thead>

          <tbody>
            {data.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{
                    textAlign: 'center',
                    padding: 'var(--space-6) var(--space-4)',
                  }}
                >
                  {emptyText}
                </td>
              </tr>
            ) : (
              visibleRows.map((row, rowIndex) => (
                <tr key={row.id ?? rowIndex}>
                  {columns.map((column) => {
                    const cellValue = column.render
                      ? (column.render(row) as ReactNode)
                      : String(
                          (row as Record<string, unknown>)[
                            column.key as string
                          ] ?? '-',
                        );

                    return <td key={String(column.key)}>{cellValue}</td>;
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <PaginationControls
        page={page}
        pageCount={pageCount}
        onPageChange={setPage}
      />
    </div>
  );
}
