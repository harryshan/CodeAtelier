/**
 * Linux 单轮缓存删除的路径/身份回归，只操作测试独占目录。
 * 1. 正常回收删除指定缓存，保留旁侧缓存、upper、round 与来源内容。
 * 2. 拒绝非 UUID 缓存、非直接子目录、身份替换和 symlink/junction，不遍历目标之外。
 * 不模拟挂载退出；backend/原生手动探针负责证明调用时机。
 */
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { discardLinuxCache } from "../src/local-overlays/linux-cache.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";
import { temp } from "./fixtures/helpers.js";

it("removes only the explicitly bound closed cache", async () => {
  const root = await temp();
  const cache = path.join(root, `control-${randomUUID()}`);
  const other = path.join(root, `control-${randomUUID()}`);
  await mkdir(cache);
  await mkdir(other);
  await mkdir(path.join(root, "upper"));
  await writeFile(path.join(cache, "object-1"), "baseline");
  await writeFile(path.join(root, "upper", "source.ts"), "private");
  await writeFile(path.join(root, "round.json"), "retained B");
  await discardLinuxCache(root, cache, (await sourceIdentity(cache)).identity);
  await expect(lstat(cache)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(other)).toEqual([]);
  expect(await readFile(path.join(root, "upper", "source.ts"), "utf8")).toBe(
    "private",
  );
  expect(await readFile(path.join(root, "round.json"), "utf8")).toBe(
    "retained B",
  );
});

it("rejects unrelated paths, identity mismatches and linked cache targets", async () => {
  const root = await temp();
  const outside = await temp();
  const cache = path.join(outside, `control-${randomUUID()}`);
  await mkdir(cache);
  await writeFile(path.join(cache, "sentinel"), "preserved");
  const identity = (await sourceIdentity(cache)).identity;
  await expect(discardLinuxCache(root, cache, identity)).rejects.toThrow(
    "CACHE_PATH_INVALID",
  );
  await expect(discardLinuxCache(outside, cache, "wrong")).rejects.toThrow(
    "CACHE_REPLACED",
  );
  await expect(
    discardLinuxCache(root, path.join(root, "upper"), identity),
  ).rejects.toThrow("CACHE_PATH_INVALID");
  const link = path.join(root, `control-${randomUUID()}`);
  await symlink(cache, link, process.platform === "win32" ? "junction" : "dir");
  await expect(discardLinuxCache(root, link, identity)).rejects.toThrow(
    "CACHE_REPLACED",
  );
  expect(await readFile(path.join(cache, "sentinel"), "utf8")).toBe(
    "preserved",
  );
});
