// Local overlay 发布 PoC 的 Windows 文件副作用，供发布会话及保留的独立验证短命令使用。
// 1. checkedPath/pinParents 拒绝设备、管理目录与重解析路径，持有祖先句柄防止普通路径替换。
// 2. file/hash/security 对普通单链接有界文件校验 SHA-256 与 owner/group/DACL；不读取 SACL。
// 3. publishReplace 给同目录候选应用原安全描述符，以 ReplaceFileW 保留原文备份并复核新结果。
// 4. publishCleanup 在完整发布已确认后，按身份/内容打开自己的备份并用句柄删除。
// 5. publishCreate 不覆盖同名文件；publishDelete 核对内容后按已打开句柄删除。
// 所有 hash 使用系统 BCrypt；不写文件正文到日志，不申请额外权限，不吞掉元数据合并失败。
// ReplaceFileW 可能部分失败，调用方必须先保存 intent 并将无成功收据视为未知；不宣称外部 rename CAS。
#include "publish.hpp"
#include "store.hpp"

#include <bcrypt.h>
#include <sddl.h>

namespace overlay {
// Fixed diagnostic stages for this single-operation helper, never file paths.
static unsigned stage = 0;
unsigned publishStage() {
  return stage;
}
static fs::path checkedPath(const std::wstring& input) {
  fs::path path(input);
  auto drive = path.root_name().wstring();
  if (!path.is_absolute() || drive.size() != 2 || drive[1] != L':' ||
      !((drive[0] >= L'A' && drive[0] <= L'Z') || (drive[0] >= L'a' && drive[0] <= L'z'))) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  for (const auto& part : path.relative_path()) {
    auto name = part.wstring();
    if (name.empty() || name == L"." || name == L".." || name.back() == L'.' ||
        name.back() == L' ' || name.find_first_of(L":*?<>|\"") != std::wstring::npos ||
        fold(name) == L".GIT" || fold(name) == L".HG" || fold(name) == L".SVN") {
      throw Error{STATUS_OBJECT_NAME_INVALID};
    }
  }
  return path;
}

static std::wstring extended(const fs::path& path) {
  return L"\\\\?\\" + path.wstring();
}

static BY_HANDLE_FILE_INFORMATION information(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION info{};
  require(GetFileInformationByHandle(handle, &info));
  if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  return info;
}

static std::vector<Handle> pinParents(const fs::path& path) {
  std::vector<Handle> result;
  auto directory = path.root_path();
  auto pin = [&]() {
    Handle handle(CreateFileW(extended(directory).c_str(), FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                              FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(handle.value != INVALID_HANDLE_VALUE);
    if (!(information(handle.value).dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
      throw Error{STATUS_NOT_A_DIRECTORY};
    }
    result.push_back(std::move(handle));
  };
  pin();
  for (const auto& part : path.parent_path().relative_path()) {
    directory /= part;
    pin();
  }
  return result;
}

static Handle file(const fs::path& path, DWORD access, DWORD sharing) {
  Handle handle(CreateFileW(extended(path).c_str(), access, sharing, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(handle.value != INVALID_HANDLE_VALUE);
  auto info = information(handle.value);
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_ENCRYPTED)) ||
      info.nNumberOfLinks != 1 || info.nFileSizeHigh != 0 || info.nFileSizeLow > 2 * 1024 * 1024) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  return handle;
}

static std::wstring identity(HANDLE handle) {
  auto info = information(handle);
  return std::to_wstring(info.dwVolumeSerialNumber) + L":" +
         std::to_wstring((static_cast<UINT64>(info.nFileIndexHigh) << 32) | info.nFileIndexLow);
}

static std::wstring hash(HANDLE handle) {
  LARGE_INTEGER start{};
  require(SetFilePointerEx(handle, start, nullptr, FILE_BEGIN));
  auto info = information(handle);
  std::vector<BYTE> bytes(info.nFileSizeLow);
  DWORD count = 0;
  require(ReadFile(handle, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr));
  if (count != bytes.size()) {
    throw Error{STATUS_FILE_INVALID};
  }
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  checked(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0));
  BYTE digest[32];
  auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), count, digest, sizeof(digest));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  checked(status);
  constexpr wchar_t digits[] = L"0123456789abcdef";
  std::wstring result;
  for (auto byte : digest) {
    result += digits[byte >> 4];
    result += digits[byte & 15];
  }
  return result;
}

static std::vector<BYTE> security(HANDLE handle) {
  constexpr DWORD fields =
      OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  DWORD size = 0;
  GetKernelObjectSecurity(handle, fields, nullptr, 0, &size);
  if (!size || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    throw Error{STATUS_ACCESS_DENIED};
  }
  std::vector<BYTE> result(size);
  require(GetKernelObjectSecurity(handle, fields, result.data(), size, &size));
  return result;
}

