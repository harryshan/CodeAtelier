/**
 * 为 Store Worker 的同步 SQLite/JSON 工作收集受控阶段耗时，随内部回执交给主线程导出。
 * 1. measure 使用 Node 全局单调时基记录实际执行，失败同样返回时间与状态，不记录参数。
 * 2. database 包装连接、SQL 和事务边界；保留原方法 receiver，replay 写入也走相同计时。
 * 3. 最多保留 256 个阶段，其余只计 dropped，避免大批写入生成无界诊断回执。
 * 此模块不重试、不改 SQL 或事务语义，JSON 包装器仅在 Worker 显式调用。
 */
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

export interface WorkerTiming {
  phase: string;
  start: number;
  end: number;
  failed: boolean;
}

export class WorkerTimings {
  readonly entries: WorkerTiming[] = [];
  dropped = 0;

  measure<T>(phase: string, operation: () => T): T {
    const start = (performance.timeOrigin + performance.now()) * 1000;
    let failed = false;
    try {
      return operation();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (this.entries.length < 256) {
        this.entries.push({
          phase,
          start,
          end: (performance.timeOrigin + performance.now()) * 1000,
          failed,
        });
      } else {
        this.dropped++;
      }
    }
  }

  parse(text: string) {
    return this.measure("json.parse", () => JSON.parse(text));
  }

  stringify(value: unknown) {
    return this.measure("json.stringify", () => JSON.stringify(value));
  }

  database(file: string): DatabaseSync {
    const db = this.measure(
      "connect",
      () => new DatabaseSync(file, { timeout: 5000 }),
    );

    return new Proxy(db, {
      get: (target, key) => {
        if (key === "prepare") {
          return (sql: string) => {
            const statement = this.measure("sql.prepare", () =>
              target.prepare(sql),
            );

            return new Proxy(statement, {
              get: (statement, method) => {
                const value = Reflect.get(statement, method, statement);

                return typeof value === "function"
                  ? (...args: unknown[]) =>
                      this.measure("sql.execute", () =>
                        value.apply(statement, args),
                      )
                  : value;
              },
            });
          };
        }

        if (key === "exec") {
          return (sql: string) =>
            this.measure(
              sql === "BEGIN IMMEDIATE"
                ? "transaction.acquire"
                : sql === "COMMIT"
                  ? "transaction.commit"
                  : sql === "ROLLBACK"
                    ? "transaction.rollback"
                    : "sql.execute",
              () => target.exec(sql),
            );
        }

        const value = Reflect.get(target, key, target);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
