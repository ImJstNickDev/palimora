export class SyncError extends Error {
  constructor(
    public code: string,
    public delay = 3600000,
  ) {
    super(code);
  }
}