static std::wstring securityText(const std::vector<BYTE>& security) {
  wchar_t* text = nullptr;
  require(ConvertSecurityDescriptorToStringSecurityDescriptorW(
      const_cast<BYTE*>(security.data()), SDDL_REVISION_1,
      OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &text, nullptr));
  std::wstring result(text);
  LocalFree(text);
  return result;
}

static DWORD ownershipChanges(std::vector<BYTE>& expected, std::vector<BYTE>& current) {
  PSID expectedOwner = nullptr;
  PSID currentOwner = nullptr;
  PSID expectedGroup = nullptr;
  PSID currentGroup = nullptr;
  BOOL defaulted = FALSE;
  require(GetSecurityDescriptorOwner(expected.data(), &expectedOwner, &defaulted));
  require(GetSecurityDescriptorOwner(current.data(), &currentOwner, &defaulted));
  require(GetSecurityDescriptorGroup(expected.data(), &expectedGroup, &defaulted));
  require(GetSecurityDescriptorGroup(current.data(), &currentGroup, &defaulted));
  auto same = [](PSID left, PSID right) {
    return left == nullptr ? right == nullptr : right != nullptr && EqualSid(left, right);
  };
  DWORD fields = 0;
  if (!same(expectedOwner, currentOwner)) {
    fields |= OWNER_SECURITY_INFORMATION;
  }
  if (!same(expectedGroup, currentGroup)) {
    fields |= GROUP_SECURITY_INFORMATION;
  }
  return fields;
}

static void applySecurity(HANDLE handle, std::vector<BYTE>& descriptor, DWORD ownership) {
  SECURITY_DESCRIPTOR_CONTROL control{};
  DWORD revision = 0;
  require(GetSecurityDescriptorControl(descriptor.data(), &control, &revision));
  DWORD fields = ownership | DACL_SECURITY_INFORMATION;
  fields |= (control & SE_DACL_PROTECTED) ? PROTECTED_DACL_SECURITY_INFORMATION
                                        : UNPROTECTED_DACL_SECURITY_INFORMATION;
  PSID owner = nullptr;
  PSID group = nullptr;
  PACL dacl = nullptr;
  BOOL present = FALSE;
  BOOL defaulted = FALSE;
  require(GetSecurityDescriptorOwner(descriptor.data(), &owner, &defaulted));
  require(GetSecurityDescriptorGroup(descriptor.data(), &group, &defaulted));
  require(GetSecurityDescriptorDacl(descriptor.data(), &present, &dacl, &defaulted));
  if (!present) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  // SetSecurityInfo maintains filesystem inheritance bookkeeping. The generic
  // SetKernelObjectSecurity path drops AUTO_INHERITED on this NTFS fixture.
  auto status = SetSecurityInfo(handle, SE_FILE_OBJECT, fields,
      (ownership & OWNER_SECURITY_INFORMATION) ? owner : nullptr,
      (ownership & GROUP_SECURITY_INFORMATION) ? group : nullptr, dacl, nullptr);
  checked(FspNtStatusFromWin32(status));
}

static void requireHash(const std::wstring& value) {
  if (value.size() != 64 || value.find_first_not_of(L"0123456789abcdef") != std::wstring::npos) {
    throw Error{STATUS_INVALID_PARAMETER};
  }
}

