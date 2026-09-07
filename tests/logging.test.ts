import { it, expect, vi, afterEach } from "vitest";
import {
  readFile,
  writeFile,
  mkdir,
  truncate,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../src/logging/logger.js";
import { temp } from "./fixtures/helpers.js";
afterEach(() => vi.restoreAllMocks());
it("filters levels, retains diagnostic context and redacts structured credentials", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const root = await temp();
  const log = createLogger(root, "info", () => ["known-secret"]);
  log.debug({ event: "hidden" });
  log.info({
    event: "visible",
    taskId: "task-1",
    apiKey: "known-secret",
    token: "other-token",
    password: "other-password",
    detail: { token: "nested-token", password: 'quoted-"secret' },
  });
  const text = await readFile(path.join(root, "logs/app.log"), "utf8");
  expect(text).not.toContain("hidden");
  expect(text).not.toContain("known-secret");
  expect(text).not.toContain("other-token");
  expect(text).not.toContain("other-password");
  expect(text).not.toContain("nested-token");
  expect(text).not.toContain("quoted-");
  expect(JSON.parse(text)).toMatchObject({
    event: "visible",
    taskId: "task-1",
    level: 30,
  });
  log.level = "debug";
  log.debug({ event: "now-visible" });
  expect(await readFile(path.join(root, "logs/app.log"), "utf8")).toContain(
    "now-visible",
  );
});
it("rotates oversized logs and retains only four archives", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const root = await temp();
  const folder = path.join(root, "logs");
  await mkdir(folder);
  const file = path.join(folder, "app.log");
  await writeFile(file, "current");
  await truncate(file, 10 * 1024 * 1024 + 1);
  for (let i = 1; i <= 4; i++) await writeFile(file + "." + i, `archive${i}`);
  createLogger(root, "info").info({ event: "new" });
  expect((await readdir(folder)).sort()).toEqual([
    "app.log",
    "app.log.1",
    "app.log.2",
    "app.log.3",
    "app.log.4",
  ]);
  expect(await readFile(file + ".4", "utf8")).toBe("archive3");
  expect(JSON.parse(await readFile(file, "utf8")).event).toBe("new");
});
it("log storage failure does not crash the task or expose the original payload", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const errors = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const root = await temp();
  const log = createLogger(root, "info");
  await mkdir(path.join(root, "logs/app.log"));
  expect(() => log.error({ message: "sensitive-payload" })).not.toThrow();
  expect(errors).toHaveBeenCalledWith("CodeAtelier: log output unavailable\n");
});
