/**
 * 验证 Skill 发现、解析和只读调用的可观察行为；所有文件在独立临时 workspace/home 中。
 * 1. install/catalog 生成真实 SKILL.md 和有任务 trace 的后端，不接触个人技能或模型服务。
 * 2. 格式用例覆盖 BOM/CRLF、多行 YAML、坏元信息、二进制和容量边界。
 * 3. 发现/加载用例覆盖六根优先级、无目录、坏条目隔离、固定目录、跨任务刷新及版本失效。
 * 4. junction/硬链接用例验证外部路径拒绝；契约验证工具与 IPC 不能请求路径或脚本权限。
 * 5. trace 用例检查发现、成功、失败、取消的终态，禁止保存技能描述和正文。
 */
import { link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { TaskSkills, presetSkillRoots } from "../src/skills/task-skills.js";
import {
  MAX_SKILL_BYTES,
  MAX_SKILLS,
  parseSkillDocument,
} from "../src/skills/skill-document.js";
import { skillToolSchema } from "../src/skills/contracts.js";
import { definitions, runtimeDefinitions } from "../src/tools/registry.js";
import { runtimeIpcMessageSchema } from "../src/sandbox/runtime-ipc-protocol.js";
import { TraceRecorder } from "../src/tracing/recorder.js";

const signal = () => new AbortController().signal;
const document = (
  name: string,
  body = "Skill private body",
  description = "Skill private description",
) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

async function install(
  root: string,
  name: string,
  body?: string,
  folder = ".codeatelier",
) {
  const directory = path.join(root, folder, "skills", name);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "SKILL.md");
  await writeFile(file, document(name, body));

  return file;
}

async function catalog(workspace: string, homeDirectory: string) {
  const traces = new TraceRecorder();
  traces.startTask("task", "session");
  const skills = await TaskSkills.create(
    {
      workspace,
      homeDirectory,
      traces,
      log: pino({ enabled: false }),
      taskId: "task",
      sessionId: "session",
    },
    signal(),
  );

  return { skills, traces };
}

it("parses UTF-8 BOM, CRLF, folded YAML and ignores permission metadata", () => {
  const text =
    "\uFEFF---\r\nname: review\r\ndescription: >-\r\n  Review changes\r\n  and tests.\r\nallowed-tools: [run_command]\r\nmetadata: &meta {nested: value}\r\nextra: *meta\r\n---\r\n# Review\r\nRead before editing.\r\n";
  expect(parseSkillDocument(Buffer.from(text), "review")).toEqual({
    name: "review",
    description: "Review changes and tests.",
    content: "# Review\nRead before editing.",
  });
});

it.each([
  "No frontmatter",
  "---\nname: review\ndescription: ok\n",
  "---\nname: other\ndescription: ok\n---\nBody",
  "---\nname: review\ndescription: 42\n---\nBody",
  "---\nname: review\ndescription: ''\n---\nBody",
  "---\nname: review\nname: review\ndescription: ok\n---\nBody",
  "---\nname: review\ndescription: [broken\n---\nBody",
  "---\nname: review\ndescription: ok\n---\n  ",
  "---\nname: review\ndescription: ok\n---\nBinary\0",
  document("review", "body", "x".repeat(1025)),
  document("review", "body", "x".repeat(9000)),
])(
  "rejects invalid Skill documents without parser payload in errors (%#)",
  (text) => {
    expect(() => parseSkillDocument(Buffer.from(text), "review")).toThrow(
      /Skill/,
    );
  },
);

it("rejects invalid UTF-8 and over-limit input, accepts the byte boundary", () => {
  expect(() => parseSkillDocument(Buffer.from([0xff]), "review")).toThrow(
    "UTF-8",
  );
  const prefix = document("review", "").trimEnd() + "\n";
  const bytes = Buffer.from(
    prefix + "x".repeat(MAX_SKILL_BYTES - Buffer.byteLength(prefix)),
  );
  expect(parseSkillDocument(bytes, "review").name).toBe("review");
  expect(() =>
    parseSkillDocument(Buffer.concat([bytes, Buffer.from("x")]), "review"),
  ).toThrow("64 KiB");
});

