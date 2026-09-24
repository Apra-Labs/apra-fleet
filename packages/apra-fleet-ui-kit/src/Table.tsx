import type { ReactNode } from "react";
import { colors, spacing, typography } from "./tokens.js";

export interface TableColumn<Row> {
  /** Unique column key, also used to read the cell value from a row. */
  key: string;
  /** Column header label. */
  header: string;
  /** Optional custom cell renderer; defaults to String(row[key]). */
  render?: (row: Row) => ReactNode;
}

export interface TableProps<Row> {
  /** Column definitions, rendered left to right in array order. */
  columns: Array<TableColumn<Row>>;
  /** Row data. */
  rows: Row[];
  /** Returns a stable unique key for a row, used as the React list key. */
  rowKey: (row: Row) => string;
  /** Message shown when rows is empty. */
  emptyMessage?: string;
}

/**
 * Minimal presentational table primitive: columns + rows in, markup out.
 * No data fetching, no sorting/pagination state.
 */
export function Table<Row extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  emptyMessage = "No data"
}: TableProps<Row>) {
  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontFamily: typography.fontFamily,
        fontSize: typography.fontSizeMd,
        color: colors.textPrimary
      }}
    >
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              style={{
                textAlign: "left",
                padding: spacing.sm,
                borderBottom: `1px solid ${colors.border}`,
                color: colors.textSecondary,
                fontWeight: typography.fontWeightMedium
              }}
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td
              colSpan={columns.length}
              style={{
                padding: spacing.md,
                textAlign: "center",
                color: colors.textSecondary
              }}
            >
              {emptyMessage}
            </td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  style={{
                    padding: spacing.sm,
                    borderBottom: `1px solid ${colors.border}`
                  }}
                >
                  {column.render
                    ? column.render(row)
                    : String(row[column.key] ?? "")}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