std::wstring publishReplace(const std::wstring& targetName, const std::wstring& temporaryName,
                            const std::wstring& beforeHash, const std::wstring& afterHash) {
  stage = 1;
  requireHash(beforeHash);
  requireHash(afterHash);
  auto target = checkedPath(targetName);
  auto temporary = checkedPath(temporaryName);
  if (fold(target.parent_path().wstring()) != fold(temporary.parent_path().wstring()) ||
      fold(temporary.filename().wstring()).rfind(L".CODEATELIER-PUBLISH-", 0) != 0 ||
      fold(target.filename().wstring()).rfind(L".CODEATELIER-PUBLISH-", 0) == 0) {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  stage = 2;
  auto parents = pinParents(target);
  stage = 3;
  auto original = file(target, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_DELETE);
  if (hash(original.value) != beforeHash) {
    throw Error{STATUS_FILE_INVALID};
  }
  auto descriptor = security(original.value);
  auto expectedSecurity = securityText(descriptor);
  stage = 4;
  auto candidate = file(temporary, GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC,
                         FILE_SHARE_READ);
  auto currentSecurity = security(candidate.value);
  auto ownership = ownershipChanges(descriptor, currentSecurity);
  stage = 5;
  applySecurity(candidate.value, descriptor, 0);
  if (ownership) {
    // Self-owned source and candidate normally already share ownership. Do not
    // demand WRITE_OWNER just to assign those same SIDs again. A real ownership
    // difference still requires the ordinary OS right. Apply exactly the source
    // DACL first; do not invent an extra WRITE_OWNER grant for the publisher.
    auto candidateIdentity = identity(candidate.value);
    candidate = Handle();
    stage = 4;
    candidate = file(temporary, GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER,
                       FILE_SHARE_READ);
    if (identity(candidate.value) != candidateIdentity) {
      throw Error{STATUS_FILE_INVALID};
    }
    currentSecurity = security(candidate.value);
    ownership = ownershipChanges(descriptor, currentSecurity);
  }
  if (hash(candidate.value) != afterHash) {
    throw Error{STATUS_FILE_INVALID};
  }
  if (ownership) {
    stage = 5;
    applySecurity(candidate.value, descriptor, ownership);
  }
  stage = 6;
  if (securityText(security(candidate.value)) != expectedSecurity) {
    throw Error{STATUS_ACCESS_DENIED};
  }
  require(FlushFileBuffers(candidate.value));
  candidate = Handle();
  auto backup = fs::path(temporary.wstring() + L".backup");
  auto attributes = GetFileAttributesW(extended(backup).c_str());
  if (attributes != INVALID_FILE_ATTRIBUTES || GetLastError() != ERROR_FILE_NOT_FOUND) {
    throw Error{STATUS_OBJECT_NAME_COLLISION};
  }
  if (securityText(security(original.value)) != expectedSecurity) {
    throw Error{STATUS_FILE_INVALID};
  }
  // No IGNORE_* flags: lack of permission or metadata merge failures cannot
  // silently turn a source ACL into the temporary file's inherited permissions.
  stage = 7;
  require(ReplaceFileW(extended(target).c_str(), extended(temporary).c_str(),
                       extended(backup).c_str(), 0, nullptr, nullptr));
  stage = 8;
  auto saved = file(backup, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_DELETE);
  if (identity(saved.value) != identity(original.value) || hash(saved.value) != beforeHash ||
      securityText(security(saved.value)) != expectedSecurity) {
    // A non-cooperating rename may have changed the path after our original
    // handle was opened. Preserve the actual backup and report unknown rather
    // than acknowledging that a different source file was safely replaced.
    throw Error{STATUS_FILE_INVALID};
  }
  auto published = file(target, GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                         FILE_SHARE_READ | FILE_SHARE_DELETE);
  require(FlushFileBuffers(published.value));
  if (hash(published.value) != afterHash || securityText(security(published.value)) != expectedSecurity) {
    throw Error{STATUS_FILE_INVALID};
  }
  return identity(original.value);
}

void publishCleanup(const std::wstring& backupName, const std::wstring& expectedIdentity,
                    const std::wstring& expectedHash) {
  stage = 9;
  requireHash(expectedHash);
  auto backup = checkedPath(backupName);
  if (fold(backup.filename().wstring()).rfind(L".CODEATELIER-PUBLISH-", 0) != 0 ||
      fold(backup.extension().wstring()) != L".BACKUP") {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  auto parents = pinParents(backup);
  auto handle = file(backup, GENERIC_READ | DELETE, FILE_SHARE_READ);
  if (identity(handle.value) != expectedIdentity || hash(handle.value) != expectedHash) {
    throw Error{STATUS_FILE_INVALID};
  }
  FILE_DISPOSITION_INFO disposition{TRUE};
  require(SetFileInformationByHandle(handle.value, FileDispositionInfo, &disposition,
                                     sizeof(disposition)));
}
void publishCreate(const std::wstring& targetName, const std::wstring& temporaryName,
                   const std::wstring& afterHash) {
  stage = 1;
  requireHash(afterHash);
  auto target = checkedPath(targetName);
  auto temporary = checkedPath(temporaryName);
  if (fold(target.parent_path().wstring()) != fold(temporary.parent_path().wstring()) ||
      fold(temporary.filename().wstring()).rfind(L".CODEATELIER-PUBLISH-", 0) != 0 ||
      fold(target.filename().wstring()).rfind(L".CODEATELIER-PUBLISH-", 0) == 0) {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  auto parents = pinParents(target);
  auto candidate = file(temporary, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE);
  if (hash(candidate.value) != afterHash) {
    throw Error{STATUS_FILE_INVALID};
  }
  auto expected = identity(candidate.value);
  // No REPLACE_EXISTING: a competing creation must never be overwritten.
  require(MoveFileExW(extended(temporary).c_str(), extended(target).c_str(), MOVEFILE_WRITE_THROUGH));
  auto result = file(target, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE);
  if (identity(result.value) != expected || hash(result.value) != afterHash) {
    throw Error{STATUS_FILE_INVALID};
  }
}

void publishDelete(const std::wstring& targetName, const std::wstring& beforeHash) {
  stage = 1;
  requireHash(beforeHash);
  auto target = checkedPath(targetName);
  auto parents = pinParents(target);
  auto original = file(target, GENERIC_READ | DELETE, FILE_SHARE_READ);
  if (hash(original.value) != beforeHash) {
    throw Error{STATUS_FILE_INVALID};
  }
  FILE_DISPOSITION_INFO disposition{TRUE};
  require(SetFileInformationByHandle(original.value, FileDispositionInfo, &disposition,
                                     sizeof(disposition)));
}
}  // namespace overlay
