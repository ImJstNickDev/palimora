import { migrate, pool } from "./db";
migrate()
  .then(() => pool.end())
  .catch(() => {
    console.error("Migration failed");
    process.exitCode = 1;
    void pool.end();
  });
