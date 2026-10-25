// Local overlay 的冻结期内容回收，由 main 的 collect 控制命令调用。
// 1. objectName/collectReferences 仅接受生成的 GUID 引用，保留目录占位符和空引用的区别。
// 2. sweep 只枚举已固定的私有平面目录；普通单链接对象按打开句柄删除，失败保留并计数。
// 3. collect 在独占、冻结、可信 Store 内先提交无 namespace 引用 inode 的删除，再清物理孤立内容。
// 基线、冻结结果和所有 namespace 父链均作为引用根；不删读观察、确认收据或发布 journal。
// 崩溃可留下孤立内容，不能留下指向已回收内容的新引用；不访问来源，不递归，也不变更文件权限。
#include "store.hpp"

namespace overlay {
static bool objectName(const std::wstring& name) {
  if (name.size() != 38 || name.front() != L'{' || name.back() != L'}') {
    return false;
  }
  for (size_t index = 1; index < 37; ++index) {
    if (index == 9 || index == 14 || index == 19 || index == 24) {
      if (name[index] != L'-') {
        return false;
      }
    } else if (std::wstring(L"0123456789abcdefABCDEF").find(name[index]) == std::wstring::npos) {
      return false;
    }
  }
  return true;
}

static std::set<std::wstring> collectReferences(Store& store, const char* sql) {
  std::set<std::wstring> result;
  Query query(store, sql);
  while (query.step()) {
    auto name = query.text(0);
    if (name.empty() || name == L".") {
      continue;
    }
    if (!objectName(name)) {
      throw Error{STATUS_FILE_CORRUPT_ERROR};
    }
    result.insert(fold(name));
  }
  return result;
}

static void sweep(const fs::path& directory, const std::set<std::wstring>& references,
                  Collection& result) {
  // Parent directory handles exclude replacement for the entire Store lifetime.
  // Enumerate names only; never follow a directory, junction, or object alias.
  for (const auto& entry : fs::directory_iterator(directory)) {
    auto name = entry.path().filename().wstring();
    ++result.examined;
    if (references.contains(fold(name))) {
      continue;
    }
    if (!objectName(name)) {
      ++result.retained;
      continue;
    }
    Handle file(CreateFileW(entry.path().c_str(), DELETE | FILE_READ_ATTRIBUTES, 0, nullptr,
                            OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                            nullptr));
    BY_HANDLE_FILE_INFORMATION info{};
    if (file.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(file.value, &info) ||
        info.nNumberOfLinks != 1 ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
      ++result.retained;
      continue;
    }
    FILE_DISPOSITION_INFO disposition{TRUE};
    if (!SetFileInformationByHandle(file.value, FileDispositionInfo, &disposition, sizeof(disposition))) {
      ++result.retained;
      continue;
    }
    ++result.removed;
    result.bytes += (static_cast<UINT64>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
  }
}

Collection Store::collect() {
  if (!localMode || !sealed || poisoned) {
    throw Error{STATUS_FILE_INVALID};
  }
  // FspFileSystemDelete has drained kernel contexts. Be conservative if any
  // native caller still holds a Node/content handle, even after dispatcher stop.
  for (const auto& [id, value] : cache) {
    if (!value.expired()) {
      throw Error{STATUS_SHARING_VIOLATION};
    }
  }
  Collection result;
  std::set<std::wstring> objects;
  std::set<std::wstring> baselines;
  sql("BEGIN IMMEDIATE");
  try {
    // Keep every entry, including whiteouts and disconnected directory entries.
    // This intentionally favours recoverability over reclaiming whole subtrees.
    sql("WITH RECURSIVE live(id) AS (SELECT 1 UNION SELECT parent FROM entries "
        "UNION SELECT node FROM entries WHERE node<>0 "
        "UNION SELECT n.parent FROM nodes n JOIN live l ON n.id=l.id WHERE n.parent<>0) "
        "DELETE FROM nodes WHERE id NOT IN (SELECT id FROM live)");
    result.nodes = sqlite3_changes(db);
    objects = collectReferences(*this, "SELECT object FROM nodes UNION SELECT object FROM sealed_changes");
    baselines = collectReferences(*this, "SELECT object FROM baselines");
    sql("COMMIT");
  } catch (...) {
    sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
    poisoned = true;
    throw;
  }
  cache.clear();
  // Deletion follows the durable transaction. A crash between these stages
  // leaks space until another explicit sweep; it never invalidates live roots.
  sweep(root / L"objects", objects, result);
  sweep(root / L"baselines", baselines, result);
  return result;
}
}  // namespace overlay
