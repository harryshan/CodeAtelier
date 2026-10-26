// 将 WinFsp 原生回调映射到 Store，供 main 启动 dispatcher。
// 1. guarded 串行化操作，将 Win32/SQLite 异常转为 NTSTATUS；污染状态一律失败关闭。
// 2. 创建/打开/读取/写入共享 Node 身份，copy-up 后旧描述符也读取同一个私有对象。
// 3. 命名空间、属性、DACL 与枚举委托 Store；Cleanup 无错误通道，失败使挂载失效。
// 4. 重解析回调在当前虚拟路径检查目标，目录移动不能使相对链接越出视图。
// 5. Git PoC/Local 卷使用 no-atime；仅忽略自动访问时间，显式 SetBasic/写入仍持久化。
// 6. Local 显式元数据修改与可删除预检保存基线，避免仅在无错误返回的 Cleanup 中发现陈旧读。
// 7. Local 枚举按打开句柄缓冲名称/元数据；续页不重扫，重启/重开观察来源，异常填充清空、Close 释放。
// WinFsp 内核执行用户访问、共享模式和锁检查，不以 helper 宿主权限替调用者绕过检查。
#include <algorithm>
#include <cstring>
#include <iostream>
#include <source_location>

#include "store.hpp"

namespace overlay {
struct Context {
  NodePtr node;
  PVOID directoryBuffer = nullptr;
  ~Context() {
    FspFileSystemDeleteDirectoryBuffer(&directoryBuffer);
  }
};
static NodePtr opened(PVOID context) {
  return static_cast<Context*>(context)->node;
}

static void normalizedName(Store& store, const NodePtr& node, FSP_FSCTL_FILE_INFO* info) {
  auto name = store.name(node);
  auto output = FspFileSystemGetOpenFileInfo(info);
  auto size = name.size() * sizeof(wchar_t);
  if (size > output->NormalizedNameSize) {
    throw Error{STATUS_NAME_TOO_LONG};
  }
  memcpy(output->NormalizedName, name.data(), size);
  output->NormalizedNameSize = static_cast<UINT16>(size);
}

template <typename Function>
static NTSTATUS guarded(FSP_FILE_SYSTEM* fs, Function function,
                        std::source_location location = std::source_location::current()) {
  auto& store = *static_cast<Store*>(fs->UserContext);
  std::lock_guard lock(store.mutex);
  if (store.poisoned) {
    return STATUS_FILE_INVALID;
  }
  try {
    function(store);
    return STATUS_SUCCESS;
  } catch (const Error& error) {
    if (error.status != STATUS_NOT_A_REPARSE_POINT &&
        error.status != STATUS_OBJECT_NAME_NOT_FOUND &&
        error.status != STATUS_OBJECT_PATH_NOT_FOUND && error.status != STATUS_NO_SUCH_FILE &&
        error.status != STATUS_END_OF_FILE && error.status != STATUS_OBJECT_NAME_COLLISION &&
        error.status != STATUS_BUFFER_OVERFLOW) {
      std::cerr << "OVERLAY_IO_ERROR line=" << location.line()
                << " status=" << static_cast<UINT32>(error.status) << "\n";
    }
    return error.status;
  } catch (const std::bad_alloc&) {
    return STATUS_INSUFFICIENT_RESOURCES;
  } catch (...) {
    return STATUS_UNEXPECTED_IO_ERROR;
  }
}

static void copySecurity(const std::vector<BYTE>& bytes, PSECURITY_DESCRIPTOR output,
                         SIZE_T* size) {
  if (!size) {
    return;
  }
  SIZE_T capacity = *size;
  *size = bytes.size();
  if (capacity < bytes.size()) {
    throw Error{STATUS_BUFFER_OVERFLOW};
  }
  if (output) {
    memcpy(output, bytes.data(), bytes.size());
  }
}

static NTSTATUS volume(FSP_FILE_SYSTEM* fs, FSP_FSCTL_VOLUME_INFO* info) {
  return guarded(fs, [&](Store& store) {
    ULARGE_INTEGER free{};
    ULARGE_INTEGER total{};
    require(GetDiskFreeSpaceExW(store.root.c_str(), nullptr, &total, &free));
    info->TotalSize = total.QuadPart;
    info->FreeSize = free.QuadPart;
    const wchar_t label[] = L"CodeAtelier overlay";
    info->VolumeLabelLength = sizeof(label) - sizeof(wchar_t);
    memcpy(info->VolumeLabel, label, sizeof(label));
  });
}

static NTSTATUS reparseByName(FSP_FILE_SYSTEM* fs, PVOID, PWSTR name, BOOLEAN, PVOID output,
                              SIZE_T* size) {
  return guarded(fs, [&](Store& store) {
    auto node = store.lookup(name);
    if (node->reparse.empty()) {
      throw Error{STATUS_NOT_A_REPARSE_POINT};
    }
    if (size) {
      // A parent can be renamed after the link was imported. Revalidate at the
      // current virtual location, before returning any target to the kernel.
      auto bytes = internalReparse(node->reparse.data(), node->reparse.size(),
                                   store.workspace / store.name(node).substr(1), store.workspace,
                                   store.workspace);
      copySecurity(bytes, output, size);
    }
  });
}

static NTSTATUS securityByName(FSP_FILE_SYSTEM* fs, PWSTR name, PUINT32 attributes,
                               PSECURITY_DESCRIPTOR output, SIZE_T* size) {
  auto result = guarded(fs, [&](Store& store) {
    auto node = store.lookup(name);
    if (attributes) {
      *attributes = node->info.FileAttributes;
    }
    if (size) {
      copySecurity(store.security(node), output, size);
    }
  });
  if (!NT_SUCCESS(result) && result != STATUS_BUFFER_OVERFLOW &&
      FspFileSystemFindReparsePoint(fs, reparseByName, nullptr, name, attributes)) {
    return STATUS_REPARSE;
  }
  return result;
}

static NTSTATUS create(FSP_FILE_SYSTEM* fs, PWSTR name, UINT32 options, UINT32, UINT32 attributes,
                       PSECURITY_DESCRIPTOR security, UINT64, PVOID* context,
                       FSP_FSCTL_FILE_INFO* info) {
  return guarded(fs, [&](Store& store) {
    if (options & FILE_DIRECTORY_FILE) {
      attributes |= FILE_ATTRIBUTE_DIRECTORY;
    }
    auto node = store.create(name, attributes, security);
    auto descriptor = std::make_unique<Context>();
    descriptor->node = node;
    *info = store.info(node);
    normalizedName(store, node, info);
    *context = descriptor.release();
  });
}

static NTSTATUS open(FSP_FILE_SYSTEM* fs, PWSTR name, UINT32 options, UINT32, PVOID* context,
                     FSP_FSCTL_FILE_INFO* info) {
  return guarded(fs, [&](Store& store) {
    auto node = store.lookup(name);
    if ((options & FILE_DIRECTORY_FILE) && !node->directory()) {
      throw Error{STATUS_NOT_A_DIRECTORY};
    }
    if ((options & FILE_NON_DIRECTORY_FILE) && node->directory()) {
      throw Error{STATUS_FILE_IS_A_DIRECTORY};
    }
    auto descriptor = std::make_unique<Context>();
    descriptor->node = node;
    *info = store.info(node);
    normalizedName(store, node, info);
    *context = descriptor.release();
  });
}

static void resize(Store& store, const NodePtr& node, UINT64 size) {
  FILE_END_OF_FILE_INFO end{};
  end.EndOfFile.QuadPart = size;
  HANDLE handle = store.content(node, true);
  try {
    require(SetFileInformationByHandle(handle, FileEndOfFileInfo, &end, sizeof(end)));
    require(FlushFileBuffers(handle));
    node->info.LastWriteTime = node->info.ChangeTime = now();
    store.save(node);
  } catch (...) {
    // Bytes may have changed even when a later flush or metadata update failed.
    store.poisoned = true;
    throw;
  }
}

static NTSTATUS overwrite(FSP_FILE_SYSTEM* fs, PVOID context, UINT32 attributes, BOOLEAN replace,
                          UINT64, FSP_FSCTL_FILE_INFO* info) {
  return guarded(fs, [&](Store& store) {
    auto node = opened(context);
    resize(store, node, 0);
    node->info.FileAttributes = replace ? attributes : node->info.FileAttributes | attributes;
    store.save(node);
    *info = store.info(node);
  });
}

static void cleanup(FSP_FILE_SYSTEM* fs, PVOID context, PWSTR name, ULONG flags) {
  NTSTATUS result = guarded(fs, [&](Store& store) {
    auto node = opened(context);
    if (flags & FspCleanupSetLastAccessTime) {
      ++queryMetrics.accessCleanups;
      if (store.git || store.localMode) {
        // Plain reads must not issue an atime-only durable transaction per
        // close. Neither Git stat nor Local read stamps use access time;
        // explicit SetBasic timestamps and all other cleanup flags persist.
        flags &= ~FspCleanupSetLastAccessTime;
      }
    }
    if (flags & FspCleanupDelete) {
      store.remove(name, node->id);
    }
    if (flags & FspCleanupSetArchiveBit) {
      node->info.FileAttributes |= FILE_ATTRIBUTE_ARCHIVE;
    }
    if (flags & FspCleanupSetLastWriteTime) {
      node->info.LastWriteTime = now();
    }
    if (flags & FspCleanupSetChangeTime) {
      node->info.ChangeTime = now();
    }
    if (flags & FspCleanupSetLastAccessTime) {
      node->info.LastAccessTime = now();
    }
    if (flags) {
      store.save(node);
    }
  });
  if (!NT_SUCCESS(result)) {
    auto& store = *static_cast<Store*>(fs->UserContext);
    std::lock_guard lock(store.mutex);
    store.poisoned = true;
    std::cerr << "OVERLAY_CLEANUP_ERROR status=" << static_cast<UINT32>(result) << "\n";
  }
}

static void close(FSP_FILE_SYSTEM* fs, PVOID context) {
  auto& store = *static_cast<Store*>(fs->UserContext);
  std::lock_guard lock(store.mutex);
  delete static_cast<Context*>(context);
}

static void seek(HANDLE handle, UINT64 offset) {
  LARGE_INTEGER position{};
  position.QuadPart = offset;
  require(SetFilePointerEx(handle, position, nullptr, FILE_BEGIN));
}

static NTSTATUS read(FSP_FILE_SYSTEM* fs, PVOID context, PVOID buffer, UINT64 offset, ULONG length,
                     PULONG transferred) {
  return guarded(fs, [&](Store& store) {
    auto node = opened(context);
    if (node->directory()) {
      throw Error{STATUS_FILE_IS_A_DIRECTORY};
    }
    *transferred = store.read(node, buffer, offset, length);
    if (!*transferred && length) {
      throw Error{STATUS_END_OF_FILE};
    }
  });
}

static NTSTATUS write(FSP_FILE_SYSTEM* fs, PVOID context, PVOID buffer, UINT64 offset, ULONG length,
                      BOOLEAN append, BOOLEAN constrained, PULONG transferred,
                      FSP_FSCTL_FILE_INFO* info) {
  return guarded(fs, [&](Store& store) {
    auto node = opened(context);
    auto before = store.info(node);
    if (append) {
      offset = before.FileSize;
    }
    if (constrained) {
      length = offset >= before.FileSize
                   ? 0
                   : static_cast<ULONG>(std::min<UINT64>(length, before.FileSize - offset));
    }
    HANDLE handle = store.content(node, true);
    seek(handle, offset);
    try {
      require(WriteFile(handle, buffer, length, transferred, nullptr));
      if (*transferred != length) {
        throw Error{STATUS_DISK_FULL};
      }
      require(FlushFileBuffers(handle));
      node->info.LastWriteTime = node->info.ChangeTime = now();
      node->info.FileAttributes |= FILE_ATTRIBUTE_ARCHIVE;
      store.save(node);
    } catch (...) {
      store.poisoned = true;
      throw;
    }
    *info = store.info(node);
  });
}

static NTSTATUS flush(FSP_FILE_SYSTEM* fs, PVOID context, FSP_FSCTL_FILE_INFO* info) {
  return guarded(fs, [&](Store& store) {
    for (auto& [id, weak] : store.cache) {
      if (auto node = weak.lock();
          node && !node->object.empty() && node->content.value != INVALID_HANDLE_VALUE) {
        require(FlushFileBuffers(node->content.value));
      }
    }
    store.sql("PRAGMA wal_checkpoint(FULL)");
    if (context && info) {
      *info = store.info(opened(context));
    }
  });
}

static NTSTATUS getInfo(FSP_FILE_SYSTEM* fs, PVOID context, FSP_FSCTL_FILE_INFO* info) {
  return guarded(fs, [&](Store& store) { *info = store.info(opened(context)); });
}

static NTSTATUS setBasic(FSP_FILE_SYSTEM* fs, PVOID context, UINT32 attributes, UINT64 creation,
                         UINT64 access, UINT64 write, UINT64 change, FSP_FSCTL_FILE_INFO* info) {
  return guarded(fs, [&](Store& store) {
    auto node = opened(context);
    if (node->id != 1 && (attributes != INVALID_FILE_ATTRIBUTES || creation || access || write || change)) {
      store.capture(store.name(node), 4);
    }
    if (attributes != INVALID_FILE_ATTRIBUTES) {
      if (attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_ENCRYPTED)) {
        throw Error{STATUS_NOT_SUPPORTED};
      }
      node->info.FileAttributes = attributes | (node->directory() ? FILE_ATTRIBUTE_DIRECTORY : 0);
    }
    // Attribute-only writes must not change lower. Pin bytes when changing file
    // times.
    if (!node->directory() && (creation || access || write || change)) {
      store.promote(node);
    }
    if (creation) {
      node->info.CreationTime = creation;
    }
    if (access) {
      node->info.LastAccessTime = access;
    }
    if (write) {
      node->info.LastWriteTime = write;
    }
    if (change) {
      node->info.ChangeTime = change;
    }
    store.save(node);
    *info = store.info(node);
  });
}

