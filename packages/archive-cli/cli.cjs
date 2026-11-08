#!/usr/bin/env node
"use strict";
const {
  openChain,
  verify,
  extract,
  readObject,
  objectBytes,
} = require("@palimora/archive-format");
const { once } = require("node:events");
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (
    !["inspect", "verify", "list", "read", "extract", "import"].includes(
      command,
    )
  ) {
    throw Error(
      "Usage: palimora-archive inspect|verify|list BASE [INCREMENT ...]\n       palimora-archive read HASH BASE [INCREMENT ...]\n       palimora-archive extract|import DIRECTORY BASE [INCREMENT ...]",
    );
  }
  const value = ["read", "extract", "import"].includes(command)
    ? args.shift()
    : undefined;
  if (value === undefined && ["read", "extract", "import"].includes(command))
    throw Error("ARGUMENT_REQUIRED");
  const chain = await openChain(args);
  if (command === "verify") console.log(JSON.stringify(await verify(chain)));
  else if (command === "inspect")
    console.log(JSON.stringify(chain.manifest, null, 2));
  else if (command === "list") {
    if (chain.manifest.catalog?.schema === "palimora-corpus-catalog-v1") {
      for (const hash of chain.manifest.catalog.works)
        for (const work of JSON.parse(
          (await objectBytes(chain, hash)).toString(),
        ))
          console.log(JSON.stringify(work));
    } else console.log(JSON.stringify(chain.manifest.catalog, null, 2));
  } else if (command === "extract" || command === "import")
    await extract(chain, value);
  else {
    await verify(chain);
    for await (const bytes of readObject(chain, value))
      if (!process.stdout.write(bytes)) await once(process.stdout, "drain");
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
