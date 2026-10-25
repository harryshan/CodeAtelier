// Local overlay 按需变化捕获，供 Store 的读、copy-up、命名空间和显式元数据操作调用。
// 1. version 读取打开对象的身份与 NTFS 时间信息；observeRead 保留首次读版本，并校验单次读前后。
// 2. capture 在首次修改前验证已读版本，以拒绝共享写/删除的句柄保存不可变基线及 ACL。
// 3. baselines 表记录路径原始状态和修改类别；缺失/目录/重解析不递归展开或猜测普通文件内容。
// 4. baselineInput 保证普通 copy-up 使用同一份已捕获原文；目录移动仍保留原有 live lower 行为。
// 5. sealChanges 仅在 dispatcher 已销毁后运行；导出已捕获路径的结果引用，不枚举整个视图。
// 所有入口由 Store mutex 串行化；文件先 flush 后引用，失败不修改 lower，孤立对象留待受控清理。
// 版本戳不是密码学摘要，也不提供跨文件快照；尚未包含 epoch 切换、发布确认或任意目录发布。
#include "store.hpp"

#include <objbase.h>

namespace overlay {
static std::wstring version(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION identity{};
  FILE_BASIC_INFO basic{};
  require(GetFileInformationByHandle(handle, &identity));
  require(GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic)));
  return std::to_wstring(identity.dwVolumeSerialNumber) + L":" +
         std::to_wstring(identity.nFileIndexHigh) + L":" +
         std::to_wstring(identity.nFileIndexLow) + L":" +
         std::to_wstring(identity.nFileSizeHigh) + L":" +
         std::to_wstring(identity.nFileSizeLow) + L":" +
         std::to_wstring(basic.CreationTime.QuadPart) + L":" +
         std::to_wstring(basic.LastWriteTime.QuadPart) + L":" +
         std::to_wstring(basic.ChangeTime.QuadPart) + L":" +
         std::to_wstring(basic.FileAttributes);
}

static std::vector<BYTE> baselineSecurity(HANDLE handle) {
  constexpr DWORD information =
      OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  DWORD size = 0;
  GetKernelObjectSecurity(handle, information, nullptr, 0, &size);
  if (!size || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    throw Error{STATUS_ACCESS_DENIED};
  }
  std::vector<BYTE> result(size);
  require(GetKernelObjectSecurity(handle, information, result.data(), size, &size));
  return result;
}