static NTSTATUS setSize(FSP_FILE_SYSTEM* fs, PVOID context, UINT64 size, BOOLEAN allocation,
                        FSP_FSCTL_FILE_INFO* info) {
  return guarded(fs, [&](Store& store) {
    auto node = opened(context);
    if (!allocation || size < store.info(node).FileSize) {
      resize(store, node, size);
    }
    *info = store.info(node);
  });
}

static NTSTATUS canDelete(FSP_FILE_SYSTEM* fs, PVOID context, PWSTR name) {
  return guarded(fs, [&](Store& store) {
    auto node = opened(context);
    if (node->id == 1) {
      throw Error{STATUS_ACCESS_DENIED};
    }
    if (node->directory() && node->reparse.empty() && !store.list(node).empty()) {
      throw Error{STATUS_DIRECTORY_NOT_EMPTY};
    }
    store.capture(name, 2);
  });
}

static NTSTATUS rename(FSP_FILE_SYSTEM* fs, PVOID, PWSTR from, PWSTR to, BOOLEAN replace) {
  return guarded(fs, [&](Store& store) { store.rename(from, to, replace); });
}

static NTSTATUS getSecurity(FSP_FILE_SYSTEM* fs, PVOID context, PSECURITY_DESCRIPTOR output,
                            SIZE_T* size) {
  return guarded(
      fs, [&](Store& store) { copySecurity(store.security(opened(context)), output, size); });
}

