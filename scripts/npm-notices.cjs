// Reproducible license inventory and notices shipped with the browser bundle.
const fs = require("node:fs"),
  path = require("node:path");
process.chdir(path.join(__dirname, ".."));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")).packages;
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").trim();
function license(p, entry) {
  if (entry.license) return entry.license;
  // These packages omit the npm metadata field but ship the MIT text.
  const text = read(path.join(p, "LICENSE"));
  if (
    text.includes("Permission is hereby granted, free of charge") &&
    text.includes('THE SOFTWARE IS PROVIDED "AS IS"')
  )
    return "MIT";
  throw Error("Review missing license: " + p);
}
const inventory = Object.entries(lock)
  .filter(([p, e]) => p.includes("node_modules/") && !e.link)
  .map(([p, e]) => ({
    name: p.split("node_modules/").at(-1),
    version: e.version,
    license: license(p, e),
    development: !!e.dev,
    optional: !!e.optional,
  }))
  .sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version, "en"));
const visited = new Set();
function resolve(from, name) {
  let cursor = from;
  while (true) {
    const p = path.posix.join(cursor, "node_modules", name);
    if (lock[p]) return lock[p].link ? lock[p].resolved : p;
    if (!cursor || cursor === ".")
      throw Error("Unresolved dependency: " + name);
    cursor = path.posix.dirname(cursor);
  }
}
function visit(p) {
  if (visited.has(p)) return;
  visited.add(p);
  const e = lock[p];
  for (const name of Object.keys({
    ...e.dependencies,
    ...e.peerDependencies,
  })) {
    if (e.peerDependenciesMeta?.[name]?.optional) continue;
    visit(resolve(p, name));
  }
}
for (const p of ["apps/web", "packages/ui", "packages/contracts"]) visit(p);
const notices = [
  "Palimora v1.0.0 — browser distribution notices",
  read("LICENSE"),
];
for (const p of [...visited]
  .filter((p) => p.includes("node_modules/"))
  .sort()) {
  const e = lock[p];
  const files = fs
    .readdirSync(p)
    .filter(
      (name) =>
        /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(name) &&
        fs.statSync(path.join(p, name)).isFile(),
    )
    .sort();
  const supplement = p.startsWith("node_modules/@radix-ui/")
    ? "licenses/radix-ui-MIT.txt"
    : p === "node_modules/@epic-web/invariant"
      ? "licenses/epic-web-invariant-MIT.txt"
      : p === "node_modules/react-remove-scroll-bar"
        ? "licenses/react-remove-scroll-bar-MIT.txt"
        : null;
  if (!files.length && !supplement)
    throw Error("Missing browser license text: " + p);
  notices.push(
    `${p.split("node_modules/").at(-1)}@${e.version} (${license(p, e)})\n\n` +
      (files.length
        ? files.map((name) => read(path.join(p, name))).join("\n\n")
        : read(supplement)),
  );
}
for (const [file, text] of [
  ["licenses/npm-inventory.json", JSON.stringify(inventory, null, 2) + "\n"],
  [
    "apps/web/public/third-party-notices.txt",
    notices.join("\n\n" + "=".repeat(72) + "\n\n") + "\n",
  ],
]) {
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text)
      throw Error("Outdated notices: run npm run notices (" + file + ")");
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}
console.log(
  `${inventory.length} npm entries; ${visited.size - 3} browser dependencies reviewed.`,
);
