export function Icon({
  name,
  filled = false,
}: {
  filled?: boolean;
  name:
    | "settings"
    | "more"
    | "users"
    | "search"
    | "filter"
    | "download"
    | "type"
    | "expand"
    | "back"
    | "next"
    | "close"
    | "history"
    | "folder"
    | "plus"
    | "bookmark"
    | "clock"
    | "bell"
    | "share"
    | "check"
    | "note"
    | "trash"
    | "edit"
    | "refresh"
    | "mail";
}) {
  const paths = {
    more: "M5 11h.01v2H5v-2Zm7 0h.01v2H12v-2Zm7 0h.01v2H19v-2Z",
    settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
    users:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 4a4 4 0 0 1 0 7m5 10v-2a4 4 0 0 0-3-4",
    trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
    edit: "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z",
    refresh:
      "M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5M4 17a9 9 0 0 0 15 2l3-3m0 5v-5h-5",
    mail: "M3 5h18v14H3V5Zm0 1 9 7 9-7",
    folder: "M3 7V5h7l2 2h9v13H3V7Z",
    plus: "M12 5v14M5 12h14",
    bookmark: "M6 3h12v18l-6-4-6 4V3Z",
    clock: "M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    bell: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3ZM10 21h4",
    share: "M8 12h13m-5-5 5 5-5 5M3 5v14",
    check: "m5 12 4 4L19 6",
    note: "M4 3h16v18H4V3Zm4 5h8M8 12h8M8 16h5",
    search: "m21 21-5-5M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15",
    filter: "M4 7h16M7 12h10M10 17h4",
    download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
    type: "M3 19 9 5l6 14M5 15h8M16 11h6m-3 0v8",
    expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
    back: "m14 6-6 6 6 6",
    next: "m10 6 6 6-6 6",
    close: "m6 6 12 12M6 18 18 6",
    history: "M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2",
  };
  return (
    <svg
      className="catalog-icon"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
