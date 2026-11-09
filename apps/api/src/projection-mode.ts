/** Legacy standalone deployments remain inline; Compose selects isolation explicitly. */
export function projectionMode(
  value = process.env.PROJECTION_MODE ?? "inline",
) {
  if (value !== "inline" && value !== "isolated")
    throw Error("PROJECTION_MODE must be inline or isolated");
  return value;
}