it("uses all six preset roots with project first and deterministic duplicate precedence", async () => {
  const workspace = await temp();
  const home = await temp();
  const roots = presetSkillRoots(workspace, home);
  for (const [index, root] of roots.entries()) {
    await mkdir(path.join(root.directory, "shared"), { recursive: true });
    await writeFile(
      path.join(root.directory, "shared", "SKILL.md"),
      document("shared", `source-${index}`),
    );
    await mkdir(path.join(root.directory, `unique-${index}`), {
      recursive: true,
    });
    await writeFile(
      path.join(root.directory, `unique-${index}`, "SKILL.md"),
      document(`unique-${index}`),
    );
  }

  const { skills } = await catalog(workspace, home);
  const list = await skills.execute({ action: "list" }, signal());
  expect(list.skills).toHaveLength(7);
  expect(
    list.diagnostics?.filter((item) => item.code === "shadowed"),
  ).toHaveLength(5);
  expect(
    await skills.execute({ action: "load", name: "shared" }, signal(), "load"),
  ).toMatchObject({
    content: "source-0",
    skill: {
      source: "project/.codeatelier/skills",
      directory: path.join(workspace, ".codeatelier", "skills", "shared"),
    },
    execution: { kind: "broker-skill", mode: "host-process" },
  });
  expect(skills.instructions()).toContain("Skill private description");
  expect(skills.instructions()).not.toContain("source-0");
});

it("handles empty roots and invalid entries independently with lower-priority fallback", async () => {
  const workspace = await temp();
  const home = await temp();
  const empty = await catalog(workspace, home);
  expect(
    await empty.skills.execute({ action: "list" }, signal()),
  ).toMatchObject({ skills: [], diagnostics: [] });
  const broken = await install(workspace, "review");
  await writeFile(broken, "invalid");
  await install(home, "review", "valid fallback");
  await install(workspace, "healthy", "healthy");
  await mkdir(path.join(workspace, ".agents"));
  await writeFile(path.join(workspace, ".agents", "skills"), "not a directory");

  const { skills } = await catalog(workspace, home);
  expect(
    (await skills.execute({ action: "list" }, signal())).diagnostics,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "invalid_skill", name: "review" }),
      expect.objectContaining({ code: "root_unavailable" }),
    ]),
  );
  expect(
    (await skills.execute({ action: "load", name: "review" }, signal()))
      .content,
  ).toBe("valid fallback");
  expect(
    (await skills.execute({ action: "load", name: "healthy" }, signal()))
      .content,
  ).toBe("healthy");
});

it("rejects changed/deleted skills and discovers edits and additions only in a new task", async () => {
  const workspace = await temp();
  const home = await temp();
  const file = await install(workspace, "review", "old");
  const { skills } = await catalog(workspace, home);
  await writeFile(file, document("review", "new"));
  await install(workspace, "added", "added");
  await expect(
    skills.execute({ action: "load", name: "review" }, signal()),
  ).rejects.toThrow("已变化");
  await expect(
    skills.execute({ action: "load", name: "added" }, signal()),
  ).rejects.toThrow("不在本任务目录");
  const refreshed = await catalog(workspace, home);
  expect(
    (
      await refreshed.skills.execute(
        { action: "load", name: "review" },
        signal(),
      )
    ).content,
  ).toBe("new");
  expect(
    (await refreshed.skills.execute({ action: "list" }, signal())).skills,
  ).toHaveLength(2);
  await rm(file);
  await expect(
    refreshed.skills.execute({ action: "load", name: "review" }, signal()),
  ).rejects.toThrow("不可读");
});

it("does not read linked roots, linked skill folders or hard-linked files", async () => {
  const workspace = await temp();
  const home = await temp();
  const outside = await temp();
  const outsideFile = await install(outside, "secret", "must not load");
  const root = path.join(workspace, ".codeatelier", "skills");
  await mkdir(root, { recursive: true });
  await symlink(
    path.dirname(outsideFile),
    path.join(root, "secret"),
    "junction",
  );
  await mkdir(path.join(root, "hardlink"));
  await link(outsideFile, path.join(root, "hardlink", "SKILL.md"));
  await mkdir(path.join(workspace, ".agents"));
  await symlink(
    path.join(outside, ".codeatelier", "skills"),
    path.join(workspace, ".agents", "skills"),
    "junction",
  );
  await symlink(
    path.join(outside, ".codeatelier"),
    path.join(workspace, ".claude"),
    "junction",
  );

  const { skills } = await catalog(workspace, home);
  expect((await skills.execute({ action: "list" }, signal())).skills).toEqual(
    [],
  );
  expect(skills.instructions()).not.toContain("must not load");
});

it("rechecks root containment after discovery when a folder is replaced with a junction", async () => {
  const workspace = await temp();
  const home = await temp();
  const outside = await temp();
  await install(workspace, "review", "identical");
  await install(outside, "review", "identical");
  const { skills } = await catalog(workspace, home);
  const root = path.join(workspace, ".codeatelier", "skills");
  await rm(root, { recursive: true });
  await symlink(path.join(outside, ".codeatelier", "skills"), root, "junction");
  await expect(
    skills.execute({ action: "load", name: "review" }, signal()),
  ).rejects.toThrow("路径不安全");
});

