// Local 来源目录成员依赖，供 Store::list、capture 和冻结 checkReads 调用。
// 1. directorySnapshot 只枚举给定已打开目录的直接子项，排除视图隐藏的 .git 和点项。
// 2. 按原始 UTF-16 名称排序，摘要绑定目录身份及成员名称/类型；不使用持久目录时间戳。
// 3. 枚举前后及调用方导入后用 guard 检查身份/时间，拒绝可观测竞争，不保证 OS 原子快照。
// 4. observeDirectory 保留本代次首次观察，SQL 失败毒化卷；不修改来源、不递归、不记录源码。
// 每目录最多 100,000 项/16 MiB 编码；超限拒绝枚举，不返回未记录的成功读结果。
#include "store.hpp"

#include <algorithm>
#include <bcrypt.h>

namespace overlay {
static std::wstring directoryGuard(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION info{};
  FILE_BASIC_INFO basic{};
  require(GetFileInformationByHandle(handle, &info));
  require(GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic)));
  if (!(basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    throw Error{STATUS_NOT_A_DIRECTORY};
  }
  return std::to_wstring(info.dwVolumeSerialNumber) + L":" +
         std::to_wstring(info.nFileIndexHigh) + L":" + std::to_wstring(info.nFileIndexLow) +
         L":" + std::to_wstring(basic.CreationTime.QuadPart) + L":" +
         std::to_wstring(basic.LastWriteTime.QuadPart) + L":" +
         std::to_wstring(basic.ChangeTime.QuadPart) + L":" +
         std::to_wstring(basic.FileAttributes);
}

void verifyDirectoryGuard(HANDLE handle, const std::wstring& expected) {
  if (directoryGuard(handle) != expected) {
    throw Error{STATUS_FILE_INVALID};
  }
}

DirectorySnapshot directorySnapshot(HANDLE handle) {
  DirectorySnapshot result;
  result.guard = directoryGuard(handle);
  BY_HANDLE_FILE_INFORMATION identity{};
  require(GetFileInformationByHandle(handle, &identity));
  alignas(8) BYTE buffer[65536];
  bool first = true;
  size_t bytes = 0;
  for (;;) {
    if (!GetFileInformationByHandleEx(
            handle, first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
            buffer, sizeof(buffer))) {
      if (GetLastError() == ERROR_NO_MORE_FILES) {
        break;
      }
      require(false);
    }
    first = false;
    auto entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer);
    for (;;) {
      std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
      if (name != L"." && name != L".." && fold(name) != L".GIT") {
        bytes += (name.size() + 2) * sizeof(wchar_t);
        if (result.entries.size() >= 100000 || bytes > 16 * 1024 * 1024) {
          throw Error{STATUS_INSUFFICIENT_RESOURCES};
        }
        result.entries.emplace_back(name, entry->FileAttributes);
      }
      if (!entry->NextEntryOffset) {
        break;
      }
      entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<BYTE*>(entry) +
                                                       entry->NextEntryOffset);
    }
  }
  verifyDirectoryGuard(handle, result.guard);
  std::sort(result.entries.begin(), result.entries.end());
  std::wstring encoded;
  encoded.reserve(bytes / sizeof(wchar_t));
  for (const auto& [name, attributes] : result.entries) {
    encoded += name;
    encoded += L'\0';
    encoded += (attributes & FILE_ATTRIBUTE_REPARSE_POINT) ? L'l' :
               (attributes & FILE_ATTRIBUTE_DIRECTORY) ? L'd' : L'f';
  }
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  checked(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0));
  BYTE hash[32];
  auto status = BCryptHash(algorithm, nullptr, 0, reinterpret_cast<BYTE*>(encoded.data()),
                           static_cast<ULONG>(encoded.size() * sizeof(wchar_t)), hash, sizeof(hash));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  checked(status);
  result.stamp = L"directory-v1:" + std::to_wstring(identity.dwVolumeSerialNumber) + L":" +
                 std::to_wstring(identity.nFileIndexHigh) + L":" +
                 std::to_wstring(identity.nFileIndexLow) + L":";
  constexpr wchar_t digits[] = L"0123456789abcdef";
  for (auto byte : hash) {
    result.stamp += digits[byte >> 4];
    result.stamp += digits[byte & 15];
  }
  return result;
}

void Store::observeDirectory(const std::wstring& path, const std::wstring& stamp) {
  try {
    Query(*this, "INSERT OR IGNORE INTO observations(path,name,stamp,epoch) VALUES(?,?,?,?)")
        .text(1, fold(path)).text(2, path).text(3, stamp).number(4, epoch()).step();
  } catch (...) {
    poisoned = true;
    throw;
  }
}
}  // namespace overlay
