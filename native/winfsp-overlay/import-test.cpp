// Local metadata import regression, manually built with -VerifyImport.
// 1. Create fresh source/control fixtures below the caller's workspace output directory.
// 2. Verify directory batching, stable persisted inode identities and later live source additions.
// 3. Inject a SQLite failure on the second node of a batch; require complete rollback,
//    poisoned state, failed clean shutdown and refused restore. No WinFsp mount or Sandbox.
// 4. Exercise Local's bounded statement reuse: independent nested bindings, reset/clear,
//    error disposal, schema changes and the 128-SQL limit without caching results.
// Test files are retained for inspection; all handles and databases close through Store RAII.
#include <fstream>
#include <iostream>
#include <stdexcept>

#include "store.hpp"

using namespace overlay;

static void check(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

static sqlite3_int64 scalar(Store& store, const char* sql) {
  Query query(store, sql);
  check(query.step(), "Missing scalar result");
  return query.number(0);
}

static void put(const fs::path& file) {
  std::ofstream output(file, std::ios::binary);
  output << "synthetic source\n";
  check(output.good(), "Fixture write failed");
}

static void verifyPersistence(const fs::path& root) {
  const auto source = root / L"source";
  const auto control = root / L"control";
  const auto workspace = root / L"view";
  fs::create_directory(source);
  for (int index = 0; index < 200; ++index) {
    put(source / (L"f" + std::to_wstring(index)));
  }
  sqlite3_int64 inode = 0;
  {
    Store store(source, control, workspace, true, {}, {}, L"", true);
    check(store.list(store.node(1)).size() == 200, "Incomplete directory");
    check(store.lowerImportCommits == 1, "Expected one import commit per directory");
    inode = store.lookup(L"\\f0")->id;
    check(fs::is_empty(control / L"objects"), "Enumeration copied file contents");
    check(fs::is_empty(control / L"baselines"), "Enumeration captured file baselines");
    store.finish();
  }
  put(source / L"added");
  {
    Store restored(source, control, workspace, false, {}, {}, L"", true);
    check(restored.lookup(L"\\f0")->id == inode, "Inode changed after restore");
    check(restored.list(restored.node(1)).size() == 201, "Live source addition missing");
    check(restored.lowerImportCommits == 1, "New entry not committed in directory batch");
    put(source / L"direct");
    check(restored.lookup(L"\\direct")->id != inode, "Direct lookup not imported");
    check(restored.lowerImportCommits == 2, "Direct lookup must commit independently");
    restored.finish();
  }
}

static void verifyRollback(const fs::path& root) {
  const auto source = root / L"rollback-source";
  const auto control = root / L"rollback-control";
  const auto workspace = root / L"rollback-view";
  fs::create_directory(source);
  put(source / L"first");
  put(source / L"second");
  {
    Store store(source, control, workspace, true, {}, {}, L"", true);
    store.sql("CREATE TEMP TRIGGER fail_second BEFORE INSERT ON nodes "
              "WHEN (SELECT count(*) FROM nodes)>1 "
              "BEGIN SELECT RAISE(ABORT,'injected second import failure'); END");
    bool rejected = false;
    try {
      store.list(store.node(1));
    } catch (const Error&) {
      rejected = true;
    }
    check(rejected, "Second import failure was not injected");
    check(store.poisoned, "Rolled-back shared nodes must not be reused");
    check(scalar(store, "SELECT count(*) FROM nodes") == 1, "Partial batch nodes survived");
    check(scalar(store, "SELECT count(*) FROM entries") == 0, "Partial names survived");
    check(store.lowerImportCommits == 0, "Failed batch counted as committed");
    bool cleanRejected = false;
    try {
      store.finish();
    } catch (const Error&) {
      cleanRejected = true;
    }
    check(cleanRejected, "Poisoned view marked clean");
  }
  bool restoreRejected = false;
  try {
    Store restored(source, control, workspace, false, {}, {}, L"", true);
  } catch (const Error&) {
    restoreRejected = true;
  }
  check(restoreRejected, "Unclean view silently restored");
}

static void verifyStatements(const fs::path& root) {
  const auto source = root / L"query-source";
  fs::create_directory(source);
  Store store(source, root / L"query-control", root / L"query-view", true, {}, {}, L"", true);
  const auto sql = "SELECT ?";
  {
    Query outer(store, sql);
    outer.number(1, 11);
    {
      Query inner(store, sql);
      inner.number(1, 22);
      check(inner.step() && inner.number(0) == 22, "Nested bindings not independent");
    }
    check(outer.step() && outer.number(0) == 11, "Outer binding changed");
  }
  const auto warmed = queryMetrics.prepares;
  for (int index = 0; index < 20; ++index) {
    Query query(store, sql);
    check(query.step() && sqlite3_column_type(query.value, 0) == SQLITE_NULL,
          "Bindings or cursor survived reuse");
  }
  check(queryMetrics.prepares == warmed, "Warm query recompiled");

  store.sql("CREATE TEMP TABLE reuse_test(value INTEGER UNIQUE)");
  const auto insert = "INSERT INTO reuse_test VALUES(?)";
  Query(store, insert).number(1, 1).step();
  bool rejected = false;
  try {
    Query(store, insert).number(1, 1).step();
  } catch (const Error&) {
    rejected = true;
  }
  check(rejected, "Expected constraint failure");
  const auto failed = queryMetrics.prepares;
  Query(store, insert).number(1, 2).step();
  check(queryMetrics.prepares == failed + 1, "Failed statement not discarded");
  const auto count = "SELECT count(*) FROM reuse_test";
  check(scalar(store, count) == 2, "Recovery after query error failed");
  store.sql("DROP TABLE reuse_test");
  store.sql("CREATE TEMP TABLE reuse_test(value TEXT)");
  check(scalar(store, count) == 0, "Schema/results cached across table replacement");

  for (int index = 0; index < 200; ++index) {
    const auto distinct = "SELECT " + std::to_string(index);
    check(scalar(store, distinct.c_str()) == index, "Bounded pool changed query result");
    check(store.statements.size() <= 128, "Statement cache exceeded bound");
  }
  check(store.statements.size() == 128, "Local cache was not used");
  store.finish();
}

int wmain(int argc, wchar_t** argv) {
  try {
    check(argc == 2, "Expected a fresh workspace fixture directory");
    const fs::path root(argv[1]);
    check(root.is_absolute() && fs::create_directory(root), "Fixture must be fresh and absolute");
    verifyPersistence(root);
    verifyRollback(root);
    verifyStatements(root);
    std::cout << "LOCAL_IMPORT_TEST PASS\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "LOCAL_IMPORT_TEST FAILED " << error.what() << "\n";
  } catch (const Error& error) {
    std::cerr << "LOCAL_IMPORT_TEST FAILED status=" << static_cast<UINT32>(error.status) << "\n";
  }
  return 1;
}
