/*
 * 本文件是 CodeAtelier Windows restricted-token 设计的最小原生可行性探针，不接入产品运行时。
 * PowerShell 夹具编译并调用 launcher 模式；launcher 为临时可写根安装一次性 capability SID ACE，
 * 从当前进程 token 创建 WRITE_RESTRICTED primary token，再把 probe 模式放入新 Job 后启动。
 *
 * 代码结构按执行顺序组织：
 * 1. Win32 错误、handle/SID 生命周期和命令行转义辅助函数。
 * 2. token/Job/用户与 logon SID 诊断，明确显示调用者是否已被 Codex 或其它宿主限制。
 * 3. execution/root capability SID、临时目录 ACL、restricted token 与 Job 的创建函数；
 *    token default DACL 只组合普通账户 SID 和本实例 execution SID，不依赖 logon SID 唯一。
 * 4. probe 与 nested-probe 验证工作区外读取、指定根写入、外部写拒绝和后代继承；
 *    concurrent-probe 用文件屏障保持两个实例同时存活，并攻击 peer process/thread/named Job。
 * 5. launcher 从创建时为 process/thread/Job 安装 account+execution 私有 DACL；专用账户模式
 *    接受由高权限编排端预置的 execution/root SID，
 *    不允许专用账户 bootstrap 修改目录 ACL；wmain 只负责模式分派和稳定退出码。
 *
 * 该程序只修改夹具传入的临时可写根 DACL，目录随后由夹具整体删除。它不安装 WFP、Broker、
 * 私有 desktop 或持久 supervisor，因而不能证明完整 W1--W2，更不能证明 W3--W6。
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <objbase.h>
#include <sddl.h>

#include <array>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr DWORD kRestrictedTokenFlags =
    DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;

class UniqueHandle {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE value) : value_(value) {}

  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;

  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.release()) {}

  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) {
      reset(other.release());
    }
    return *this;
  }

  ~UniqueHandle() { reset(); }

  HANDLE get() const { return value_; }
  explicit operator bool() const {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }

  HANDLE release() {
    HANDLE value = value_;
    value_ = nullptr;
    return value;
  }

  void reset(HANDLE value = nullptr) {
    if (*this) {
      CloseHandle(value_);
    }
    value_ = value;
  }

 private:
  HANDLE value_ = nullptr;
};

struct LocalFreeDeleter {
  void operator()(void* value) const {
    if (value != nullptr) {
      LocalFree(value);
    }
  }
};

struct SidDeleter {
  void operator()(void* value) const {
    if (value != nullptr) {
      FreeSid(value);
    }
  }
};

using LocalPointer = std::unique_ptr<void, LocalFreeDeleter>;
using SidPointer = std::unique_ptr<void, SidDeleter>;

void PrintFailure(const std::wstring& operation, DWORD error);
bool QueryCurrentToken(UniqueHandle* token);

class PrivateObjectSecurity {
 public:
  bool Initialize(PSID execution_sid) {
    UniqueHandle token;
    if (!QueryCurrentToken(&token)) {
      return false;
    }

    DWORD user_size = 0;
    GetTokenInformation(token.get(), TokenUser, nullptr, 0, &user_size);
    if (user_size == 0) {
      PrintFailure(L"GetTokenInformation(private TokenUser size)",
                   GetLastError());
      return false;
    }
    user_buffer_.resize(user_size);
    if (!GetTokenInformation(token.get(), TokenUser, user_buffer_.data(),
                             user_size, &user_size)) {
      PrintFailure(L"GetTokenInformation(private TokenUser)", GetLastError());
      return false;
    }
    auto* token_user = reinterpret_cast<TOKEN_USER*>(user_buffer_.data());

    DWORD system_sid_size = SECURITY_MAX_SID_SIZE;
    system_sid_.resize(system_sid_size);
    if (!CreateWellKnownSid(WinLocalSystemSid, nullptr, system_sid_.data(),
                            &system_sid_size)) {
      PrintFailure(L"CreateWellKnownSid(LocalSystem)", GetLastError());
      return false;
    }

    std::array<EXPLICIT_ACCESSW, 3> entries{};
    std::array<PSID, 3> sids = {
        token_user->User.Sid,
        execution_sid,
        static_cast<PSID>(system_sid_.data()),
    };
    for (size_t index = 0; index < entries.size(); ++index) {
      entries[index].grfAccessPermissions = GENERIC_ALL;
      entries[index].grfAccessMode = GRANT_ACCESS;
      entries[index].grfInheritance = NO_INHERITANCE;
      entries[index].Trustee.TrusteeForm = TRUSTEE_IS_SID;
      entries[index].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
      entries[index].Trustee.ptstrName = static_cast<LPWSTR>(sids[index]);
    }

    PACL raw_acl = nullptr;
    DWORD result = SetEntriesInAclW(static_cast<ULONG>(entries.size()),
                                    entries.data(), nullptr, &raw_acl);
    if (result != ERROR_SUCCESS) {
      PrintFailure(L"SetEntriesInAcl(private object)", result);
      return false;
    }
    acl_.reset(raw_acl);

    if (!InitializeSecurityDescriptor(&descriptor_,
                                      SECURITY_DESCRIPTOR_REVISION)) {
      PrintFailure(L"InitializeSecurityDescriptor(private object)",
                   GetLastError());
      return false;
    }
    if (!SetSecurityDescriptorDacl(&descriptor_, TRUE,
                                   static_cast<PACL>(acl_.get()), FALSE)) {
      PrintFailure(L"SetSecurityDescriptorDacl(private object)",
                   GetLastError());
      return false;
    }

    attributes_.nLength = sizeof(attributes_);
    attributes_.lpSecurityDescriptor = &descriptor_;
    attributes_.bInheritHandle = FALSE;
    return true;
  }

  SECURITY_ATTRIBUTES* attributes() { return &attributes_; }

 private:
  std::vector<BYTE> user_buffer_;
  std::vector<BYTE> system_sid_;
  LocalPointer acl_;
  SECURITY_DESCRIPTOR descriptor_{};
  SECURITY_ATTRIBUTES attributes_{};
};

std::wstring FormatWindowsError(DWORD error) {
  if (error == ERROR_SUCCESS) {
    return L"API returned failure without a Win32 last-error value (0)";
  }

  wchar_t* message = nullptr;
  DWORD length = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, error, 0, reinterpret_cast<wchar_t*>(&message), 0, nullptr);
  LocalPointer owned_message(message);

  if (length == 0 || message == nullptr) {
    return L"Win32 error " + std::to_wstring(error);
  }

  std::wstring result(message, length);
  while (!result.empty() &&
         (result.back() == L'\r' || result.back() == L'\n')) {
    result.pop_back();
  }
  return result + L" (" + std::to_wstring(error) + L")";
}

void PrintFailure(const std::wstring& operation, DWORD error) {
  std::wcerr << L"FAIL " << operation << L" code=" << error
             << L" detail=" << FormatWindowsError(error) << L"\n";
}

std::wstring QuoteArgument(const std::wstring& argument) {
  if (argument.find_first_of(L" \t\"") == std::wstring::npos) {
    return argument;
  }

  std::wstring quoted = L"\"";
  size_t backslashes = 0;
  for (wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }

    if (character == L'\"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(character);
      backslashes = 0;
      continue;
    }

    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(character);
  }

  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

std::wstring CurrentExecutablePath() {
  std::vector<wchar_t> buffer(32768);
  DWORD length = GetModuleFileNameW(nullptr, buffer.data(),
                                    static_cast<DWORD>(buffer.size()));
  if (length == 0 || length == buffer.size()) {
    return L"";
  }
  return std::wstring(buffer.data(), length);
}

bool QueryCurrentToken(UniqueHandle* token) {
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) {
    PrintFailure(L"OpenProcessToken(current)", GetLastError());
    return false;
  }
  token->reset(raw_token);
  return true;
}

std::wstring SidToString(PSID sid);

std::wstring QueryIntegrityLevel(HANDLE token) {
  DWORD required = 0;
  GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &required);
  if (required == 0) {
    return L"unknown";
  }

  std::vector<BYTE> buffer(required);
  if (!GetTokenInformation(token, TokenIntegrityLevel, buffer.data(),
                           required, &required)) {
    return L"unknown";
  }

  auto* label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(buffer.data());
  DWORD rid = *GetSidSubAuthority(
      label->Label.Sid,
      static_cast<DWORD>(*GetSidSubAuthorityCount(label->Label.Sid) - 1));
  if (rid >= SECURITY_MANDATORY_SYSTEM_RID) {
    return L"system";
  }
  if (rid >= SECURITY_MANDATORY_HIGH_RID) {
    return L"high";
  }
  if (rid >= SECURITY_MANDATORY_MEDIUM_RID) {
    return L"medium";
  }
  if (rid >= SECURITY_MANDATORY_LOW_RID) {
    return L"low";
  }
  return L"untrusted";
}

DWORD QueryRestrictedSidCount(HANDLE token) {
  DWORD required = 0;
  GetTokenInformation(token, TokenRestrictedSids, nullptr, 0, &required);
  if (required == 0) {
    return 0;
  }

  std::vector<BYTE> buffer(required);
  if (!GetTokenInformation(token, TokenRestrictedSids, buffer.data(), required,
                           &required)) {
    return 0;
  }

  auto* groups = reinterpret_cast<TOKEN_GROUPS*>(buffer.data());
  return groups->GroupCount;
}

std::wstring QueryTokenUserSid(HANDLE token) {
  DWORD required = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &required);
  if (required == 0) {
    return L"unavailable";
  }

  std::vector<BYTE> buffer(required);
  if (!GetTokenInformation(token, TokenUser, buffer.data(), required,
                           &required)) {
    return L"unavailable";
  }

  auto* user = reinterpret_cast<TOKEN_USER*>(buffer.data());
  return SidToString(user->User.Sid);
}

std::wstring QueryTokenLogonSid(HANDLE token) {
  DWORD required = 0;
  GetTokenInformation(token, TokenGroups, nullptr, 0, &required);
  if (required == 0) {
    return L"unavailable";
  }

  std::vector<BYTE> buffer(required);
  if (!GetTokenInformation(token, TokenGroups, buffer.data(), required,
                           &required)) {
    return L"unavailable";
  }

  auto* groups = reinterpret_cast<TOKEN_GROUPS*>(buffer.data());
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    if ((groups->Groups[index].Attributes & SE_GROUP_LOGON_ID) ==
        SE_GROUP_LOGON_ID) {
      return SidToString(groups->Groups[index].Sid);
    }
  }
  return L"unavailable";
}

void PrintProcessContext(const std::wstring& label) {
  UniqueHandle token;
  if (!QueryCurrentToken(&token)) {
    return;
  }

  BOOL in_job = FALSE;
  if (!IsProcessInJob(GetCurrentProcess(), nullptr, &in_job)) {
    PrintFailure(L"IsProcessInJob", GetLastError());
    return;
  }

  DWORD app_container = 0;
  DWORD returned = 0;
  if (!GetTokenInformation(token.get(), TokenIsAppContainer, &app_container,
                           sizeof(app_container), &returned)) {
    app_container = 0;
  }

  std::wcout << L"CONTEXT " << label << L" pid=" << GetCurrentProcessId()
             << L" userSid=" << QueryTokenUserSid(token.get())
             << L" logonSid=" << QueryTokenLogonSid(token.get())
             << L" restricted="
             << (IsTokenRestricted(token.get()) ? L"yes" : L"no")
             << L" restrictedSidCount="
             << QueryRestrictedSidCount(token.get()) << L" appContainer="
             << (app_container != 0 ? L"yes" : L"no") << L" integrity="
             << QueryIntegrityLevel(token.get()) << L" inJob="
             << (in_job ? L"yes" : L"no") << L"\n";
}

SidPointer CreateCapabilitySid() {
  GUID guid{};
  HRESULT result = CoCreateGuid(&guid);
  if (FAILED(result)) {
    std::wcerr << L"FAIL CoCreateGuid: HRESULT " << std::hex << result
               << std::dec << L"\n";
    return SidPointer();
  }

  DWORD component_two =
      (static_cast<DWORD>(guid.Data2) << 16) | guid.Data3;
  DWORD component_three =
      (static_cast<DWORD>(guid.Data4[0]) << 24) |
      (static_cast<DWORD>(guid.Data4[1]) << 16) |
      (static_cast<DWORD>(guid.Data4[2]) << 8) | guid.Data4[3];
  DWORD component_four =
      (static_cast<DWORD>(guid.Data4[4]) << 24) |
      (static_cast<DWORD>(guid.Data4[5]) << 16) |
      (static_cast<DWORD>(guid.Data4[6]) << 8) | guid.Data4[7];

  SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
  PSID raw_sid = nullptr;
  if (!AllocateAndInitializeSid(
          &authority, 5, SECURITY_NT_NON_UNIQUE, guid.Data1, component_two,
          component_three, component_four, 0, 0, 0, &raw_sid)) {
    PrintFailure(L"AllocateAndInitializeSid", GetLastError());
    return SidPointer();
  }
  return SidPointer(raw_sid);
}

std::wstring SidToString(PSID sid) {
  wchar_t* raw_string = nullptr;
  if (!ConvertSidToStringSidW(sid, &raw_string)) {
    return L"unavailable";
  }
  LocalPointer owned_string(raw_string);
  return raw_string;
}

bool GrantCapabilityToDirectory(const std::wstring& directory, PSID sid) {
  PACL old_acl = nullptr;
  PSECURITY_DESCRIPTOR security_descriptor = nullptr;
  DWORD result = GetNamedSecurityInfoW(
      directory.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
      nullptr, &old_acl, nullptr, &security_descriptor);
  LocalPointer owned_descriptor(security_descriptor);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"GetNamedSecurityInfo(write root)", result);
    return false;
  }

  EXPLICIT_ACCESSW access{};
  access.grfAccessPermissions = FILE_ALL_ACCESS;
  access.grfAccessMode = GRANT_ACCESS;
  access.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  access.Trustee.ptstrName = static_cast<LPWSTR>(sid);

  PACL new_acl = nullptr;
  result = SetEntriesInAclW(1, &access, old_acl, &new_acl);
  LocalPointer owned_acl(new_acl);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"SetEntriesInAcl(write root)", result);
    return false;
  }

  result = SetNamedSecurityInfoW(
      const_cast<LPWSTR>(directory.c_str()), SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION, nullptr, nullptr, new_acl, nullptr);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"SetNamedSecurityInfo(write root)", result);
    return false;
  }
  return true;
}

bool CreateRestrictedPrimaryToken(PSID execution_sid, PSID root_capability_sid,
                                  UniqueHandle* restricted_token) {
  UniqueHandle current_token;
  HANDLE raw_current_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(),
                        TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY |
                            TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_PRIVILEGES |
                            TOKEN_ADJUST_SESSIONID,
                        &raw_current_token)) {
    PrintFailure(L"OpenProcessToken(launcher)", GetLastError());
    return false;
  }
  current_token.reset(raw_current_token);

  DWORD groups_size = 0;
  GetTokenInformation(current_token.get(), TokenGroups, nullptr, 0,
                      &groups_size);
  if (groups_size == 0) {
    PrintFailure(L"GetTokenInformation(TokenGroups size)", GetLastError());
    return false;
  }
  std::vector<BYTE> groups_buffer(groups_size);
  if (!GetTokenInformation(current_token.get(), TokenGroups,
                           groups_buffer.data(), groups_size, &groups_size)) {
    PrintFailure(L"GetTokenInformation(TokenGroups)", GetLastError());
    return false;
  }

  auto* groups = reinterpret_cast<TOKEN_GROUPS*>(groups_buffer.data());
  PSID source_logon_sid = nullptr;
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    if ((groups->Groups[index].Attributes & SE_GROUP_LOGON_ID) ==
        SE_GROUP_LOGON_ID) {
      source_logon_sid = groups->Groups[index].Sid;
      break;
    }
  }
  if (source_logon_sid == nullptr) {
    std::wcerr << L"FAIL current token has no logon SID\n";
    return false;
  }

  DWORD logon_sid_size = GetLengthSid(source_logon_sid);
  std::vector<BYTE> logon_sid(logon_sid_size);
  if (!CopySid(logon_sid_size, logon_sid.data(), source_logon_sid)) {
    PrintFailure(L"CopySid(logon SID)", GetLastError());
    return false;
  }

  DWORD user_size = 0;
  GetTokenInformation(current_token.get(), TokenUser, nullptr, 0, &user_size);
  if (user_size == 0) {
    PrintFailure(L"GetTokenInformation(TokenUser size)", GetLastError());
    return false;
  }
  std::vector<BYTE> user_buffer(user_size);
  if (!GetTokenInformation(current_token.get(), TokenUser, user_buffer.data(),
                           user_size, &user_size)) {
    PrintFailure(L"GetTokenInformation(TokenUser)", GetLastError());
    return false;
  }
  auto* token_user = reinterpret_cast<TOKEN_USER*>(user_buffer.data());

  DWORD everyone_sid_size = SECURITY_MAX_SID_SIZE;
  std::vector<BYTE> everyone_sid(everyone_sid_size);
  if (!CreateWellKnownSid(WinWorldSid, nullptr, everyone_sid.data(),
                          &everyone_sid_size)) {
    PrintFailure(L"CreateWellKnownSid(Everyone)", GetLastError());
    return false;
  }

  std::array<SID_AND_ATTRIBUTES, 4> restricting_sids{};
  restricting_sids[0].Sid = execution_sid;
  restricting_sids[1].Sid = root_capability_sid;
  restricting_sids[2].Sid = logon_sid.data();
  restricting_sids[3].Sid = everyone_sid.data();

  HANDLE raw_restricted_token = nullptr;
  if (!CreateRestrictedToken(current_token.get(), kRestrictedTokenFlags, 0,
                             nullptr, 0, nullptr,
                             static_cast<DWORD>(restricting_sids.size()),
                             restricting_sids.data(),
                             &raw_restricted_token)) {
    PrintFailure(L"CreateRestrictedToken", GetLastError());
    return false;
  }
  restricted_token->reset(raw_restricted_token);

  std::array<EXPLICIT_ACCESSW, 2> default_dacl_entries{};
  std::array<PSID, 2> default_dacl_sids = {
      token_user->User.Sid,
      execution_sid,
  };
  for (size_t index = 0; index < default_dacl_entries.size(); ++index) {
    default_dacl_entries[index].grfAccessPermissions = GENERIC_ALL;
    default_dacl_entries[index].grfAccessMode = GRANT_ACCESS;
    default_dacl_entries[index].grfInheritance = NO_INHERITANCE;
    default_dacl_entries[index].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    default_dacl_entries[index].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    default_dacl_entries[index].Trustee.ptstrName =
        static_cast<LPWSTR>(default_dacl_sids[index]);
  }

  PACL default_dacl = nullptr;
  DWORD acl_result = SetEntriesInAclW(
      static_cast<ULONG>(default_dacl_entries.size()),
      default_dacl_entries.data(), nullptr, &default_dacl);
  LocalPointer owned_default_dacl(default_dacl);
  if (acl_result != ERROR_SUCCESS) {
    PrintFailure(L"SetEntriesInAcl(token default DACL)", acl_result);
    return false;
  }

  TOKEN_DEFAULT_DACL default_dacl_info{};
  default_dacl_info.DefaultDacl = default_dacl;
  if (!SetTokenInformation(restricted_token->get(), TokenDefaultDacl,
                           &default_dacl_info, sizeof(default_dacl_info))) {
    PrintFailure(L"SetTokenInformation(TokenDefaultDacl)", GetLastError());
    return false;
  }

  LUID change_notify_luid{};
  if (!LookupPrivilegeValueW(nullptr, SE_CHANGE_NOTIFY_NAME,
                             &change_notify_luid)) {
    PrintFailure(L"LookupPrivilegeValue(SeChangeNotifyPrivilege)",
                 GetLastError());
    return false;
  }
  TOKEN_PRIVILEGES privileges{};
  privileges.PrivilegeCount = 1;
  privileges.Privileges[0].Luid = change_notify_luid;
  privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
  SetLastError(ERROR_SUCCESS);
  if (!AdjustTokenPrivileges(restricted_token->get(), FALSE, &privileges, 0,
                             nullptr, nullptr) ||
      GetLastError() == ERROR_NOT_ALL_ASSIGNED) {
    PrintFailure(L"AdjustTokenPrivileges(SeChangeNotifyPrivilege)",
                 GetLastError());
    return false;
  }
  return true;
}

bool ConfigureJob(SECURITY_ATTRIBUTES* security_attributes,
                  const std::wstring& name, UniqueHandle* job) {
  const wchar_t* object_name = name.empty() ? nullptr : name.c_str();
  job->reset(CreateJobObjectW(security_attributes, object_name));
  if (!*job) {
    PrintFailure(L"CreateJobObject", GetLastError());
    return false;
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 4;
  if (!SetInformationJobObject(job->get(), JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    PrintFailure(L"SetInformationJobObject", GetLastError());
    return false;
  }
  return true;
}

struct PeerIdentity {
  DWORD process_id = 0;
  DWORD thread_id = 0;
  std::wstring job_name;
};

bool WriteMarker(const std::filesystem::path& path) {
  std::wofstream stream(path, std::ios::out | std::ios::trunc);
  if (!stream) {
    std::wcerr << L"FAIL create marker path=" << path.wstring() << L"\n";
    return false;
  }
  stream << L"ready\n";
  return stream.good();
}

bool WaitForPath(const std::filesystem::path& path) {
  constexpr auto kTimeout = std::chrono::seconds(20);
  constexpr auto kPollInterval = std::chrono::milliseconds(25);
  auto deadline = std::chrono::steady_clock::now() + kTimeout;
  while (std::chrono::steady_clock::now() < deadline) {
    std::error_code error;
    if (std::filesystem::is_regular_file(path, error) && !error) {
      return true;
    }
    std::this_thread::sleep_for(kPollInterval);
  }
  std::wcerr << L"FAIL wait-for-path timeout path=" << path.wstring()
             << L"\n";
  return false;
}

bool WriteIdentity(const std::filesystem::path& root,
                   const std::wstring& job_name) {
  std::wofstream stream(root / L"instance.txt",
                        std::ios::out | std::ios::trunc);
  if (!stream) {
    std::wcerr << L"FAIL create instance identity\n";
    return false;
  }
  stream << GetCurrentProcessId() << L"\n"
         << GetCurrentThreadId() << L"\n"
         << job_name << L"\n";
  if (!stream.good()) {
    std::wcerr << L"FAIL write instance identity\n";
    return false;
  }
  stream.close();
  return WriteMarker(root / L"instance-ready.txt");
}

bool ReadIdentity(const std::filesystem::path& root, PeerIdentity* identity) {
  if (!WaitForPath(root / L"instance-ready.txt")) {
    return false;
  }

  std::wifstream stream(root / L"instance.txt");
  if (!stream) {
    std::wcerr << L"FAIL open peer instance identity\n";
    return false;
  }
  stream >> identity->process_id;
  stream >> identity->thread_id;
  stream.ignore((std::numeric_limits<std::streamsize>::max)(), L'\n');
  std::getline(stream, identity->job_name);
  if (!stream || identity->process_id == 0 || identity->thread_id == 0 ||
      identity->job_name.empty()) {
    std::wcerr << L"FAIL parse peer instance identity\n";
    return false;
  }
  return true;
}

bool VerifyProcessAccessDenied(DWORD process_id) {
  constexpr std::array<DWORD, 4> kDangerousAccess = {
      PROCESS_TERMINATE,
      PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE,
      PROCESS_DUP_HANDLE,
      WRITE_DAC | WRITE_OWNER,
  };
  for (DWORD access : kDangerousAccess) {
    UniqueHandle process(OpenProcess(access, FALSE, process_id));
    if (process) {
      std::wcerr << L"FAIL dangerous OpenProcess succeeded pid=" << process_id
                 << L" access=" << access << L"\n";
      return false;
    }
    if (GetLastError() != ERROR_ACCESS_DENIED) {
      PrintFailure(L"OpenProcess returned unexpected error", GetLastError());
      return false;
    }
  }
  std::wcout << L"PASS peer-process-dangerous-access-denied count="
             << kDangerousAccess.size() << L"\n";
  return true;
}

bool VerifyThreadAccessDenied(DWORD thread_id) {
  constexpr std::array<DWORD, 3> kDangerousAccess = {
      THREAD_TERMINATE,
      THREAD_SUSPEND_RESUME | THREAD_SET_CONTEXT,
      WRITE_DAC | WRITE_OWNER,
  };
  for (DWORD access : kDangerousAccess) {
    UniqueHandle thread(OpenThread(access, FALSE, thread_id));
    if (thread) {
      std::wcerr << L"FAIL dangerous OpenThread succeeded tid=" << thread_id
                 << L" access=" << access << L"\n";
      return false;
    }
    if (GetLastError() != ERROR_ACCESS_DENIED) {
      PrintFailure(L"OpenThread returned unexpected error", GetLastError());
      return false;
    }
  }
  std::wcout << L"PASS peer-thread-dangerous-access-denied count="
             << kDangerousAccess.size() << L"\n";
  return true;
}

bool VerifyJobAccessDenied(const std::wstring& job_name) {
  UniqueHandle job(OpenJobObjectW(JOB_OBJECT_TERMINATE | JOB_OBJECT_ASSIGN_PROCESS |
                                      WRITE_DAC | WRITE_OWNER,
                                  FALSE, job_name.c_str()));
  if (job) {
    std::wcerr << L"FAIL dangerous OpenJobObject succeeded name=" << job_name
               << L"\n";
    return false;
  }
  if (GetLastError() != ERROR_ACCESS_DENIED) {
    PrintFailure(L"OpenJobObject returned unexpected error", GetLastError());
    return false;
  }
  std::wcout << L"PASS peer-job-dangerous-access-denied\n";
  return true;
}

bool ReadExpectedFile(const std::wstring& path) {
  UniqueHandle file(CreateFileW(path.c_str(), GENERIC_READ,
                                FILE_SHARE_READ | FILE_SHARE_WRITE |
                                    FILE_SHARE_DELETE,
                                nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                                nullptr));
  if (!file) {
    PrintFailure(L"read outside writable root", GetLastError());
    return false;
  }

  char buffer[32]{};
  DWORD bytes_read = 0;
  if (!ReadFile(file.get(), buffer, sizeof(buffer), &bytes_read, nullptr) ||
      bytes_read == 0) {
    PrintFailure(L"ReadFile(outside readable file)", GetLastError());
    return false;
  }

  std::wcout << L"PASS read-current-user-file path=" << path << L"\n";
  return true;
}

bool WriteExpectedFile(const std::wstring& path) {
  UniqueHandle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                                CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!file) {
    PrintFailure(L"write allowed root", GetLastError());
    return false;
  }

  constexpr char payload[] = "sandbox-write-ok\n";
  DWORD bytes_written = 0;
  if (!WriteFile(file.get(), payload, sizeof(payload) - 1, &bytes_written,
                 nullptr) ||
      bytes_written != sizeof(payload) - 1) {
    PrintFailure(L"WriteFile(allowed root)", GetLastError());
    return false;
  }

  std::wcout << L"PASS write-allowed-root path=" << path << L"\n";
  return true;
}

bool ModifyExpectedFile(const std::wstring& path) {
  UniqueHandle file(CreateFileW(path.c_str(), FILE_APPEND_DATA, 0, nullptr,
                                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!file) {
    PrintFailure(L"modify existing file in allowed root", GetLastError());
    return false;
  }

  constexpr char payload[] = "restricted-append-ok\n";
  DWORD bytes_written = 0;
  if (!WriteFile(file.get(), payload, sizeof(payload) - 1, &bytes_written,
                 nullptr) ||
      bytes_written != sizeof(payload) - 1) {
    PrintFailure(L"WriteFile(existing allowed file)", GetLastError());
    return false;
  }

  std::wcout << L"PASS modify-existing-allowed-file path=" << path << L"\n";
  return true;
}

bool VerifyWriteDenied(const std::wstring& path) {
  UniqueHandle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                                CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (file) {
    std::wcerr << L"FAIL write outside root unexpectedly succeeded path="
               << path << L"\n";
    return false;
  }

  DWORD error = GetLastError();
  if (error != ERROR_ACCESS_DENIED) {
    PrintFailure(L"write outside root returned unexpected error", error);
    return false;
  }

  std::wcout << L"PASS write-outside-root-denied error=" << error
             << L" path=" << path << L"\n";
  return true;
}

bool LaunchNestedProbe(const std::wstring& write_root,
                       const std::wstring& deny_root) {
  std::wstring executable = CurrentExecutablePath();
  if (executable.empty()) {
    PrintFailure(L"GetModuleFileName", GetLastError());
    return false;
  }

  std::wstring command_line = QuoteArgument(executable) + L" --nested-probe " +
                              QuoteArgument(write_root) + L" " +
                              QuoteArgument(deny_root);
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable.c_str(), mutable_command.data(), nullptr,
                      nullptr, FALSE, 0, nullptr, write_root.c_str(), &startup,
                      &process)) {
    PrintFailure(L"CreateProcess(nested probe)", GetLastError());
    return false;
  }

  UniqueHandle process_handle(process.hProcess);
  UniqueHandle thread_handle(process.hThread);
  if (WaitForSingleObject(process_handle.get(), 15000) != WAIT_OBJECT_0) {
    PrintFailure(L"WaitForSingleObject(nested probe)", GetLastError());
    return false;
  }

  DWORD exit_code = 0;
  if (!GetExitCodeProcess(process_handle.get(), &exit_code)) {
    PrintFailure(L"GetExitCodeProcess(nested probe)", GetLastError());
    return false;
  }
  if (exit_code != 0) {
    std::wcerr << L"FAIL nested probe exitCode=" << exit_code << L"\n";
    return false;
  }

  std::wcout << L"PASS nested-process-inherited-restriction\n";
  return true;
}

int RunNestedProbe(const std::wstring& write_root,
                   const std::wstring& deny_root) {
  PrintProcessContext(L"nested-probe");

  bool allowed = WriteExpectedFile(
      (std::filesystem::path(write_root) / L"nested-write.txt").wstring());
  bool denied = VerifyWriteDenied(
      (std::filesystem::path(deny_root) / L"nested-denied.txt").wstring());
  return allowed && denied ? 0 : 31;
}

int RunProbe(const std::wstring& read_path,
             const std::wstring& system_read_path,
             const std::wstring& write_root, const std::wstring& deny_root) {
  PrintProcessContext(L"restricted-probe");

  bool read = ReadExpectedFile(read_path);
  bool system_read = ReadExpectedFile(system_read_path);
  bool modified = ModifyExpectedFile(
      (std::filesystem::path(write_root) / L"existing.txt").wstring());
  bool allowed = WriteExpectedFile(
      (std::filesystem::path(write_root) / L"direct-write.txt").wstring());
  bool denied = VerifyWriteDenied(
      (std::filesystem::path(deny_root) / L"direct-denied.txt").wstring());
  bool nested = LaunchNestedProbe(write_root, deny_root);
  return read && system_read && modified && allowed && denied && nested ? 0 : 21;
}

int RunConcurrentProbe(const std::wstring& read_path,
                       const std::wstring& system_read_path,
                       const std::wstring& write_root,
                       const std::wstring& deny_root,
                       const std::wstring& job_name) {
  PrintProcessContext(L"concurrent-restricted-probe");

  std::filesystem::path own_root(write_root);
  std::filesystem::path peer_root(deny_root);
  if (!WriteIdentity(own_root, job_name)) {
    return 41;
  }

  PeerIdentity peer;
  if (!ReadIdentity(peer_root, &peer)) {
    return 42;
  }
  if (!WriteMarker(own_root / L"attack-ready.txt") ||
      !WaitForPath(peer_root / L"attack-ready.txt")) {
    return 43;
  }

  bool process_denied = VerifyProcessAccessDenied(peer.process_id);
  bool thread_denied = VerifyThreadAccessDenied(peer.thread_id);
  bool job_denied = VerifyJobAccessDenied(peer.job_name);

  if (!WriteMarker(own_root / L"attack-done.txt") ||
      !WaitForPath(peer_root / L"attack-done.txt")) {
    return 44;
  }
  if (!process_denied || !thread_denied || !job_denied) {
    return 45;
  }

  int file_result =
      RunProbe(read_path, system_read_path, write_root, deny_root);
  if (file_result != 0) {
    return file_result;
  }
  std::wcout << L"PASS concurrent-peer-object-isolation\n";
  return 0;
}

int LaunchRestrictedProbe(PSID execution_sid, PSID root_capability_sid,
                          bool install_capability_ace,
                          bool concurrent_probe,
                          const std::wstring& read_path,
                          const std::wstring& system_read_path,
                          const std::wstring& write_root,
                          const std::wstring& deny_root) {
  PrintProcessContext(L"launcher-parent");

  std::wcout << L"INFO executionSid=" << SidToString(execution_sid)
             << L" rootCapabilitySid=" << SidToString(root_capability_sid)
             << L"\n";

  if (install_capability_ace &&
      !GrantCapabilityToDirectory(write_root, root_capability_sid)) {
    return 12;
  }

  UniqueHandle restricted_token;
  if (!CreateRestrictedPrimaryToken(execution_sid, root_capability_sid,
                                    &restricted_token)) {
    return 13;
  }
  std::wcout << L"PASS restricted-token-created restricted="
             << (IsTokenRestricted(restricted_token.get()) ? L"yes" : L"no")
             << L" restrictedSidCount="
             << QueryRestrictedSidCount(restricted_token.get()) << L"\n";

  PrivateObjectSecurity private_security;
  if (!private_security.Initialize(execution_sid)) {
    return 14;
  }

  std::wstring job_name;
  if (concurrent_probe) {
    job_name = L"Local\\CodeAtelierProbeJob-" + SidToString(execution_sid);
  }
  UniqueHandle job;
  if (!ConfigureJob(private_security.attributes(), job_name, &job)) {
    return 14;
  }

  std::wstring executable = CurrentExecutablePath();
  if (executable.empty()) {
    PrintFailure(L"GetModuleFileName", GetLastError());
    return 15;
  }
  std::wstring probe_mode =
      concurrent_probe ? L" --concurrent-probe " : L" --probe ";
  std::wstring command_line = QuoteArgument(executable) + probe_mode +
                              QuoteArgument(read_path) + L" " +
                              QuoteArgument(system_read_path) + L" " +
                              QuoteArgument(write_root) + L" " +
                              QuoteArgument(deny_root);
  if (concurrent_probe) {
    command_line += L" " + QuoteArgument(job_name);
  }
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  DWORD creation_flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
  if (!CreateProcessAsUserW(
          restricted_token.get(), executable.c_str(), mutable_command.data(),
          private_security.attributes(), private_security.attributes(), FALSE,
          creation_flags, nullptr, write_root.c_str(), &startup, &process)) {
    PrintFailure(L"CreateProcessAsUser(restricted probe)", GetLastError());
    return 16;
  }

  UniqueHandle process_handle(process.hProcess);
  UniqueHandle thread_handle(process.hThread);
  if (!AssignProcessToJobObject(job.get(), process_handle.get())) {
    PrintFailure(L"AssignProcessToJobObject", GetLastError());
    TerminateProcess(process_handle.get(), 17);
    return 17;
  }
  if (ResumeThread(thread_handle.get()) == static_cast<DWORD>(-1)) {
    PrintFailure(L"ResumeThread", GetLastError());
    TerminateProcess(process_handle.get(), 18);
    return 18;
  }

  if (WaitForSingleObject(process_handle.get(), 30000) != WAIT_OBJECT_0) {
    PrintFailure(L"WaitForSingleObject(restricted probe)", GetLastError());
    TerminateProcess(process_handle.get(), 19);
    return 19;
  }

  DWORD exit_code = 0;
  if (!GetExitCodeProcess(process_handle.get(), &exit_code)) {
    PrintFailure(L"GetExitCodeProcess(restricted probe)", GetLastError());
    return 20;
  }
  if (exit_code != 0) {
    std::wcerr << L"FAIL restricted probe exitCode=" << exit_code << L"\n";
    return static_cast<int>(exit_code);
  }

  std::wcout << L"PASS launcher-observed-success\n";
  return 0;
}

int RunLauncher(const std::wstring& read_path,
                const std::wstring& system_read_path,
                const std::wstring& write_root, const std::wstring& deny_root) {
  SidPointer execution_sid = CreateCapabilitySid();
  SidPointer root_capability_sid = CreateCapabilitySid();
  if (!execution_sid || !root_capability_sid) {
    return 11;
  }
  return LaunchRestrictedProbe(execution_sid.get(), root_capability_sid.get(),
                               true, false, read_path, system_read_path,
                               write_root, deny_root);
}

int RunDedicatedAccountLauncher(const std::wstring& execution_sid_text,
                                const std::wstring& root_capability_sid_text,
                                bool concurrent_probe,
                                const std::wstring& read_path,
                                const std::wstring& system_read_path,
                                const std::wstring& write_root,
                                const std::wstring& deny_root) {
  PSID raw_execution_sid = nullptr;
  if (!ConvertStringSidToSidW(execution_sid_text.c_str(),
                              &raw_execution_sid)) {
    PrintFailure(L"ConvertStringSidToSid(execution)", GetLastError());
    return 11;
  }
  LocalPointer execution_sid(raw_execution_sid);

  PSID raw_root_capability_sid = nullptr;
  if (!ConvertStringSidToSidW(root_capability_sid_text.c_str(),
                              &raw_root_capability_sid)) {
    PrintFailure(L"ConvertStringSidToSid(root capability)", GetLastError());
    return 11;
  }
  LocalPointer root_capability_sid(raw_root_capability_sid);

  if (!IsValidSid(execution_sid.get()) ||
      !IsValidSid(root_capability_sid.get())) {
    std::wcerr << L"FAIL invalid externally supplied capability SID\n";
    return 11;
  }

  return LaunchRestrictedProbe(execution_sid.get(), root_capability_sid.get(),
                               false, concurrent_probe, read_path,
                               system_read_path, write_root, deny_root);
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc == 6 && std::wstring(argv[1]) == L"--launch") {
    return RunLauncher(argv[2], argv[3], argv[4], argv[5]);
  }
  if (argc == 8 && std::wstring(argv[1]) == L"--dedicated-account-launch") {
    return RunDedicatedAccountLauncher(argv[2], argv[3], false, argv[4],
                                       argv[5], argv[6], argv[7]);
  }
  if (argc == 8 &&
      std::wstring(argv[1]) == L"--dedicated-account-concurrent-launch") {
    return RunDedicatedAccountLauncher(argv[2], argv[3], true, argv[4],
                                       argv[5], argv[6], argv[7]);
  }
  if (argc == 6 && std::wstring(argv[1]) == L"--probe") {
    return RunProbe(argv[2], argv[3], argv[4], argv[5]);
  }
  if (argc == 7 && std::wstring(argv[1]) == L"--concurrent-probe") {
    return RunConcurrentProbe(argv[2], argv[3], argv[4], argv[5], argv[6]);
  }
  if (argc == 4 && std::wstring(argv[1]) == L"--nested-probe") {
    return RunNestedProbe(argv[2], argv[3]);
  }

  std::wcerr
      << L"Usage: restricted-token-demo.exe --launch <read-file> "
         L"<system-read-file> <write-root> <deny-root>\n"
         L"   or: restricted-token-demo.exe --dedicated-account-launch "
         L"<execution-sid> <root-capability-sid> <read-file> "
         L"<system-read-file> <write-root> <deny-root>\n"
         L"   or: replace --dedicated-account-launch with "
         L"--dedicated-account-concurrent-launch\n";
  return 2;
}
