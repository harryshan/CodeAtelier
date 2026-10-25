// Local overlay 发布确认；只由冻结 helper 的宿主控制通道调用，不直接写来源目录。
// 1. acknowledge 校验批次 ID、冻结标识、观察代次与选择；重复已提交收据只读返回。
// 2. 预检已封存的普通文件/缺失结果及祖先，拒绝目录、重解析、显式元数据与路径重定向。
// 3. 一个 SQLite FULL 事务释放所选 entries/baselines/change_epochs，并记录收据、切换代次。
// 4. 未选路径、旧观察和物理对象保留；重挂载清除内核句柄，历史对象回收另行处理。
// 来源 complete journal 是宿主调用方前提；此入口不推断来源写入成功，不做重放或自动恢复脏卷。
#include "store.hpp"

namespace overlay {
sqlite3_int64 Store::acknowledge(const std::wstring& id, sqlite3_int64 expectedEpoch, const std::wstring& seal,
                                const std::vector<std::wstring>& paths) {
  if (!localMode || !sealed || poisoned || expectedEpoch < 0 || expectedEpoch > 1000000000 ||
      id.size() != 36 || id.find_first_not_of(L"0123456789abcdef-") != std::wstring::npos ||
      id[8] != L'-' || id[13] != L'-' || id[18] != L'-' || id[23] != L'-' ||
      paths.empty() || paths.size() > 100) {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  std::wstring selection;
  std::set<std::wstring> keys;
  for (const auto& path : paths) {
    if (path.size() < 2 || path.size() > 4096 || path[0] != L'\\' ||
        path.back() == L'\\' || path.find_first_of(L"\r\n\0", 0, 3) != std::wstring::npos) {
      throw Error{STATUS_OBJECT_NAME_INVALID};
    }
    auto key = fold(path);
    if (!keys.insert(key).second) {
      throw Error{STATUS_INVALID_PARAMETER};
    }
  }
  for (const auto& key : keys) {
    selection += key + L"\n";
  }
  {
    Query receipt(*this, "SELECT epoch,selection,seal FROM acknowledgements WHERE id=?");
    if (receipt.text(1, id).step()) {
      if (receipt.number(0) != expectedEpoch || receipt.text(1) != selection || receipt.text(2) != seal) {
        throw Error{STATUS_FILE_INVALID};
      }
      return expectedEpoch + 1;
    }
  }
  if (epoch() != expectedEpoch) {
    throw Error{STATUS_FILE_INVALID};
  }
  {
    Query frozen(*this, "SELECT seal FROM local_state");
    if (!frozen.step() || seal.empty() || frozen.text(0) != seal) {
      // No acknowledgement was committed for this request. A later freeze may
      // include newer private writes even if the observation epoch is unchanged.
      // Never discard them using a request exported from an earlier freeze.
      throw Error{STATUS_FILE_INVALID};
    }
  }

  std::vector<std::pair<sqlite3_int64, std::wstring>> entries;
  for (const auto& path : paths) {
    auto key = fold(path);
    Query state(*this, "SELECT b.kind,b.flags,s.kind FROM baselines b "
                       "JOIN sealed_changes s ON s.path=b.path WHERE b.path=?");
    if (!state.text(1, key).step() || state.number(0) < 0 || state.number(0) > 1 ||
        (state.number(1) & 4) || state.number(2) < 0 || state.number(2) > 1) {
      throw Error{STATUS_NOT_SUPPORTED};
    }
    for (size_t offset = key.find(L'\\', 1); offset != std::wstring::npos;
         offset = key.find(L'\\', offset + 1)) {
      Query ancestor(*this, "SELECT 1 FROM baselines WHERE path=?");
      if (ancestor.text(1, key.substr(0, offset)).step()) {
        throw Error{STATUS_NOT_SUPPORTED};
      }
    }
    auto [directory, leaf] = parent(path);
    auto slash = key.find_last_of(L'\\');
    auto expectedParent = slash == 0 ? L"\\" : key.substr(0, slash);
    if (fold(directory->origin) != expectedParent) {
      throw Error{STATUS_FILE_INVALID};
    }
    entries.emplace_back(directory->id, fold(leaf));
  }

  sql("BEGIN IMMEDIATE");
  try {
    for (const auto& [parent, key] : entries) {
      Query(*this, "DELETE FROM entries WHERE parent=? AND key=?")
          .number(1, parent).text(2, key).step();
    }
    for (const auto& key : keys) {
      Query(*this, "DELETE FROM baselines WHERE path=?").text(1, key).step();
      Query(*this, "DELETE FROM sealed_changes WHERE path=?").text(1, key).step();
      Query(*this, "DELETE FROM change_epochs WHERE path=?").text(1, key).step();
    }
    Query(*this, "INSERT INTO acknowledgements VALUES(?,?,?,?)")
        .text(1, id).number(2, expectedEpoch).text(3, selection).text(4, seal).step();
    Query(*this, "UPDATE local_state SET epoch=?").number(1, expectedEpoch + 1).step();
    sql("COMMIT");
  } catch (...) {
    poisoned = true;
    sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
    throw;
  }
  cache.clear();
  sql("PRAGMA wal_checkpoint(FULL)");
  return expectedEpoch + 1;
}
}  // namespace overlay
