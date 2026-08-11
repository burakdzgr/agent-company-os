// Primitive components (28 §2): Button, Card, Input, Select, Dialog,
// DataTable, StatusPill. Styling via Tailwind classes on the acos preset.
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------- Button ----------

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent-500 text-white hover:bg-accent-600 disabled:bg-ink-200",
  secondary: "bg-ink-100 text-ink-800 hover:bg-ink-200 disabled:text-ink-400",
  danger: "bg-danger text-white hover:opacity-90 disabled:opacity-50",
  ghost: "bg-transparent text-ink-600 hover:bg-ink-100",
};

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed",
        buttonVariants[variant],
        className,
      )}
      {...props}
    />
  );
}

// ---------- Card ----------

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-card border border-ink-200 bg-white shadow-sm", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
          <h3 className="text-sm font-semibold text-ink-800">{title}</h3>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

// ---------- form controls ----------

const controlClass =
  "w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-800 outline-none focus:border-accent-400";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(controlClass, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(controlClass, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(controlClass, props.className)} />;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-600">{label}</span>
      {children}
    </label>
  );
}

// ---------- Dialog ----------

export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-card bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
          <h2 className="text-base font-semibold text-ink-900">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded px-2 text-ink-400 hover:bg-ink-100 hover:text-ink-800"
          >
            ✕
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

// ---------- DataTable ----------

export interface DataTableColumn<Row> {
  header: string;
  cell: (row: Row) => ReactNode;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  empty,
}: {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-400">{empty ?? "No records."}</p>;
  }
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-ink-200 text-xs uppercase tracking-wide text-ink-400">
          {columns.map((column) => (
            <th key={column.header} className="px-2 py-2 font-medium">
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} className="border-b border-ink-100 last:border-0 hover:bg-ink-50">
            {columns.map((column) => (
              <td key={column.header} className="px-2 py-2 text-ink-800">
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- StatusPill ----------

export type PillTone = "ok" | "warn" | "danger" | "neutral" | "accent";

const pillTones: Record<PillTone, string> = {
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/10 text-warn",
  danger: "bg-danger/10 text-danger",
  neutral: "bg-ink-100 text-ink-600",
  accent: "bg-accent-500/10 text-accent-600",
};

export function StatusPill({ tone = "neutral", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        pillTones[tone],
      )}
    >
      {children}
    </span>
  );
}