static NTSTATUS setSecurity(FSP_FILE_SYSTEM* fs, PVOID context, SECURITY_INFORMATION information,
                            PSECURITY_DESCRIPTOR descriptor) {
  return guarded(
      fs, [&](Store& store) { store.setSecurity(opened(context), information, descriptor); });
}

static void localDirectory(Store& store, Context& context, PWSTR marker, PVOID output,
                            ULONG length, PULONG transferred) {
  NTSTATUS result;
  if (FspFileSystemAcquireDirectoryBuffer(&context.directoryBuffer, marker == nullptr, &result)) {
    try {
      auto entries = store.list(context.node);
      if (context.node->id != 1) {
        entries.insert(entries.begin(), {L"..", store.node(context.node->parent)});
        entries.insert(entries.begin(), {L".", context.node});
      }
      // WinFsp sorts the completed buffer using its continuation-marker ordering.
      // Only names and returned metadata are retained, never open lower file handles.
      for (const auto& entry : entries) {
        const size_t size = FIELD_OFFSET(FSP_FSCTL_DIR_INFO, FileNameBuf) +
                            entry.name.size() * sizeof(wchar_t);
        std::vector<BYTE> bytes(size);
        auto info = reinterpret_cast<FSP_FSCTL_DIR_INFO*>(bytes.data());
        info->Size = static_cast<UINT16>(size);
        info->FileInfo = store.info(entry.node);
        memcpy(info->FileNameBuf, entry.name.data(), entry.name.size() * sizeof(wchar_t));
        if (!FspFileSystemFillDirectoryBuffer(&context.directoryBuffer, info, &result)) {
          checked(result);
          throw Error{STATUS_UNEXPECTED_IO_ERROR};
        }
      }
    } catch (...) {
      FspFileSystemReleaseDirectoryBuffer(&context.directoryBuffer);
      FspFileSystemDeleteDirectoryBuffer(&context.directoryBuffer);
      throw;
    }
    FspFileSystemReleaseDirectoryBuffer(&context.directoryBuffer);
  }
  checked(result);
  *transferred = 0;
  FspFileSystemReadDirectoryBuffer(&context.directoryBuffer, marker, output, length, transferred);
}

