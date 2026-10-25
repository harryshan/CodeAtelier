// Normalize supported reparse points without following a host path.
// 1. Parse bounded native symlink/junction data and validate every offset.
// 2. Map source-internal targets into the virtual UNC root; junctions become
// directory symlinks.
// 3. Reject external targets, unknown tags and escapes; no link can expose
// writable lower paths. Called on lazy lower import and explicit
// SetReparsePoint; only metadata is returned.
#include <cstring>

#include "store.hpp"

namespace overlay {
static std::wstring targetName(const BYTE* buffer, size_t size, size_t start, USHORT offset,
                               USHORT length) {
  if (offset % sizeof(wchar_t) || length % sizeof(wchar_t) || start + offset + length > size ||
      !length) {
    throw Error{STATUS_IO_REPARSE_DATA_INVALID};
  }
  std::wstring name(reinterpret_cast<const wchar_t*>(buffer + start + offset),
                    length / sizeof(wchar_t));
  if (name.find(L'\0') != std::wstring::npos) {
    throw Error{STATUS_IO_REPARSE_DATA_INVALID};
  }
  return name;
}

std::vector<BYTE> internalReparse(const void* buffer, size_t size, const fs::path& origin,
                                  const fs::path& root, const fs::path& targetRoot) {
  if (size < REPARSE_DATA_BUFFER_HEADER_SIZE || size > MAXIMUM_REPARSE_DATA_BUFFER_SIZE) {
    throw Error{STATUS_IO_REPARSE_DATA_INVALID};
  }
  auto data = static_cast<const REPARSE_DATA_BUFFER*>(buffer);
  if (data->ReparseDataLength + REPARSE_DATA_BUFFER_HEADER_SIZE != size) {
    throw Error{STATUS_IO_REPARSE_DATA_INVALID};
  }
  auto bytes = static_cast<const BYTE*>(buffer);
  std::wstring target;
  bool relative = false;
  if (data->ReparseTag == IO_REPARSE_TAG_SYMLINK &&
      size >= FIELD_OFFSET(REPARSE_DATA_BUFFER, SymbolicLinkReparseBuffer.PathBuffer)) {
    const auto& link = data->SymbolicLinkReparseBuffer;
    if (link.Flags & ~SYMLINK_FLAG_RELATIVE) {
      throw Error{STATUS_IO_REPARSE_DATA_INVALID};
    }
    relative = (link.Flags & SYMLINK_FLAG_RELATIVE) != 0;
    target = targetName(bytes, size,
                        FIELD_OFFSET(REPARSE_DATA_BUFFER, SymbolicLinkReparseBuffer.PathBuffer),
                        link.SubstituteNameOffset, link.SubstituteNameLength);
  } else if (data->ReparseTag == IO_REPARSE_TAG_MOUNT_POINT &&
             size >= FIELD_OFFSET(REPARSE_DATA_BUFFER, MountPointReparseBuffer.PathBuffer)) {
    const auto& link = data->MountPointReparseBuffer;
    target = targetName(bytes, size,
                        FIELD_OFFSET(REPARSE_DATA_BUFFER, MountPointReparseBuffer.PathBuffer),
                        link.SubstituteNameOffset, link.SubstituteNameLength);
  } else {
    throw Error{STATUS_NOT_SUPPORTED};
  }

  if (!relative && target.rfind(L"\\??\\UNC\\", 0) == 0) {
    target = L"\\\\" + target.substr(8);
  } else if (!relative && target.rfind(L"\\??\\", 0) == 0) {
    target = target.substr(4);
  }
  if (relative && (fs::path(target).has_root_path() || target.find(L':') != std::wstring::npos)) {
    throw Error{STATUS_IO_REPARSE_DATA_INVALID};
  }
  fs::path resolved =
      (relative ? origin.parent_path() / target : fs::path(target)).lexically_normal();
  auto within = fs::path(fold(resolved.wstring()))
                    .lexically_relative(fs::path(fold(root.lexically_normal().wstring())));
  if (within.empty() || within.is_absolute() || *within.begin() == L"..") {
    throw Error{STATUS_ACCESS_DENIED};
  }
  std::wstring substitute = target;
  if (!relative) {
    // Use the source spelling of the suffix; comparison above is
    // case-insensitive.
    auto base = root.lexically_normal().wstring();
    while (!base.empty() && base.back() == L'\\') {
      base.pop_back();
    }
    auto suffix = resolved.wstring().substr(base.size());
    while (!suffix.empty() && suffix.front() == L'\\') {
      suffix.erase(0, 1);
    }
    auto mapped = (targetRoot / suffix).wstring();
    substitute = L"\\??\\UNC\\" + mapped.substr(2);
  }
  // Windows mount-point reparses cannot target a UNC volume. Directory symlinks
  // can.
  const size_t header = FIELD_OFFSET(REPARSE_DATA_BUFFER, SymbolicLinkReparseBuffer.PathBuffer);
  size_t targetBytes = substitute.size() * sizeof(wchar_t);
  size_t stride = targetBytes + sizeof(wchar_t);
  if (header + 2 * stride > MAXIMUM_REPARSE_DATA_BUFFER_SIZE) {
    throw Error{STATUS_NAME_TOO_LONG};
  }
  std::vector<BYTE> result(header + 2 * stride);
  auto output = reinterpret_cast<REPARSE_DATA_BUFFER*>(result.data());
  output->ReparseTag = IO_REPARSE_TAG_SYMLINK;
  output->ReparseDataLength = static_cast<USHORT>(result.size() - REPARSE_DATA_BUFFER_HEADER_SIZE);
  output->SymbolicLinkReparseBuffer.Flags = relative ? SYMLINK_FLAG_RELATIVE : 0;
  output->SymbolicLinkReparseBuffer.SubstituteNameLength = static_cast<USHORT>(targetBytes);
  output->SymbolicLinkReparseBuffer.PrintNameOffset = static_cast<USHORT>(stride);
  output->SymbolicLinkReparseBuffer.PrintNameLength = static_cast<USHORT>(targetBytes);
  memcpy(result.data() + header, substitute.data(), targetBytes);
  memcpy(result.data() + header + stride, substitute.data(), targetBytes);
  return result;
}

std::vector<BYTE> lowerReparse(HANDLE handle, const fs::path& origin, const fs::path& root,
                               const fs::path& targetRoot) {
  std::vector<BYTE> bytes(MAXIMUM_REPARSE_DATA_BUFFER_SIZE);
  DWORD returned = 0;
  require(DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, nullptr, 0, bytes.data(),
                          static_cast<DWORD>(bytes.size()), &returned, nullptr));
  return internalReparse(bytes.data(), returned, origin, root, targetRoot);
}
}  // namespace overlay
