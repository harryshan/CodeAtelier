// Native regression tests for reparse containment; built only with -VerifyReparse.
// 1. Construct raw relative link data without requiring SeCreateSymbolicLinkPrivilege.
// 2. Call the production parser at the original and moved virtual locations.
// 3. Check external targets, malformed buffers and absolute root remapping.
// No mount or file mutation occurs; this does not replace real I/O verification.
#include <cstring>
#include <iostream>

#include "store.hpp"

using namespace overlay;

static std::vector<BYTE> symlinkData(const std::wstring& target, bool relative) {
  const size_t header = FIELD_OFFSET(REPARSE_DATA_BUFFER, SymbolicLinkReparseBuffer.PathBuffer);
  std::vector<BYTE> bytes(header + target.size() * sizeof(wchar_t));
  auto data = reinterpret_cast<REPARSE_DATA_BUFFER*>(bytes.data());
  data->ReparseTag = IO_REPARSE_TAG_SYMLINK;
  data->ReparseDataLength = static_cast<USHORT>(bytes.size() - REPARSE_DATA_BUFFER_HEADER_SIZE);
  data->SymbolicLinkReparseBuffer.Flags = relative ? SYMLINK_FLAG_RELATIVE : 0;
  data->SymbolicLinkReparseBuffer.SubstituteNameLength =
      static_cast<USHORT>(target.size() * sizeof(wchar_t));
  memcpy(bytes.data() + header, target.data(), target.size() * sizeof(wchar_t));
  return bytes;
}

static void expectDenied(const std::vector<BYTE>& bytes, const fs::path& origin,
                         const fs::path& root, NTSTATUS expected) {
  try {
    internalReparse(bytes.data(), bytes.size(), origin, root, root);
  } catch (const Error& error) {
    if (error.status == expected) {
      return;
    }
    throw;
  }
  throw std::runtime_error("unsafe reparse accepted");
}

int main() {
  try {
    const fs::path root = L"\\\\CodeAtelier\\test\\";
    auto relative = symlinkData(L"..\\..\\tracked.txt", true);
    internalReparse(relative.data(), relative.size(), root / L"links\\deep\\item", root, root);
    expectDenied(relative, root / L"moved\\item", root, STATUS_ACCESS_DENIED);
    expectDenied(symlinkData(L"C:\\outside", false), root / L"item", root, STATUS_ACCESS_DENIED);
    expectDenied(symlinkData(L"C:\\outside", true), root / L"item", root,
                 STATUS_IO_REPARSE_DATA_INVALID);
    expectDenied(std::vector<BYTE>(2), root / L"item", root, STATUS_IO_REPARSE_DATA_INVALID);
    auto absolute = symlinkData(L"\\??\\C:\\source", false);
    auto mapped = internalReparse(absolute.data(), absolute.size(), L"C:\\source\\item",
                                  L"c:\\source\\", root);
    internalReparse(mapped.data(), mapped.size(), root / L"item", root, root);
    std::cout << "OVERLAY_REPARSE PASS\n";
    return 0;
  } catch (...) {
    std::cerr << "OVERLAY_REPARSE FAIL\n";
    return 1;
  }
}
