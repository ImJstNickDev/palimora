import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db";
import { destination } from "./backup-config";
import { openBackupTarget } from "./backup-target";
import { fail } from "./security";
export async function backupDownload(id: string, name: string) {
  if (!/^(manifest\.json|manifest\.sha256|volume-[0-9]{6,}\.pmarc)$/.test(name))
    fail("NOT_FOUND", 404);
  const r = (
    await pool.query(
      "SELECT * FROM backup_runs WHERE id=$1 AND state='completed' AND kind IN ('full','platform','export')",
      [id],
    )
  ).rows[0];
  if (!r || !r.result.files?.some((f: any) => f.name === name))
    fail("NOT_FOUND", 404);
  const target = await openBackupTarget(await destination(r.destination), {
    readOnly: true,
  });
  const directories: Awaited<ReturnType<typeof open>>[] = [];
  try {
    let path = target.path;
    for (const part of [id, "archive"]) {
      const directory = await open(
        join(path, part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      directories.push(directory);
      path = `/proc/self/fd/${directory.fd}`;
    }
    const file = await open(
      join(path, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await file.stat();
    if (!stat.isFile()) {
      await file.close();
      throw Error("BACKUP_FILE_INVALID");
    }
    return {
      size: stat.size,
      stream: (start: number, end: number) =>
        file.createReadStream({ autoClose: false, start, end }),
      close: async () => {
        await file.close();
        for (const directory of directories.reverse()) await directory.close();
        await target.close();
      },
    };
  } catch (e) {
    for (const directory of directories.reverse()) await directory.close();
    await target.close();
    throw e;
  }
}
