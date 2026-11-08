export const MAX_VOLUME: 2147483648;
export interface ArchiveObject {
  hash: string;
  kind: string;
  size: number;
  parts: { volume: string; offset: number; size: number }[];
}
export interface ArchiveManifest {
  format: "palimora-archive-v1" | "palimora-backup-v1";
  origin: string;
  created_at: string;
  dependencies: { manifest: string }[];
  catalog: unknown;
  volumes: { name: string; size: number; sha256: string }[];
  objects: ArchiveObject[];
}
export interface Archive {
  root: string;
  hash: string;
  manifest: ArchiveManifest;
}
export interface ArchiveChain {
  archives: Archive[];
  objects: Map<string, { object: ArchiveObject; root: string }>;
  manifest: ArchiveManifest;
  hash: string;
}
export function digest(bytes: Buffer | string): string;
export function fileDigest(
  root: string,
  name: string,
  check?: () => Promise<void>,
): Promise<{ size: number; sha256: string }>;
export function loadManifest(root: string): Promise<Archive>;
export function openChain(roots: string[]): Promise<ArchiveChain>;
export function readObject(
  chain: ArchiveChain,
  hash: string,
): AsyncGenerator<Buffer>;
export function objectBytes(chain: ArchiveChain, hash: string): Promise<Buffer>;
export function verify(
  chain: ArchiveChain,
  check?: () => Promise<void>,
): Promise<{ archives: number; objects: number }>;
export function extract(
  chain: ArchiveChain,
  destination: string,
): Promise<void>;
export function writeArchive(options: {
  format?: "palimora-archive-v1" | "palimora-backup-v1";
  root: string;
  origin: string;
  catalog: unknown;
  objects:
    | Iterable<{ hash?: string; kind: string; bytes: Buffer }>
    | AsyncIterable<{ hash?: string; kind: string; bytes: Buffer }>;
  base?: ArchiveChain;
  volumeBytes?: number;
  check?: () => Promise<void>;
  stopped?: () => boolean;
}): Promise<Archive>;
