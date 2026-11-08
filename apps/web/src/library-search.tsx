import type { InputHTMLAttributes } from "react";
import { Input } from "@palimora/ui";

export function LibrarySearchField({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="catalog-search-field">
      <svg
        className="catalog-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </svg>
      <span className="sr-only">{label}</span>
      <Input type="search" placeholder={label} {...props} />
    </label>
  );
}