static NTSTATUS directory(FSP_FILE_SYSTEM* fs, PVOID context, PWSTR, PWSTR marker, PVOID output,
                          ULONG length, PULONG transferred) {
  return guarded(fs, [&](Store& store) {
    if (store.localMode) {
      localDirectory(store, *static_cast<Context*>(context), marker, output, length, transferred);
      return;
    }
    auto node = opened(context);
    auto entries = store.list(node);
    if (node->id != 1) {
      entries.insert(entries.begin(), {L"..", store.node(node->parent)});
      entries.insert(entries.begin(), {L".", node});
    }
    // Match the UTF-16 ordinal ordering used for continuation markers. SQLite's
    // UTF-8 byte order differs for supplementary Unicode characters.
    std::sort(entries.begin(), entries.end(), [](const Entry& left, const Entry& right) {
      return CompareStringOrdinal(left.name.c_str(), -1, right.name.c_str(), -1, TRUE) ==
             CSTR_LESS_THAN;
    });
    *transferred = 0;
    for (auto& entry : entries) {
      if (marker &&
          CompareStringOrdinal(entry.name.c_str(), -1, marker, -1, TRUE) != CSTR_GREATER_THAN) {
        continue;
      }
      size_t size =
          FIELD_OFFSET(FSP_FSCTL_DIR_INFO, FileNameBuf) + entry.name.size() * sizeof(wchar_t);
      std::vector<BYTE> buffer(size);
      auto info = reinterpret_cast<FSP_FSCTL_DIR_INFO*>(buffer.data());
      info->Size = static_cast<UINT16>(size);
      info->FileInfo = store.info(entry.node);
      memcpy(info->FileNameBuf, entry.name.data(), entry.name.size() * sizeof(wchar_t));
      if (!FspFileSystemAddDirInfo(info, output, length, transferred)) {
        return;
      }
    }
    FspFileSystemAddDirInfo(nullptr, output, length, transferred);
  });
}

