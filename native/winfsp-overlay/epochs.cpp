// Local v6 观察代次与私有内容依赖，供 Store 内容访问和冻结宿主控制调用。
// 1. trackObject 在实际写入前保留对象的当前/路径历史代次；对象名随 rename 稳定。
// 2. observePrivate 把读取旧私有结果的依赖连到当前代次，边只指向更早代次，不写来源。
// 3. nextEpoch 绑定请求 ID/旧 epoch/seal，一次 FULL 事务持久确认并推进；重复收据不重复推进。
// 所有入口沿用 Store 排他/回调串行；任何记录失败 poison，不能继续产生缺依赖的私有写入。
// 续轮保留 B/O、namespace、观察与发布收据，不把失败/取消任务变成成功发布。
#include "store.hpp"

namespace overlay {
void Store::trackObject(const NodePtr& value) {
  if (value->directory() || value->object.empty()) {
    return;
  }
  try {
    Query(*this, "INSERT OR IGNORE INTO object_epochs VALUES(?,?)")
        .text(1, value->object).number(2, epoch()).step();
    // create promotes its new inode before linking it, inside one transaction.
    // The caller repeats this after link so a recreated path also keeps old B's dependencies.
    Query linked(*this, "SELECT 1 FROM entries WHERE parent=? AND node=? LIMIT 1");
    if (linked.number(1, value->parent).number(2, value->id).step()) {
      Query(*this, "INSERT OR IGNORE INTO object_epochs SELECT ?,epoch FROM change_epochs WHERE path=?")
          .text(1, value->object).text(2, fold(name(value))).step();
    }
  } catch (...) {
    poisoned = true;
    throw;
  }
}

void Store::observePrivate(const NodePtr& value) {
  if (value->object.empty()) {
    return;
  }
  try {
    auto current = epoch();
    Query history(*this, "SELECT epoch FROM object_epochs WHERE object=?");
    history.text(1, value->object);
    bool found = false;
    while (history.step()) {
      auto dependency = history.number(0);
      if (dependency < 0 || dependency > current) {
        throw Error{STATUS_FILE_CORRUPT_ERROR};
      }
      found = true;
      if (dependency < current) {
        Query(*this, "INSERT OR IGNORE INTO epoch_links VALUES(?,?)")
            .number(1, current).number(2, dependency).step();
      }
    }
    if (!found) {
      throw Error{STATUS_FILE_CORRUPT_ERROR};
    }
  } catch (...) {
    poisoned = true;
    throw;
  }
}

sqlite3_int64 Store::nextEpoch(const std::wstring& id, sqlite3_int64 expectedEpoch,
                              const std::wstring& seal) {
  if (!sealed || poisoned || expectedEpoch < 0 || expectedEpoch >= 1000000000 ||
      id.size() != 36 || id.find_first_not_of(L"0123456789abcdef-") != std::wstring::npos ||
      id[8] != L'-' || id[13] != L'-' || id[18] != L'-' || id[23] != L'-') {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  {
    Query receipt(*this, "SELECT epoch,seal FROM epoch_transitions WHERE id=?");
    if (receipt.text(1, id).step()) {
      if (receipt.number(0) != expectedEpoch || receipt.text(1) != seal) {
        throw Error{STATUS_FILE_INVALID};
      }
      return expectedEpoch + 1;
    }
  }
  {
    Query state(*this, "SELECT epoch,seal FROM local_state");
    if (!state.step() || state.number(0) != expectedEpoch || seal.empty() || state.text(1) != seal) {
      throw Error{STATUS_FILE_INVALID};
    }
  }
  sql("BEGIN IMMEDIATE");
  try {
    Query(*this, "INSERT INTO epoch_transitions VALUES(?,?,?)")
        .text(1, id).number(2, expectedEpoch).text(3, seal).step();
    Query(*this, "UPDATE local_state SET epoch=?").number(1, expectedEpoch + 1).step();
    sql("COMMIT");
  } catch (...) {
    poisoned = true;
    sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
    throw;
  }
  return expectedEpoch + 1;
}
}  // namespace overlay
