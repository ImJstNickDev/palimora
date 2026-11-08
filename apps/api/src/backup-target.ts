import { constants } from "node:fs";
import { open, readFile, realpath, statfs } from "node:fs/promises";
import { resolve } from "node:path";

export interface BackupTarget {
  name: string;
  path: string;
  marker: string;
  device: string;
  reserveBytes: number;
}
/** Keep the directory descriptor open for the entire operation. On Linux this
 * prevents a later pathname lookup from falling through to an unmounted disk's
 * underlying directory. The operator provisions the marker, never this worker. */
export async function openBackupTarget(
  target: BackupTarget,
  options: { readOnly?: boolean } = {},
) {
  if (
    !/^[a-z0-9_-]{1,64}$/.test(target.name) ||
    !target.marker ||
    !/^\d+:\d+$/.test(target.device) ||
    !Number.isSafeInteger(target.reserveBytes) ||
    target.reserveBytes < 0
  )
    throw Error("BACKUP_TARGET_CONFIG");
  const path = resolve(target.path);
  if ((await realpath(path)) !== path) throw Error("BACKUP_TARGET_SYMLINK");
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const anchored = `/proc/self/fd/${directory.fd}`;
  const info = await readFile(`/proc/self/fdinfo/${directory.fd}`, "utf8");
  const mountId = /^mnt_id:\s+(\d+)$/m.exec(info)?.[1];
  async function check(requiredBytes = 0) {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0)
      throw Error("BACKUP_SPACE_INVALID");
    const mounts = await readFile("/proc/self/mountinfo", "utf8");
    const mount = mounts
      .split("\n")
      .map((line) => line.split(" "))
      .find((parts) => parts[0] === mountId);
    if (!mount || mount[2] !== target.device)
      throw Error("BACKUP_MOUNT_UNAVAILABLE");
    const marker = await open(
      `${anchored}/.palimora-backup-target`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await marker.stat();
      if (
        !stat.isFile() ||
        stat.size > 4096 ||
        (await marker.readFile("utf8")).trim() !== target.marker
      )
        throw Error("BACKUP_TARGET_IDENTITY");
    } finally {
      await marker.close();
    }
    // The descriptor path remains tied to the opened filesystem even across namespace changes.
    const disk = await statfs(anchored, { bigint: true });
    if (
      !options.readOnly &&
      disk.bavail * disk.bsize <
        BigInt(target.reserveBytes) + BigInt(requiredBytes)
    )
      throw Object.assign(Error("BACKUP_SPACE_INSUFFICIENT"), {
        code: "ENOSPC",
      });
  }
  try {
    await check();
    return { path: anchored, check, close: () => directory.close() };
  } catch (error) {
    await directory.close();
    throw error;
  }
}