static NTSTATUS resolveReparse(FSP_FILE_SYSTEM* fs, PWSTR name, UINT32 index, BOOLEAN last,
                               PIO_STATUS_BLOCK status, PVOID buffer, SIZE_T* size) {
  return FspFileSystemResolveReparsePoints(fs, reparseByName, nullptr, name, index, last, status,
                                           buffer, size);
}

static NTSTATUS getReparse(FSP_FILE_SYSTEM* fs, PVOID context, PWSTR, PVOID buffer, SIZE_T* size) {
  return guarded(fs, [&](Store& store) {
    auto node = opened(context);
    if (node->reparse.empty()) {
      throw Error{STATUS_NOT_A_REPARSE_POINT};
    }
    auto bytes = internalReparse(node->reparse.data(), node->reparse.size(),
                                 store.workspace / store.name(node).substr(1), store.workspace,
                                 store.workspace);
    copySecurity(bytes, buffer, size);
  });
}

static NTSTATUS setReparse(FSP_FILE_SYSTEM* fs, PVOID context, PWSTR, PVOID buffer, SIZE_T size) {
  return guarded(fs, [&](Store& store) {
    auto node = opened(context);
    if (!node->reparse.empty()) {
      checked(FspFileSystemCanReplaceReparsePoint(node->reparse.data(), node->reparse.size(),
                                                  buffer, size));
    }
    store.setReparse(node, buffer, size);
  });
}