it("bounds the catalog and rejects oversized roots instead of using filesystem enumeration order", async () => {
  const workspace = await temp();
  const home = await temp();
  await Promise.all(
    Array.from({ length: MAX_SKILLS + 1 }, (_, index) =>
      install(workspace, `skill-${String(index).padStart(3, "0")}`),
    ),
  );
  const { skills } = await catalog(workspace, home);
  const listed = await skills.execute({ action: "list" }, signal());
  expect(listed.skills).toHaveLength(MAX_SKILLS);
  expect(listed.skills?.at(-1)?.name).toBe("skill-063");
  expect(listed.diagnostics).toContainEqual({
    source: "project/.codeatelier/skills",
    code: "catalog_limit",
  });
  const hugeRoot = path.join(home, ".agents", "skills");
  await mkdir(hugeRoot, { recursive: true });
  await Promise.all(
    Array.from({ length: 513 }, (_, index) =>
      writeFile(path.join(hugeRoot, `entry-${index}`), ""),
    ),
  );
  const refreshed = await catalog(workspace, home);
  expect(
    (await refreshed.skills.execute({ action: "list" }, signal())).diagnostics,
  ).toContainEqual({ source: "user/.agents/skills", code: "root_unavailable" });
});

it("keeps discovery, success, failure and cancellation observable without skill payload", async () => {
  const workspace = await temp();
  const home = await temp();
  await install(workspace, "review");
  const { skills, traces } = await catalog(workspace, home);
  await skills.execute(
    { action: "load", name: "review" },
    signal(),
    "load-call",
  );
  await expect(
    skills.execute({ action: "load", name: "missing" }, signal(), "bad-call"),
  ).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(
    skills.execute({ action: "list" }, controller.signal, "cancel-call"),
  ).rejects.toThrow();
  traces.finishTask("task", "ok");
  const trace = JSON.stringify(traces.exportTask("task"));
  for (const value of [
    "skills.discover",
    "skills.load",
    "cancelled",
    "error",
    "load-call",
  ]) {
    expect(trace).toContain(value);
  }

  expect(trace).not.toContain("Skill private");
  expect(trace).not.toContain(workspace);
});

it("accepts the escaped maximum catalog in Runtime startup without changing skill limits", async () => {
  const workspace = await temp();
  const home = await temp();
  await Promise.all(
    Array.from({ length: MAX_SKILLS }, async (_, index) => {
      const name = `skill-${index}`;
      const file = await install(workspace, name);
      await writeFile(
        file,
        document(name, "Body", JSON.stringify("\u0001".repeat(1024))),
      );
    }),
  );
  const { skills } = await catalog(workspace, home);
  const skillsText = skills.instructions();
  expect(skillsText.length).toBeGreaterThan(200_000);
  expect(
    runtimeIpcMessageSchema.safeParse({
      type: "request",
      requestId: "start",
      operation: "start_task",
      body: {
        workspace,
        prompt: "Use skills",
        skillsText,
        settings: {
          model: "test",
          maxSteps: 2,
          commandTimeoutMs: 1000,
          contextChars: 10000,
          outputChars: 1000,
        },
      },
    }).success,
  ).toBe(true);
});

it("shares strict host/Runtime contracts and rejects paths, commands and old IPC versions", () => {
  for (const tools of [definitions, runtimeDefinitions]) {
    expect(tools.find((tool) => tool.name === "skill")?.strict).toBe(true);
  }

  for (const request of [
    { action: "load", name: "../secret" },
    { action: "execute", name: "review" },
    { action: "list", path: "/private" },
    { action: "load", name: "review", command: "anything" },
  ]) {
    expect(skillToolSchema.safeParse({ request }).success).toBe(false);
  }

  const message = {
    type: "request",
    requestId: "r",
    operation: "skill_execute",
    body: { toolCallId: "call", request: { action: "load", name: "review" } },
  };
  expect(runtimeIpcMessageSchema.safeParse(message).success).toBe(true);
  expect(
    runtimeIpcMessageSchema.safeParse({
      ...message,
      body: { ...message.body, workspace: "/other" },
    }).success,
  ).toBe(false);
  expect(
    runtimeIpcMessageSchema.safeParse({
      type: "hello",
      protocolVersion: 5,
      nonce: "0123456789abcdef0123456789abcdef",
    }).success,
  ).toBe(false);
});