static std::wstring copyBaseline(Store& store, HANDLE source) {
  GUID guid{};
  require(SUCCEEDED(CoCreateGuid(&guid)));
  wchar_t name[40];
  StringFromGUID2(guid, name, 40);
  Handle output(CreateFileW((store.root / L"baselines" / name).c_str(), GENERIC_WRITE,
                            FILE_SHARE_READ, nullptr, CREATE_NEW,
                            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(output.value != INVALID_HANDLE_VALUE);
  std::vector<BYTE> buffer(1024 * 1024);
  for (;;) {
    DWORD count = 0;
    require(ReadFile(source, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr));
    if (!count) {
      break;
    }
    DWORD written = 0;
    require(WriteFile(output.value, buffer.data(), count, &written, nullptr));
    if (written != count) {
      throw Error{STATUS_DISK_FULL};
    }
  }
  require(FlushFileBuffers(output.value));
  return name;
}

std::wstring Store::observeRead(const NodePtr& value, HANDLE handle,
                                const std::wstring& expected) {
  if (!localMode || !value->object.empty() || value->origin.empty()) {
    return L"";
  }
  auto stamp = version(handle);
  if (!expected.empty() && expected != stamp) {
    throw Error{STATUS_FILE_INVALID};
  }
  // Keep the earliest version in this observation epoch. Later live reads may
  // return newer bytes, but must not silently authorize an edit after an old read.
  Query(*this, "INSERT OR IGNORE INTO observations(path,name,stamp) VALUES(?,?,?)")
      .text(1, fold(value->origin))
      .text(2, value->origin)
      .text(3, stamp)
      .step();
  return stamp;
}

void Store::capture(const std::wstring& path, int flags) {
  if (!localMode || path == L"\\") {
    return;
  }
  auto key = fold(path);
  {
    Query existing(*this, "SELECT stamp FROM baselines WHERE path=?");
    if (existing.text(1, key).step()) {
      // A failed/cancelled operation or metadata-only mutation may have saved B
      // without creating private content. Reusing that B must not conceal a
      // subsequent source change. Already-private nodes keep their original B.
      NodePtr current;
      try {
        current = lookup(path);
      } catch (const Error& error) {
        if (error.status != STATUS_OBJECT_NAME_NOT_FOUND &&
            error.status != STATUS_OBJECT_PATH_NOT_FOUND && error.status != STATUS_NO_SUCH_FILE) {
          throw;
        }
      }
      if (current && !current->directory() && current->object.empty() &&
          fold(current->origin) == key) {
        auto source = openLower(current->origin, FILE_SHARE_READ);
        if (version(source.value) != existing.text(0)) {
          throw Error{STATUS_FILE_INVALID};
        }
      }
      Query(*this, "UPDATE baselines SET flags=flags|? WHERE path=?")
          .number(1, flags)
          .text(2, key)
          .step();
      return;
    }
  }

  Handle input;
  try {
    input = openLower(path, FILE_SHARE_READ);
  } catch (const Error& error) {
    if (error.status != STATUS_OBJECT_NAME_NOT_FOUND &&
        error.status != STATUS_OBJECT_PATH_NOT_FOUND && error.status != STATUS_NO_SUCH_FILE) {
      throw;
    }
  }
  std::wstring stamp = L"missing";
  DWORD attributes = 0;
  int kind = 0;
  if (input.value != INVALID_HANDLE_VALUE) {
    stamp = version(input.value);
    FILE_BASIC_INFO basic{};
    require(GetFileInformationByHandleEx(input.value, FileBasicInfo, &basic, sizeof(basic)));
    attributes = basic.FileAttributes;
    kind = (attributes & FILE_ATTRIBUTE_REPARSE_POINT)
               ? 3
               : (attributes & FILE_ATTRIBUTE_DIRECTORY) ? 2 : 1;
  }
  {
    Query observed(*this, "SELECT stamp FROM observations WHERE path=?");
    if (observed.text(1, key).step() && observed.text(0) != stamp) {
      throw Error{STATUS_FILE_INVALID};
    }
  }

  std::wstring object;
  std::vector<BYTE> security;
  if (input.value != INVALID_HANDLE_VALUE) {
    security = baselineSecurity(input.value);
    if (kind == 1) {
      object = copyBaseline(*this, input.value);
    }
    // The sharing mode excludes ordinary source writers throughout capture.
    // Verify again instead of claiming that unusual metadata races cannot occur.
    if (version(input.value) != stamp) {
      throw Error{STATUS_FILE_INVALID};
    }
  }
  Query(*this,
        "INSERT INTO baselines(path,name,kind,object,stamp,attributes,security,flags) "
        "VALUES(?,?,?,?,?,?,?,?)")
      .text(1, key)
      .text(2, path)
      .number(3, kind)
      .text(4, object)
      .text(5, stamp)
      .number(6, attributes)
      .blob(7, security.data(), static_cast<int>(security.size()))
      .number(8, flags)
      .step();
}

Handle Store::baselineInput(const NodePtr& value) {
  if (!localMode || value->origin.empty() || fold(name(value)) != fold(value->origin)) {
    return {};
  }
  Query baseline(*this, "SELECT kind,object FROM baselines WHERE path=?");
  if (!baseline.text(1, fold(value->origin)).step() || baseline.number(0) != 1) {
    throw Error{STATUS_FILE_INVALID};
  }
  Handle input(CreateFileW((root / L"baselines" / baseline.text(1)).c_str(), GENERIC_READ,
                           FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                           FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(input.value != INVALID_HANDLE_VALUE);
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  require(GetFileInformationByHandleEx(input.value, FileAttributeTagInfo, &attributes,
                                       sizeof(attributes)));
  if (attributes.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) {
    throw Error{STATUS_FILE_INVALID};
  }
  return input;
}

void Store::sealChanges() {
  if (!localMode || poisoned) {
    throw Error{STATUS_FILE_INVALID};
  }
  sql("BEGIN IMMEDIATE");
  try {
    sql("DROP TABLE IF EXISTS sealed_changes;"
        "CREATE TABLE sealed_changes(path TEXT PRIMARY KEY,kind INTEGER,"
        "object TEXT,origin TEXT,attributes INTEGER);");
    Query paths(*this, "SELECT path,name FROM baselines");
    while (paths.step()) {
      NodePtr current;
      try {
        current = lookup(paths.text(1));
      } catch (const Error& error) {
        if (error.status != STATUS_OBJECT_NAME_NOT_FOUND &&
            error.status != STATUS_OBJECT_PATH_NOT_FOUND && error.status != STATUS_NO_SUCH_FILE) {
          throw;
        }
      }
      int kind = 0;
      if (current) {
        // Kind 4 means uncaptured live content: do not synthesize O from a
        // possibly newer source. Directory/reparse publication is unsupported.
        kind = !current->reparse.empty() ? 3 : current->directory() ? 2
                                           : current->object.empty() ? 4 : 1;
      }
      Query(*this, "INSERT INTO sealed_changes VALUES(?,?,?,?,?)")
          .text(1, paths.text(0))
          .number(2, kind)
          .text(3, current ? current->object : L"")
          .text(4, current ? current->origin : L"")
          .number(5, current ? current->info.FileAttributes : 0)
          .step();
    }
    sql("COMMIT; PRAGMA wal_checkpoint(FULL)");
  } catch (...) {
    sql("ROLLBACK");
    throw;
  }
}
}  // namespace overlay