static NTSTATUS deleteReparse(FSP_FILE_SYSTEM* fs, PVOID context, PWSTR, PVOID buffer,
                              SIZE_T size) {
  return guarded(fs, [&](Store& store) {
    auto node = opened(context);
    if (node->reparse.empty()) {
      throw Error{STATUS_NOT_A_REPARSE_POINT};
    }
    checked(FspFileSystemCanReplaceReparsePoint(node->reparse.data(), node->reparse.size(), buffer,
                                                size));
    node->reparse.clear();
    node->origin.clear();
    node->info.FileAttributes &= ~FILE_ATTRIBUTE_REPARSE_POINT;
    node->info.ReparseTag = 0;
    if (!node->directory()) {
      store.promote(node);
    }
    store.save(node);
  });
}

FSP_FILE_SYSTEM_INTERFACE& callbacks() {
  static FSP_FILE_SYSTEM_INTERFACE callbacks = [] {
    FSP_FILE_SYSTEM_INTERFACE value{};
    value.GetVolumeInfo = volume;
    value.GetSecurityByName = securityByName;
    value.Create = create;
    value.Open = open;
    value.Overwrite = overwrite;
    value.Cleanup = cleanup;
    value.Close = close;
    value.Read = read;
    value.Write = write;
    value.Flush = flush;
    value.GetFileInfo = getInfo;
    value.SetBasicInfo = setBasic;
    value.SetFileSize = setSize;
    value.CanDelete = canDelete;
    value.Rename = rename;
    value.GetSecurity = getSecurity;
    value.SetSecurity = setSecurity;
    value.ReadDirectory = directory;
    value.ResolveReparsePoints = resolveReparse;
    value.GetReparsePoint = getReparse;
    value.SetReparsePoint = setReparse;
    value.DeleteReparsePoint = deleteReparse;
    return value;
  }();
  return callbacks;
}
}  // namespace overlay
