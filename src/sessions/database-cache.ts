/**
 * 为单个 SQLite 连接缓存固定业务语句，HistoryShards 的有界连接池调用。
 * 1. prepare 使用 SQL 文本作为键，命中时更新 LRU，最多保留 128 条 StatementSync。
 * 2. 其他方法绑定到原始 DatabaseSync，保留事务、关闭与只读语义。
 * 3. 不缓存查询结果或参数，连接回收后整个缓存随代理释放，不跨事务保存业务状态。
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

export function cachedDatabase(db: DatabaseSync) {
  const statements = new Map<string, StatementSync>();

  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          let statement = statements.get(sql);
          if (!statement) {
            statement = target.prepare(sql);
            if (statements.size >= 128) {
              statements.delete(statements.keys().next().value!);
            }
          } else {
            statements.delete(sql);
          }

          statements.set(sql, statement);

          return statement;
        };
      }

      const value = Reflect.get(target, key, target);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
