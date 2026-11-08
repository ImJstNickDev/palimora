/** Personal pages share one URL namespace; API list kinds remain unchanged. */
export const libraryDestinations = [
  ["/library", "Opere salvate", "Saved works"],
  ["/library/later", "Da leggere più tardi", "Marked for Later"],
  ["/library/history", "Cronologia", "History"],
  ["/library/collections", "Collezioni", "Collections"],
  ["/library/offline", "Offline", "Offline"],
  ["/library/statistics", "Statistiche", "Statistics"],
  ["/library/activity", "Attività", "Activity"],
  ["/library/subscriptions", "Sottoscrizioni", "Subscriptions"],
  ["/library/notifications", "Notifiche", "Notifications"],
  ["/library/settings", "Privacy e notifiche", "Privacy and notifications"],
] as const;

export function canonicalLibraryLocation(pathname: string, search: string) {
  const params = new URLSearchParams(search);
  let path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/library" && params.has("kind")) {
    const kind = params.get("kind");
    path =
      kind === "later" || kind === "history" ? `/library/${kind}` : "/library";
    params.delete("kind");
  } else if (/^\/collections(?:\/|$)/.test(path)) {
    path = "/library" + path;
  } else if (
    /^\/(offline|statistics|activity|subscriptions|notifications)$/.test(path)
  ) {
    path = "/library" + path;
  } else if (path === "/social-settings") {
    path = "/library/settings";
  } else if (path === pathname || path !== "/library") return null;
  const query = params.toString();
  return path + (query ? "?" + query : "");
}
