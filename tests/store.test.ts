import { it, expect } from "vitest";
import path from "node:path";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";
it("keeps sessions isolated and supports ordered event cursors", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "db"));
  try {
    const a = store.create(root, "a"),
      b = store.create(root, "b");
    const t = store.createTask(a.id);
    const first = store.event(a.id, t.id, "user", { text: "one" });
    const second = store.event(a.id, t.id, "assistant", { text: "two" });
    store.saveContext(a.id, [{ role: "user", content: "one" }]);
    expect(store.events(a.id, first.id)).toEqual([second]);
    expect(store.events(b.id)).toEqual([]);
    expect(store.context(b.id)).toEqual([]);
    expect(store.get("missing")).toBeUndefined();
    expect(
      store
        .list()
        .map((s) => s.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  } finally {
    store.close();
  }
});
it("rolls back task creation and events together when persistence fails", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "db"));
  try {
    const session = store.create(root, "s");
    expect(() =>
      store.transaction(() => {
        const task = store.createTask(session.id);
        store.event(session.id, task.id, "user", { text: "not committed" });
        throw new Error("disk fault");
      }),
    ).toThrow("disk fault");
    expect(store.tasks(session.id)).toEqual([]);
    expect(store.events(session.id)).toEqual([]);
    store.transaction(() =>
      store.saveContext(session.id, [{ role: "user", content: "committed" }]),
    );
    expect(store.context(session.id)[0].content).toBe("committed");
  } finally {
    store.close();
  }
});
it("restart interrupts active tasks but preserves terminal states and context", async () => {
  const root = await temp();
  const file = path.join(root, "db");
  let store = new Store(file);
  const session = store.create(root, "s");
  for (const status of [
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
  ] as const) {
    const task = store.createTask(session.id);
    store.status(task.id, status);
  }
  store.saveContext(session.id, [{ role: "user", content: "saved" }]);
  store.close();
  store = new Store(file);
  try {
    expect(store.tasks(session.id).map((t) => t.status)).toEqual([
      "interrupted",
      "interrupted",
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(store.context(session.id)[0].content).toBe("saved");
  } finally {
    store.close();
  }
});
