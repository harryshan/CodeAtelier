/*
 * 本文件是 CodeAtelier Windows 网络与 Broker IPC 设计的独立可行性探针，不接入产品。
 * 调用方通过 run-demo.ps1 编译后分别执行 ipc 与 wfp 模式；两种模式不互相提供安全保证。
 *
 * 代码结构按验证顺序组织：
 * 1. Win32 handle、SID、进程启动和 token 查询辅助函数。
 * 2. IPC client 与 Broker 侧命名管道身份核验，验证 PID、创建时间、restricted SID 和 Job。
 * 3. TCP/UDP、回环/TEST-NET、listen/raw client 与动态 WFP filter，验证内建身份和层范围。
 * 4. 专用账户 WFP controller，用 ALE_USER_ID 在 V4/V6 connect/listen/resource-assignment
 *    层安装端口允许及其余操作阻断，并用控制目录与 PowerShell 编排器同步；编排器负责在
 *    临时账户下启动普通 client 和 restricted Runtime 的网络后代，并验证 engine 正常关闭或
 *    controller 被终止后两个地址族均恢复连接。
 * 5. 持久 WFP 入口用固定测试 GUID 安装、枚举自检和删除 provider/sublayer/filters。
 * 6. wmain 只负责模式分派，保持每个子进程入口参数固定且易审计。
 *
 * WFP filter 使用动态 session，engine handle 关闭后由 BFE 自动删除。探针只连接本机回环端口，
 * 不访问互联网。WFP 模式需要有权向 BFE 添加 filter；普通非提升用户预期会安全失败。
 */

#define WIN32_LEAN_AND_MEAN
#define SECURITY_WIN32
#include <windows.h>
#include <aclapi.h>
#include <fwpmu.h>
#include <objbase.h>
#include <sddl.h>
#include <winsock2.h>
#include <ws2tcpip.h>

#include <array>
#include <atomic>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr DWORD kRestrictedTokenFlags =
    DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
constexpr DWORD kNetworkBlockedExitCode = 20;
const GUID kPersistentProvider = {0x9e201d5a, 0x9dc9, 0x4ae1,
                                  {0x89, 0xe5, 0x43, 0x65, 0xdf, 0x7f, 0x22, 0x01}};
const GUID kPersistentSublayer = {0x2d283465, 0xf136, 0x45ac,
                                  {0xa8, 0xba, 0xdf, 0x3a, 0xaa, 0x3b, 0x22, 0x02}};

class UniqueHandle {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE value) : value_(value) {}
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.release()) {}
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

class UniqueSocket {
 public:
  explicit UniqueSocket(SOCKET value = INVALID_SOCKET) : value_(value) {}
  UniqueSocket(const UniqueSocket&) = delete;
  UniqueSocket& operator=(const UniqueSocket&) = delete;
  UniqueSocket(UniqueSocket&& other) noexcept : value_(other.release()) {}
  UniqueSocket& operator=(UniqueSocket&& other) noexcept {
    if (this != &other) {
      if (value_ != INVALID_SOCKET) {
        closesocket(value_);
      }
      value_ = other.release();
    }
    return *this;
  }
  ~UniqueSocket() {
    if (value_ != INVALID_SOCKET) {
      closesocket(value_);
    }
  }
  SOCKET get() const { return value_; }
  explicit operator bool() const { return value_ != INVALID_SOCKET; }

  SOCKET release() {
    SOCKET value = value_;
    value_ = INVALID_SOCKET;
    return value;
  }

 private:
  SOCKET value_;
};

class UniqueWfpEngine {
 public:
  UniqueWfpEngine() = default;
  UniqueWfpEngine(const UniqueWfpEngine&) = delete;
  UniqueWfpEngine& operator=(const UniqueWfpEngine&) = delete;
  ~UniqueWfpEngine() {
    if (value_ != nullptr) {
      FwpmEngineClose0(value_);
    }
  }

  HANDLE get() const { return value_; }
  void reset(HANDLE value) { value_ = value; }

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

struct WfpMemoryDeleter {
  void operator()(void* value) const {
    if (value != nullptr) {
      void* mutable_value = value;
      FwpmFreeMemory0(&mutable_value);
    }
  }
};

using LocalPointer = std::unique_ptr<void, LocalFreeDeleter>;
using SidPointer = std::unique_ptr<void, SidDeleter>;
using WfpPointer = std::unique_ptr<void, WfpMemoryDeleter>;

std::wstring FormatWindowsError(DWORD error) {
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

SidPointer CreateRandomSid() {
  GUID guid{};
  if (FAILED(CoCreateGuid(&guid))) {
    return SidPointer();
  }

  DWORD part_two = (static_cast<DWORD>(guid.Data2) << 16) | guid.Data3;
  DWORD part_three = (static_cast<DWORD>(guid.Data4[0]) << 24) |
                     (static_cast<DWORD>(guid.Data4[1]) << 16) |
                     (static_cast<DWORD>(guid.Data4[2]) << 8) | guid.Data4[3];
  DWORD part_four = (static_cast<DWORD>(guid.Data4[4]) << 24) |
                    (static_cast<DWORD>(guid.Data4[5]) << 16) |
                    (static_cast<DWORD>(guid.Data4[6]) << 8) | guid.Data4[7];
  SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
  PSID raw_sid = nullptr;
  if (!AllocateAndInitializeSid(&authority, 5, SECURITY_NT_NON_UNIQUE,
                                guid.Data1, part_two, part_three, part_four, 0,
                                0, 0, &raw_sid)) {
    return SidPointer();
  }
  return SidPointer(raw_sid);
}

bool QueryCurrentUserSid(std::vector<BYTE>* sid) {
  UniqueHandle token;
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) {
    PrintFailure(L"OpenProcessToken(current)", GetLastError());
    return false;
  }
  token.reset(raw_token);

  DWORD required = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &required);
  std::vector<BYTE> buffer(required);
  if (required == 0 || !GetTokenInformation(token.get(), TokenUser,
                                             buffer.data(), required,
                                             &required)) {
    PrintFailure(L"GetTokenInformation(TokenUser)", GetLastError());
    return false;
  }

  auto* user = reinterpret_cast<TOKEN_USER*>(buffer.data());
  DWORD sid_size = GetLengthSid(user->User.Sid);
  sid->resize(sid_size);
  if (!CopySid(sid_size, sid->data(), user->User.Sid)) {
    PrintFailure(L"CopySid(current user)", GetLastError());
    return false;
  }
  return true;
}

bool QueryLogonSid(HANDLE token, std::vector<BYTE>* sid) {
  DWORD required = 0;
  GetTokenInformation(token, TokenGroups, nullptr, 0, &required);
  std::vector<BYTE> buffer(required);
  if (required == 0 || !GetTokenInformation(token, TokenGroups, buffer.data(),
                                             required, &required)) {
    return false;
  }

  auto* groups = reinterpret_cast<TOKEN_GROUPS*>(buffer.data());
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    if ((groups->Groups[index].Attributes & SE_GROUP_LOGON_ID) ==
        SE_GROUP_LOGON_ID) {
      DWORD sid_size = GetLengthSid(groups->Groups[index].Sid);
      sid->resize(sid_size);
      return CopySid(sid_size, sid->data(), groups->Groups[index].Sid) != FALSE;
    }
  }
  return false;
}

bool TokenContainsRestrictedSid(HANDLE token, PSID expected_sid) {
  DWORD required = 0;
  GetTokenInformation(token, TokenRestrictedSids, nullptr, 0, &required);
  std::vector<BYTE> buffer(required);
  if (required == 0 ||
      !GetTokenInformation(token, TokenRestrictedSids, buffer.data(), required,
                           &required)) {
    return false;
  }

  auto* groups = reinterpret_cast<TOKEN_GROUPS*>(buffer.data());
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    if (EqualSid(groups->Groups[index].Sid, expected_sid)) {
      return true;
    }
  }
  return false;
}

bool CreateProbeRestrictedToken(PSID execution_sid, UniqueHandle* output) {
  UniqueHandle source;
  HANDLE raw_source = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(),
                        TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY |
                            TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_PRIVILEGES,
                        &raw_source)) {
    PrintFailure(L"OpenProcessToken(source)", GetLastError());
    return false;
  }
  source.reset(raw_source);

  std::vector<BYTE> logon_sid;
  std::vector<BYTE> user_sid;
  if (!QueryLogonSid(source.get(), &logon_sid) ||
      !QueryCurrentUserSid(&user_sid)) {
    PrintFailure(L"QueryLogonSid", GetLastError());
    return false;
  }
  DWORD everyone_size = SECURITY_MAX_SID_SIZE;
  std::vector<BYTE> everyone_sid(everyone_size);
  if (!CreateWellKnownSid(WinWorldSid, nullptr, everyone_sid.data(),
                          &everyone_size)) {
    PrintFailure(L"CreateWellKnownSid(Everyone)", GetLastError());
    return false;
  }

  std::array<SID_AND_ATTRIBUTES, 4> restricting{};
  restricting[0].Sid = execution_sid;
  restricting[1].Sid = user_sid.data();
  restricting[2].Sid = logon_sid.data();
  restricting[3].Sid = everyone_sid.data();
  HANDLE raw_restricted = nullptr;
  if (!CreateRestrictedToken(source.get(), kRestrictedTokenFlags, 0, nullptr, 0,
                             nullptr, static_cast<DWORD>(restricting.size()),
                             restricting.data(), &raw_restricted)) {
    PrintFailure(L"CreateRestrictedToken(ipc client)", GetLastError());
    return false;
  }
  output->reset(raw_restricted);

  std::array<EXPLICIT_ACCESSW, 2> entries{};
  std::array<PSID, 2> sids = {logon_sid.data(), everyone_sid.data()};
  for (size_t index = 0; index < entries.size(); ++index) {
    entries[index].grfAccessPermissions = GENERIC_ALL;
    entries[index].grfAccessMode = GRANT_ACCESS;
    entries[index].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entries[index].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    entries[index].Trustee.ptstrName = static_cast<LPWSTR>(sids[index]);
  }
  PACL dacl = nullptr;
  DWORD acl_result = SetEntriesInAclW(static_cast<ULONG>(entries.size()),
                                      entries.data(), nullptr, &dacl);
  LocalPointer owned_dacl(dacl);
  if (acl_result != ERROR_SUCCESS) {
    PrintFailure(L"SetEntriesInAcl(token default DACL)", acl_result);
    return false;
  }
  TOKEN_DEFAULT_DACL default_dacl{dacl};
  if (!SetTokenInformation(output->get(), TokenDefaultDacl, &default_dacl,
                           sizeof(default_dacl))) {
    PrintFailure(L"SetTokenInformation(TokenDefaultDacl)", GetLastError());
    return false;
  }

  LUID change_notify{};
  if (!LookupPrivilegeValueW(nullptr, SE_CHANGE_NOTIFY_NAME, &change_notify)) {
    PrintFailure(L"LookupPrivilegeValue(SeChangeNotifyPrivilege)",
                 GetLastError());
    return false;
  }
  TOKEN_PRIVILEGES privileges{};
  privileges.PrivilegeCount = 1;
  privileges.Privileges[0].Luid = change_notify;
  privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
  SetLastError(ERROR_SUCCESS);
  if (!AdjustTokenPrivileges(output->get(), FALSE, &privileges, 0, nullptr,
                             nullptr) ||
      GetLastError() == ERROR_NOT_ALL_ASSIGNED) {
    PrintFailure(L"AdjustTokenPrivileges(SeChangeNotifyPrivilege)",
                 GetLastError());
    return false;
  }
  return true;
}

bool BuildPipeSecurity(PSID execution_sid,
                       SECURITY_ATTRIBUTES* attributes,
                       LocalPointer* owned_dacl,
                       std::vector<BYTE>* descriptor) {
  std::vector<BYTE> user_sid;
  if (!QueryCurrentUserSid(&user_sid)) {
    return false;
  }

  std::array<EXPLICIT_ACCESSW, 2> entries{};
  std::array<PSID, 2> sids = {user_sid.data(), execution_sid};
  for (size_t index = 0; index < entries.size(); ++index) {
    entries[index].grfAccessPermissions = GENERIC_READ | GENERIC_WRITE;
    entries[index].grfAccessMode = GRANT_ACCESS;
    entries[index].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entries[index].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    entries[index].Trustee.ptstrName = static_cast<LPWSTR>(sids[index]);
  }

  PACL dacl = nullptr;
  DWORD result = SetEntriesInAclW(static_cast<ULONG>(entries.size()),
                                  entries.data(), nullptr, &dacl);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"SetEntriesInAcl(pipe)", result);
    return false;
  }
  owned_dacl->reset(dacl);

  descriptor->resize(SECURITY_DESCRIPTOR_MIN_LENGTH);
  auto* security_descriptor =
      reinterpret_cast<PSECURITY_DESCRIPTOR>(descriptor->data());
  if (!InitializeSecurityDescriptor(security_descriptor,
                                    SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorDacl(security_descriptor, TRUE, dacl, FALSE)) {
    PrintFailure(L"build pipe security descriptor", GetLastError());
    return false;
  }

  attributes->nLength = sizeof(*attributes);
  attributes->lpSecurityDescriptor = security_descriptor;
  attributes->bInheritHandle = FALSE;
  return true;
}

std::wstring MakePipeName() {
  GUID guid{};
  CoCreateGuid(&guid);
  wchar_t text[64]{};
  StringFromGUID2(guid, text, static_cast<int>(std::size(text)));
  return L"\\\\.\\pipe\\CodeAtelierNetworkIpcDemo-" + std::wstring(text);
}

bool ConfigureJob(UniqueHandle* job) {
  job->reset(CreateJobObjectW(nullptr, nullptr));
  if (!*job) {
    PrintFailure(L"CreateJobObject", GetLastError());
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job->get(), JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    PrintFailure(L"SetInformationJobObject", GetLastError());
    return false;
  }
  return true;
}

bool SameCreationTime(HANDLE first, HANDLE second) {
  FILETIME first_create{}, first_exit{}, first_kernel{}, first_user{};
  FILETIME second_create{}, second_exit{}, second_kernel{}, second_user{};
  if (!GetProcessTimes(first, &first_create, &first_exit, &first_kernel,
                       &first_user) ||
      !GetProcessTimes(second, &second_create, &second_exit, &second_kernel,
                       &second_user)) {
    return false;
  }
  return CompareFileTime(&first_create, &second_create) == 0;
}

bool SameImage(HANDLE process, const std::wstring& expected_image) {
  std::vector<wchar_t> buffer(32768);
  DWORD length = static_cast<DWORD>(buffer.size());
  if (!QueryFullProcessImageNameW(process, 0, buffer.data(), &length)) {
    return false;
  }
  return _wcsicmp(std::wstring(buffer.data(), length).c_str(),
                  expected_image.c_str()) == 0;
}

bool LaunchProcess(const std::wstring& image,
                   const std::wstring& arguments,
                   HANDLE token,
                   HANDLE job,
                   PROCESS_INFORMATION* process) {
  std::wstring command = QuoteArgument(image) + L" " + arguments;
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  DWORD flags = job != nullptr ? CREATE_SUSPENDED : 0;
  BOOL created = token == nullptr
                     ? CreateProcessW(image.c_str(), mutable_command.data(),
                                      nullptr, nullptr, FALSE, flags, nullptr,
                                      nullptr, &startup, process)
                     : CreateProcessAsUserW(
                           token, image.c_str(), mutable_command.data(), nullptr,
                           nullptr, FALSE, flags, nullptr, nullptr, &startup,
                           process);
  if (!created) {
    PrintFailure(L"CreateProcess(client)", GetLastError());
    return false;
  }

  if (job != nullptr) {
    if (!AssignProcessToJobObject(job, process->hProcess)) {
      PrintFailure(L"AssignProcessToJobObject(client)", GetLastError());
      TerminateProcess(process->hProcess, 99);
      return false;
    }
    if (ResumeThread(process->hThread) == static_cast<DWORD>(-1)) {
      PrintFailure(L"ResumeThread(client)", GetLastError());
      TerminateProcess(process->hProcess, 99);
      return false;
    }
  }
  return true;
}

bool WaitForExit(PROCESS_INFORMATION* process, DWORD* exit_code) {
  if (WaitForSingleObject(process->hProcess, 10000) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(process->hProcess, exit_code)) {
    PrintFailure(L"wait for client", GetLastError());
    TerminateProcess(process->hProcess, 98);
    return false;
  }
  return true;
}

int RunIpcClient(const std::wstring& pipe_name,
                 const std::wstring& nonce,
                 const std::wstring& expected_reply) {
  if (!WaitNamedPipeW(pipe_name.c_str(), 5000)) {
    PrintFailure(L"WaitNamedPipe", GetLastError());
    return 10;
  }
  UniqueHandle pipe(CreateFileW(pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE,
                                0, nullptr, OPEN_EXISTING, 0, nullptr));
  if (!pipe) {
    PrintFailure(L"CreateFile(pipe client)", GetLastError());
    return 11;
  }

  DWORD written = 0;
  if (!WriteFile(pipe.get(), nonce.data(),
                 static_cast<DWORD>(nonce.size() * sizeof(wchar_t)), &written,
                 nullptr)) {
    PrintFailure(L"WriteFile(pipe nonce)", GetLastError());
    return 12;
  }
  wchar_t reply[16]{};
  DWORD read = 0;
  if (!ReadFile(pipe.get(), reply, sizeof(reply) - sizeof(wchar_t), &read,
                nullptr)) {
    PrintFailure(L"ReadFile(pipe reply)", GetLastError());
    return 13;
  }
  std::wstring actual(reply, read / sizeof(wchar_t));
  return actual == expected_reply ? 0 : 14;
}

bool ServeOnePipeClient(const std::wstring& pipe_name,
                        SECURITY_ATTRIBUTES* security,
                        HANDLE expected_process,
                        DWORD expected_pid,
                        HANDLE expected_job,
                        PSID execution_sid,
                        const std::wstring& expected_image,
                        const std::wstring& nonce,
                        bool should_accept) {
  UniqueHandle pipe(CreateNamedPipeW(
      pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT, 1, 1024, 1024,
      5000, security));
  if (!pipe) {
    PrintFailure(L"CreateNamedPipe", GetLastError());
    return false;
  }
  if (!ConnectNamedPipe(pipe.get(), nullptr) &&
      GetLastError() != ERROR_PIPE_CONNECTED) {
    PrintFailure(L"ConnectNamedPipe", GetLastError());
    return false;
  }

  ULONG client_pid = 0;
  if (!GetNamedPipeClientProcessId(pipe.get(), &client_pid)) {
    PrintFailure(L"GetNamedPipeClientProcessId", GetLastError());
    return false;
  }
  UniqueHandle actual_process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,
                                          FALSE, client_pid));
  if (!actual_process) {
    PrintFailure(L"OpenProcess(pipe client)", GetLastError());
    return false;
  }

  BOOL in_expected_job = FALSE;
  IsProcessInJob(actual_process.get(), expected_job, &in_expected_job);
  UniqueHandle client_token;
  HANDLE raw_token = nullptr;
  bool restricted = OpenProcessToken(actual_process.get(), TOKEN_QUERY,
                                     &raw_token) != FALSE;
  if (restricted) {
    client_token.reset(raw_token);
    restricted = IsTokenRestricted(client_token.get()) != FALSE;
  }
  bool execution_sid_present =
      restricted && TokenContainsRestrictedSid(client_token.get(), execution_sid);

  wchar_t received[128]{};
  DWORD read = 0;
  bool nonce_matches =
      ReadFile(pipe.get(), received, sizeof(received) - sizeof(wchar_t), &read,
               nullptr) != FALSE &&
      std::wstring(received, read / sizeof(wchar_t)) == nonce;
  bool same_creation = SameCreationTime(expected_process, actual_process.get());
  bool same_image = SameImage(actual_process.get(), expected_image);
  bool identity_matches = client_pid == expected_pid && same_creation &&
                          same_image && in_expected_job && restricted &&
                          execution_sid_present && nonce_matches;
  std::wstring reply = identity_matches ? L"ACCEPT" : L"REJECT";
  DWORD written = 0;
  WriteFile(pipe.get(), reply.data(),
            static_cast<DWORD>(reply.size() * sizeof(wchar_t)), &written,
            nullptr);
  FlushFileBuffers(pipe.get());

  std::wcout << L"IPC_ATTEST clientPid=" << client_pid
             << L" expectedPid=" << expected_pid
             << L" sameCreation=" << (same_creation ? L"yes" : L"no")
             << L" sameImage=" << (same_image ? L"yes" : L"no")
             << L" inExpectedJob=" << (in_expected_job ? L"yes" : L"no")
             << L" restricted=" << (restricted ? L"yes" : L"no")
             << L" executionSid=" << (execution_sid_present ? L"yes" : L"no")
             << L" nonce=" << (nonce_matches ? L"yes" : L"no")
             << L" decision=" << reply << L"\n";
  return identity_matches == should_accept;
}

bool RunIpcProbe() {
  std::wstring image = CurrentExecutablePath();
  SidPointer execution_sid = CreateRandomSid();
  if (image.empty() || !execution_sid) {
    std::wcerr << L"FAIL initialize IPC identity\n";
    return false;
  }

  UniqueHandle restricted_token;
  UniqueHandle job;
  if (!CreateProbeRestrictedToken(execution_sid.get(), &restricted_token) ||
      !ConfigureJob(&job)) {
    return false;
  }

  SECURITY_ATTRIBUTES security{};
  LocalPointer pipe_dacl;
  std::vector<BYTE> pipe_descriptor;
  if (!BuildPipeSecurity(execution_sid.get(), &security, &pipe_dacl,
                         &pipe_descriptor)) {
    return false;
  }

  std::wstring pipe_name = MakePipeName();
  std::wstring nonce = L"fixed-demo-nonce-known-to-both-clients";
  PROCESS_INFORMATION trusted{};
  std::wstring trusted_args = L"--ipc-client " + QuoteArgument(pipe_name) +
                              L" " + QuoteArgument(nonce) + L" ACCEPT";
  if (!LaunchProcess(image, trusted_args, restricted_token.get(), job.get(),
                     &trusted)) {
    return false;
  }
  UniqueHandle trusted_process(trusted.hProcess);
  UniqueHandle trusted_thread(trusted.hThread);
  bool trusted_verified = ServeOnePipeClient(
      pipe_name, &security, trusted_process.get(), trusted.dwProcessId, job.get(),
      execution_sid.get(), image, nonce, true);
  DWORD trusted_exit = 0;
  bool trusted_exited = WaitForExit(&trusted, &trusted_exit);

  PROCESS_INFORMATION rogue{};
  std::wstring rogue_args = L"--ipc-client " + QuoteArgument(pipe_name) + L" " +
                            QuoteArgument(nonce) + L" REJECT";
  if (!LaunchProcess(image, rogue_args, nullptr, nullptr, &rogue)) {
    return false;
  }
  UniqueHandle rogue_process(rogue.hProcess);
  UniqueHandle rogue_thread(rogue.hThread);
  bool rogue_rejected = ServeOnePipeClient(
      pipe_name, &security, trusted_process.get(), trusted.dwProcessId, job.get(),
      execution_sid.get(), image, nonce, false);
  DWORD rogue_exit = 0;
  bool rogue_exited = WaitForExit(&rogue, &rogue_exit);

  bool passed = trusted_verified && trusted_exited && trusted_exit == 0 &&
                rogue_rejected && rogue_exited && rogue_exit == 0;
  std::wcout << L"IPC_DEMO " << (passed ? L"PASS" : L"FAIL")
             << L" trustedAccepted=" << (trusted_verified ? L"yes" : L"no")
             << L" sameUserSameImageRogueRejected="
             << (rogue_rejected ? L"yes" : L"no") << L"\n";
  return passed;
}

bool StartLoopbackListener(int address_family, UniqueSocket* listener,
                           u_short* port);

int RunNetworkClient(int address_family, const std::wstring& port_text) {
  WSADATA data{};
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
    return kNetworkBlockedExitCode;
  }
  unsigned long port = std::stoul(port_text);
  UniqueSocket socket_handle(
      socket(address_family, SOCK_STREAM, IPPROTO_TCP));
  int result = SOCKET_ERROR;
  if (address_family == AF_INET) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<u_short>(port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    result = connect(socket_handle.get(), reinterpret_cast<sockaddr*>(&address),
                     sizeof(address));
  } else {
    sockaddr_in6 address{};
    address.sin6_family = AF_INET6;
    address.sin6_port = htons(static_cast<u_short>(port));
    address.sin6_addr = in6addr_loopback;
    result = connect(socket_handle.get(), reinterpret_cast<sockaddr*>(&address),
                     sizeof(address));
  }
  int error = result == 0 ? 0 : WSAGetLastError();
  if (result == 0) {
    char byte = 'x';
    send(socket_handle.get(), &byte, 1, 0);
  }
  WSACleanup();
  std::wcout << L"NETWORK_CLIENT pid=" << GetCurrentProcessId()
             << L" family="
             << (address_family == AF_INET ? L"ipv4" : L"ipv6")
             << L" connected=" << (result == 0 ? L"yes" : L"no")
             << L" error=" << error << L"\n";
  return result == 0 ? 0
                     : (error == WSAEACCES ? kNetworkBlockedExitCode : 21);
}

bool IsNetworkClientMode(const std::wstring& mode) {
  return mode == L"--network-client" || mode == L"--network-client-v6" ||
         mode == L"--udp-client" || mode == L"--udp-client-v6" ||
         mode == L"--external-client" ||
         mode == L"--external-client-v6" || mode == L"--dns-client" ||
         mode == L"--dns-client-v6" || mode == L"--listen-probe" ||
         mode == L"--listen-probe-v6" || mode == L"--raw-probe" ||
         mode == L"--raw-probe-v6";
}

int ReportSocketResult(const wchar_t* operation, int address_family,
                       int result, int error) {
  std::wcout << operation << L" pid=" << GetCurrentProcessId()
             << L" family="
             << (address_family == AF_INET ? L"ipv4" : L"ipv6")
             << L" allowed=" << (result == 0 ? L"yes" : L"no")
             << L" error=" << error << L"\n";
  return result == 0 ? 0
                     : (error == WSAEACCES ? kNetworkBlockedExitCode : 21);
}

int RunDatagramClient(int address_family, const std::wstring& port_text,
                      bool external) {
  WSADATA data{};
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
    return 21;
  }
  unsigned long port = std::stoul(port_text);
  UniqueSocket socket_handle(
      socket(address_family, SOCK_DGRAM, IPPROTO_UDP));
  DWORD receive_timeout = 1000;
  setsockopt(socket_handle.get(), SOL_SOCKET, SO_RCVTIMEO,
             reinterpret_cast<const char*>(&receive_timeout),
             sizeof(receive_timeout));
  char byte = 'x';
  int send_result = SOCKET_ERROR;
  sockaddr_storage destination{};
  int destination_length = 0;
  if (address_family == AF_INET) {
    auto& address = reinterpret_cast<sockaddr_in&>(destination);
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<u_short>(port));
    InetPtonW(AF_INET, external ? L"192.0.2.1" : L"127.0.0.1",
              &address.sin_addr);
    destination_length = sizeof(address);
  } else {
    auto& address = reinterpret_cast<sockaddr_in6&>(destination);
    address.sin6_family = AF_INET6;
    address.sin6_port = htons(static_cast<u_short>(port));
    InetPtonW(AF_INET6, external ? L"2001:db8::1" : L"::1",
              &address.sin6_addr);
    destination_length = sizeof(address);
  }
  send_result = sendto(socket_handle.get(), &byte, 1, 0,
                       reinterpret_cast<sockaddr*>(&destination),
                       destination_length);
  int send_error = send_result == SOCKET_ERROR ? WSAGetLastError() : 0;
  int receive_result = SOCKET_ERROR;
  int receive_error = 0;
  if (send_result != SOCKET_ERROR && !external) {
    char reply = 0;
    receive_result = recv(socket_handle.get(), &reply, 1, 0);
    receive_error =
        receive_result == SOCKET_ERROR ? WSAGetLastError() : 0;
  }
  WSACleanup();
  if (external) {
    return ReportSocketResult(L"UDP_EXTERNAL", address_family,
                              send_result == SOCKET_ERROR ? SOCKET_ERROR : 0,
                              send_error);
  }
  bool delivered = receive_result == 1;
  int final_error = send_error != 0 ? send_error : receive_error;
  std::wcout << L"UDP_CLIENT pid=" << GetCurrentProcessId() << L" family="
             << (address_family == AF_INET ? L"ipv4" : L"ipv6")
             << L" sent=" << (send_result == 1 ? L"yes" : L"no")
             << L" delivered=" << (delivered ? L"yes" : L"no")
             << L" error=" << final_error << L"\n";
  if (delivered) {
    return 0;
  }
  return final_error == WSAEACCES || final_error == WSAETIMEDOUT
             ? kNetworkBlockedExitCode
             : 21;
}

bool FindHostNonLoopbackAddress(int address_family, u_short port,
                                sockaddr_storage* address,
                                int* address_length) {
  char host_name[256]{};
  if (gethostname(host_name, sizeof(host_name)) != 0) {
    return false;
  }
  addrinfo hints{};
  hints.ai_family = address_family;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* addresses = nullptr;
  if (getaddrinfo(host_name, nullptr, &hints, &addresses) != 0) {
    return false;
  }
  bool found = false;
  for (addrinfo* current = addresses; current != nullptr;
       current = current->ai_next) {
    if (current->ai_family == AF_INET) {
      auto* candidate = reinterpret_cast<sockaddr_in*>(current->ai_addr);
      if ((ntohl(candidate->sin_addr.s_addr) >> 24) != 127) {
        std::memcpy(address, candidate, sizeof(*candidate));
        reinterpret_cast<sockaddr_in*>(address)->sin_port = htons(port);
        *address_length = sizeof(*candidate);
        found = true;
        break;
      }
    } else if (current->ai_family == AF_INET6) {
      auto* candidate = reinterpret_cast<sockaddr_in6*>(current->ai_addr);
      if (memcmp(&candidate->sin6_addr, &in6addr_loopback,
                 sizeof(in6addr_loopback)) != 0) {
        std::memcpy(address, candidate, sizeof(*candidate));
        reinterpret_cast<sockaddr_in6*>(address)->sin6_port = htons(port);
        *address_length = sizeof(*candidate);
        found = true;
        break;
      }
    }
  }
  freeaddrinfo(addresses);
  return found;
}

int RunExternalTcpClient(int address_family, const std::wstring& port_text) {
  WSADATA data{};
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
    return 21;
  }
  unsigned long port = std::stoul(port_text);
  UniqueSocket socket_handle(
      socket(address_family, SOCK_STREAM, IPPROTO_TCP));
  u_long nonblocking = 1;
  ioctlsocket(socket_handle.get(), FIONBIO, &nonblocking);
  sockaddr_storage address{};
  int address_length = 0;
  if (!FindHostNonLoopbackAddress(address_family, static_cast<u_short>(port),
                                  &address, &address_length)) {
    WSACleanup();
    std::wcerr << L"FAIL no non-loopback host address\n";
    return 21;
  }
  int result = connect(socket_handle.get(), reinterpret_cast<sockaddr*>(&address),
                       address_length);
  int error = result == 0 ? 0 : WSAGetLastError();
  if (result == SOCKET_ERROR && error == WSAEWOULDBLOCK) {
    fd_set writable{};
    fd_set exceptional{};
    FD_SET(socket_handle.get(), &writable);
    FD_SET(socket_handle.get(), &exceptional);
    timeval timeout{};
    timeout.tv_sec = 2;
    int selected =
        select(0, nullptr, &writable, &exceptional, &timeout);
    if (selected > 0) {
      int socket_error = 0;
      int error_length = sizeof(socket_error);
      if (getsockopt(socket_handle.get(), SOL_SOCKET, SO_ERROR,
                     reinterpret_cast<char*>(&socket_error),
                     &error_length) == 0) {
        error = socket_error;
        result = socket_error == 0 ? 0 : SOCKET_ERROR;
      } else {
        error = WSAGetLastError();
      }
    } else {
      error = selected == 0 ? WSAETIMEDOUT : WSAGetLastError();
    }
  }
  WSACleanup();
  return ReportSocketResult(L"TCP_NON_LOOPBACK", address_family, result,
                            error);
}

int RunListenProbe(int address_family) {
  UniqueSocket listener;
  u_short port = 0;
  bool started = StartLoopbackListener(address_family, &listener, &port);
  int error = started ? 0 : WSAGetLastError();
  WSACleanup();
  return ReportSocketResult(L"LISTEN_PROBE", address_family,
                            started ? 0 : SOCKET_ERROR, error);
}

int RunRawProbe(int address_family) {
  WSADATA data{};
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
    return 21;
  }
  UniqueSocket socket_handle(socket(address_family, SOCK_RAW,
                                    address_family == AF_INET ? IPPROTO_ICMP
                                                              : IPPROTO_ICMPV6));
  bool created = static_cast<bool>(socket_handle);
  int result = SOCKET_ERROR;
  int error = created ? 0 : WSAGetLastError();
  if (created && address_family == AF_INET) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    result = bind(socket_handle.get(), reinterpret_cast<sockaddr*>(&address),
                  sizeof(address));
    error = result == 0 ? 0 : WSAGetLastError();
  } else if (created) {
    sockaddr_in6 address{};
    address.sin6_family = AF_INET6;
    address.sin6_addr = in6addr_loopback;
    result = bind(socket_handle.get(), reinterpret_cast<sockaddr*>(&address),
                  sizeof(address));
    error = result == 0 ? 0 : WSAGetLastError();
  }
  WSACleanup();
  std::wcout << L"RAW_PROBE pid=" << GetCurrentProcessId() << L" family="
             << (address_family == AF_INET ? L"ipv4" : L"ipv6")
             << L" created=" << (created ? L"yes" : L"no")
             << L" bound=" << (result == 0 ? L"yes" : L"no")
             << L" error=" << error << L"\n";
  return result == 0 ? 0
                     : (error == WSAEACCES ? kNetworkBlockedExitCode : 21);
}

int RunNetworkDescendant(const std::wstring& client_mode,
                         const std::wstring& port_text) {
  if (!IsNetworkClientMode(client_mode)) {
    return 2;
  }
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) {
    PrintFailure(L"OpenProcessToken(network descendant)", GetLastError());
    return 21;
  }
  UniqueHandle token(raw_token);
  if (!IsTokenRestricted(token.get())) {
    std::wcerr << L"FAIL network descendant token is not restricted\n";
    return 22;
  }

  std::wstring image = CurrentExecutablePath();
  PROCESS_INFORMATION child{};
  std::wstring arguments = client_mode + L" " + QuoteArgument(port_text);
  if (image.empty() ||
      !LaunchProcess(image, arguments, nullptr, nullptr, &child)) {
    return 23;
  }
  UniqueHandle child_process(child.hProcess);
  UniqueHandle child_thread(child.hThread);
  DWORD child_exit = 0;
  if (!WaitForExit(&child, &child_exit)) {
    return 24;
  }
  std::wcout << L"RESTRICTED_NETWORK_PARENT pid=" << GetCurrentProcessId()
             << L" restricted=yes descendantPid=" << child.dwProcessId
             << L" descendantExit=" << child_exit << L"\n";
  return static_cast<int>(child_exit);
}

int RunRestrictedNetworkLauncher(const std::wstring& client_mode,
                                 const std::wstring& port_text) {
  if (!IsNetworkClientMode(client_mode)) {
    return 2;
  }
  std::wstring image = CurrentExecutablePath();
  SidPointer execution_sid = CreateRandomSid();
  UniqueHandle restricted_token;
  UniqueHandle job;
  if (image.empty() || !execution_sid ||
      !CreateProbeRestrictedToken(execution_sid.get(), &restricted_token) ||
      !ConfigureJob(&job)) {
    return 25;
  }

  PROCESS_INFORMATION runtime{};
  std::wstring arguments = L"--network-descendant " + client_mode + L" " +
                           QuoteArgument(port_text);
  if (!LaunchProcess(image, arguments, restricted_token.get(), job.get(),
                     &runtime)) {
    return 26;
  }
  UniqueHandle runtime_process(runtime.hProcess);
  UniqueHandle runtime_thread(runtime.hThread);
  DWORD runtime_exit = 0;
  if (!WaitForExit(&runtime, &runtime_exit)) {
    return 27;
  }
  std::wcout << L"RESTRICTED_NETWORK_LAUNCHER pid=" << GetCurrentProcessId()
             << L" runtimePid=" << runtime.dwProcessId
             << L" runtimeExit=" << runtime_exit << L"\n";
  return static_cast<int>(runtime_exit);
}

bool StartLoopbackListener(int address_family, UniqueSocket* listener,
                           u_short* port) {
  WSADATA data{};
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
    return false;
  }
  *listener =
      UniqueSocket(socket(address_family, SOCK_STREAM, IPPROTO_TCP));
  if (!*listener) {
    return false;
  }
  if (address_family == AF_INET) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = 0;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(listener->get(), reinterpret_cast<sockaddr*>(&address),
             sizeof(address)) != 0 ||
        listen(listener->get(), 8) != 0) {
      return false;
    }
    int length = sizeof(address);
    if (getsockname(listener->get(), reinterpret_cast<sockaddr*>(&address),
                    &length) != 0) {
      return false;
    }
    *port = ntohs(address.sin_port);
  } else {
    sockaddr_in6 address{};
    address.sin6_family = AF_INET6;
    address.sin6_port = 0;
    address.sin6_addr = in6addr_loopback;
    if (bind(listener->get(), reinterpret_cast<sockaddr*>(&address),
             sizeof(address)) != 0 ||
        listen(listener->get(), 8) != 0) {
      return false;
    }
    int length = sizeof(address);
    if (getsockname(listener->get(), reinterpret_cast<sockaddr*>(&address),
                    &length) != 0) {
      return false;
    }
    *port = ntohs(address.sin6_port);
  }
  return true;
}

bool StartUdpEchoSocket(int address_family, u_short port,
                        UniqueSocket* socket_handle) {
  *socket_handle =
      UniqueSocket(socket(address_family, SOCK_DGRAM, IPPROTO_UDP));
  if (!*socket_handle) {
    return false;
  }
  DWORD timeout = 100;
  setsockopt(socket_handle->get(), SOL_SOCKET, SO_RCVTIMEO,
             reinterpret_cast<const char*>(&timeout), sizeof(timeout));
  if (address_family == AF_INET) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    return bind(socket_handle->get(), reinterpret_cast<sockaddr*>(&address),
                sizeof(address)) == 0;
  }
  sockaddr_in6 address{};
  address.sin6_family = AF_INET6;
  address.sin6_port = htons(port);
  address.sin6_addr = in6addr_loopback;
  return bind(socket_handle->get(), reinterpret_cast<sockaddr*>(&address),
              sizeof(address)) == 0;
}

void RunUdpEchoLoop(SOCKET socket_handle, std::atomic_bool* stop) {
  while (!stop->load()) {
    sockaddr_storage peer{};
    int peer_length = sizeof(peer);
    char byte = 0;
    int received = recvfrom(socket_handle, &byte, 1, 0,
                            reinterpret_cast<sockaddr*>(&peer), &peer_length);
    if (received == 1) {
      sendto(socket_handle, &byte, 1, 0,
             reinterpret_cast<sockaddr*>(&peer), peer_length);
    }
  }
}

bool LaunchNetworkClient(const std::wstring& image,
                         u_short port,
                         DWORD expected_exit) {
  PROCESS_INFORMATION process{};
  std::wstring arguments = L"--network-client " + std::to_wstring(port);
  if (!LaunchProcess(image, arguments, nullptr, nullptr, &process)) {
    return false;
  }
  UniqueHandle owned_process(process.hProcess);
  UniqueHandle owned_thread(process.hThread);
  DWORD exit_code = 0;
  return WaitForExit(&process, &exit_code) && exit_code == expected_exit;
}

bool InstallDynamicAppIdBlock(const std::wstring& image,
                              u_short port,
                              UniqueWfpEngine* engine) {
  FWPM_SESSION0 session{};
  session.flags = FWPM_SESSION_FLAG_DYNAMIC;
  session.displayData.name = const_cast<wchar_t*>(L"CodeAtelier WFP demo");
  HANDLE raw_engine = nullptr;
  DWORD result = FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session,
                                 &raw_engine);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"FwpmEngineOpen0", result);
    return false;
  }
  engine->reset(raw_engine);

  GUID sublayer_key{};
  CoCreateGuid(&sublayer_key);
  FWPM_SUBLAYER0 sublayer{};
  sublayer.subLayerKey = sublayer_key;
  sublayer.displayData.name =
      const_cast<wchar_t*>(L"CodeAtelier dynamic feasibility sublayer");
  sublayer.weight = 0x100;
  result = FwpmSubLayerAdd0(engine->get(), &sublayer, nullptr);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"FwpmSubLayerAdd0 (requires elevated WFP policy access)",
                 result);
    return false;
  }

  FWP_BYTE_BLOB* raw_app_id = nullptr;
  result = FwpmGetAppIdFromFileName0(image.c_str(), &raw_app_id);
  WfpPointer app_id(raw_app_id);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"FwpmGetAppIdFromFileName0", result);
    return false;
  }

  std::array<FWPM_FILTER_CONDITION0, 2> conditions{};
  conditions[0].fieldKey = FWPM_CONDITION_ALE_APP_ID;
  conditions[0].matchType = FWP_MATCH_EQUAL;
  conditions[0].conditionValue.type = FWP_BYTE_BLOB_TYPE;
  conditions[0].conditionValue.byteBlob = raw_app_id;
  conditions[1].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
  conditions[1].matchType = FWP_MATCH_EQUAL;
  conditions[1].conditionValue.type = FWP_UINT16;
  conditions[1].conditionValue.uint16 = port;

  UINT8 weight = 15;
  FWPM_FILTER0 filter{};
  filter.displayData.name =
      const_cast<wchar_t*>(L"CodeAtelier block one app path demo");
  filter.layerKey = FWPM_LAYER_ALE_AUTH_CONNECT_V4;
  filter.subLayerKey = sublayer_key;
  filter.weight.type = FWP_UINT8;
  filter.weight.uint8 = weight;
  filter.numFilterConditions = static_cast<UINT32>(conditions.size());
  filter.filterCondition = conditions.data();
  filter.action.type = FWP_ACTION_BLOCK;
  result = FwpmFilterAdd0(engine->get(), &filter, nullptr, nullptr);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"FwpmFilterAdd0", result);
    return false;
  }
  return true;
}

bool AddUserFilter(HANDLE engine, const GUID& sublayer_key,
                   const GUID& layer_key, FWP_BYTE_BLOB* user_descriptor,
                   u_short remote_port,
                   bool match_port, UINT8 weight, FWP_ACTION_TYPE action,
                   const wchar_t* name, UINT32 flags = 0,
                   const GUID* provider_key = nullptr) {
  std::array<FWPM_FILTER_CONDITION0, 2> conditions{};
  conditions[0].fieldKey = FWPM_CONDITION_ALE_USER_ID;
  conditions[0].matchType = FWP_MATCH_EQUAL;
  conditions[0].conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE;
  conditions[0].conditionValue.sd = user_descriptor;
  if (match_port) {
    conditions[1].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
    conditions[1].matchType = FWP_MATCH_EQUAL;
    conditions[1].conditionValue.type = FWP_UINT16;
    conditions[1].conditionValue.uint16 = remote_port;
  }

  FWPM_FILTER0 filter{};
  filter.displayData.name = const_cast<wchar_t*>(name);
  filter.flags = flags;
  filter.providerKey = const_cast<GUID*>(provider_key);
  filter.layerKey = layer_key;
  filter.subLayerKey = sublayer_key;
  filter.weight.type = FWP_UINT8;
  filter.weight.uint8 = weight;
  filter.numFilterConditions = match_port ? 2 : 1;
  filter.filterCondition = conditions.data();
  filter.action.type = action;
  DWORD result = FwpmFilterAdd0(engine, &filter, nullptr, nullptr);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"FwpmFilterAdd0(user fence)", result);
    return false;
  }
  return true;
}

bool AddLoopbackUserPermit(HANDLE engine, const GUID& sublayer_key,
                           const GUID& layer_key,
                           FWP_BYTE_BLOB* user_descriptor,
                           u_short remote_port, bool ipv6,
                           const wchar_t* name, UINT32 flags = 0,
                           const GUID* provider_key = nullptr) {
  UINT32 loopback_v4 = 0x7f000001;
  FWP_BYTE_ARRAY16 loopback_v6{};
  loopback_v6.byteArray16[15] = 1;
  std::array<FWPM_FILTER_CONDITION0, 3> conditions{};
  conditions[0].fieldKey = FWPM_CONDITION_ALE_USER_ID;
  conditions[0].matchType = FWP_MATCH_EQUAL;
  conditions[0].conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE;
  conditions[0].conditionValue.sd = user_descriptor;
  conditions[1].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
  conditions[1].matchType = FWP_MATCH_EQUAL;
  conditions[1].conditionValue.type = FWP_UINT16;
  conditions[1].conditionValue.uint16 = remote_port;
  conditions[2].fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
  conditions[2].matchType = FWP_MATCH_EQUAL;
  if (ipv6) {
    conditions[2].conditionValue.type = FWP_BYTE_ARRAY16_TYPE;
    conditions[2].conditionValue.byteArray16 = &loopback_v6;
  } else {
    conditions[2].conditionValue.type = FWP_UINT32;
    conditions[2].conditionValue.uint32 = loopback_v4;
  }

  UINT8 weight = 15;
  FWPM_FILTER0 filter{};
  filter.displayData.name = const_cast<wchar_t*>(name);
  filter.flags = flags;
  filter.providerKey = const_cast<GUID*>(provider_key);
  filter.layerKey = layer_key;
  filter.subLayerKey = sublayer_key;
  filter.weight.type = FWP_UINT8;
  filter.weight.uint8 = weight;
  filter.numFilterConditions = static_cast<UINT32>(conditions.size());
  filter.filterCondition = conditions.data();
  filter.action.type = FWP_ACTION_PERMIT;
  DWORD result = FwpmFilterAdd0(engine, &filter, nullptr, nullptr);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"FwpmFilterAdd0(loopback permit)", result);
    return false;
  }
  return true;
}

bool AddRawEndpointBlock(HANDLE engine, const GUID& sublayer_key,
                         const GUID& layer_key,
                         FWP_BYTE_BLOB* user_descriptor,
                         const wchar_t* name, UINT32 flags = 0,
                         const GUID* provider_key = nullptr) {
  std::array<FWPM_FILTER_CONDITION0, 2> conditions{};
  conditions[0].fieldKey = FWPM_CONDITION_ALE_USER_ID;
  conditions[0].matchType = FWP_MATCH_EQUAL;
  conditions[0].conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE;
  conditions[0].conditionValue.sd = user_descriptor;
  conditions[1].fieldKey = FWPM_CONDITION_FLAGS;
  conditions[1].matchType = FWP_MATCH_FLAGS_ALL_SET;
  conditions[1].conditionValue.type = FWP_UINT32;
  conditions[1].conditionValue.uint32 = FWP_CONDITION_FLAG_IS_RAW_ENDPOINT;

  UINT8 weight = 14;
  FWPM_FILTER0 filter{};
  filter.displayData.name = const_cast<wchar_t*>(name);
  filter.flags = flags;
  filter.providerKey = const_cast<GUID*>(provider_key);
  filter.layerKey = layer_key;
  filter.subLayerKey = sublayer_key;
  filter.weight.type = FWP_UINT8;
  filter.weight.uint8 = weight;
  filter.numFilterConditions = static_cast<UINT32>(conditions.size());
  filter.filterCondition = conditions.data();
  filter.action.type = FWP_ACTION_BLOCK;
  DWORD result = FwpmFilterAdd0(engine, &filter, nullptr, nullptr);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"FwpmFilterAdd0(raw endpoint)", result);
    return false;
  }
  return true;
}

bool InstallDynamicUserFence(const std::wstring& user_name,
                             u_short allowed_v4_port,
                             u_short allowed_v6_port,
                             UniqueWfpEngine* engine) {
  FWPM_SESSION0 session{};
  session.flags = FWPM_SESSION_FLAG_DYNAMIC;
  session.displayData.name =
      const_cast<wchar_t*>(L"CodeAtelier user SID WFP demo");
  HANDLE raw_engine = nullptr;
  DWORD result = FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session,
                                 &raw_engine);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"FwpmEngineOpen0(user fence)", result);
    return false;
  }
  engine->reset(raw_engine);

  GUID sublayer_key{};
  if (CoCreateGuid(&sublayer_key) != S_OK) {
    std::wcerr << L"FAIL CoCreateGuid(user fence sublayer)\n";
    return false;
  }
  FWPM_SUBLAYER0 sublayer{};
  sublayer.subLayerKey = sublayer_key;
  sublayer.displayData.name =
      const_cast<wchar_t*>(L"CodeAtelier dynamic user fence sublayer");
  sublayer.weight = 0x101;
  result = FwpmSubLayerAdd0(engine->get(), &sublayer, nullptr);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"FwpmSubLayerAdd0(user fence requires elevation)", result);
    return false;
  }

  EXPLICIT_ACCESS_W access{};
  BuildExplicitAccessWithNameW(&access, const_cast<wchar_t*>(user_name.c_str()),
                               FWP_ACTRL_MATCH_FILTER, GRANT_ACCESS, 0);
  ULONG descriptor_size = 0;
  PSECURITY_DESCRIPTOR raw_descriptor = nullptr;
  result = BuildSecurityDescriptorW(nullptr, nullptr, 1, &access, 0, nullptr,
                                    nullptr, &descriptor_size,
                                    &raw_descriptor);
  LocalPointer descriptor(raw_descriptor);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"BuildSecurityDescriptorW(user fence)", result);
    return false;
  }
  FWP_BYTE_BLOB descriptor_blob{};
  descriptor_blob.size = descriptor_size;
  descriptor_blob.data = static_cast<UINT8*>(raw_descriptor);

  constexpr UINT8 kBlockWeight = 14;
  if (!AddLoopbackUserPermit(engine->get(), sublayer_key,
                             FWPM_LAYER_ALE_AUTH_CONNECT_V4, &descriptor_blob,
                             allowed_v4_port, false,
                             L"CodeAtelier allow user IPv4 loopback relay") ||
      !AddUserFilter(engine->get(), sublayer_key,
                     FWPM_LAYER_ALE_AUTH_CONNECT_V4, &descriptor_blob, 0, false,
                     kBlockWeight, FWP_ACTION_BLOCK,
                     L"CodeAtelier block other user IPv4 connections") ||
      !AddLoopbackUserPermit(engine->get(), sublayer_key,
                             FWPM_LAYER_ALE_AUTH_CONNECT_V6, &descriptor_blob,
                             allowed_v6_port, true,
                             L"CodeAtelier allow user IPv6 loopback relay") ||
      !AddUserFilter(engine->get(), sublayer_key,
                     FWPM_LAYER_ALE_AUTH_CONNECT_V6, &descriptor_blob, 0, false,
                     kBlockWeight, FWP_ACTION_BLOCK,
                     L"CodeAtelier block other user IPv6 connections") ||
      !AddUserFilter(engine->get(), sublayer_key,
                     FWPM_LAYER_ALE_AUTH_LISTEN_V4, &descriptor_blob, 0, false,
                     kBlockWeight, FWP_ACTION_BLOCK,
                     L"CodeAtelier block user IPv4 listen") ||
      !AddUserFilter(engine->get(), sublayer_key,
                     FWPM_LAYER_ALE_AUTH_LISTEN_V6, &descriptor_blob, 0, false,
                     kBlockWeight, FWP_ACTION_BLOCK,
                     L"CodeAtelier block user IPv6 listen") ||
      !AddRawEndpointBlock(engine->get(), sublayer_key,
                           FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4,
                           &descriptor_blob,
                           L"CodeAtelier block user IPv4 raw endpoint") ||
      !AddRawEndpointBlock(engine->get(), sublayer_key,
                           FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6,
                           &descriptor_blob,
                           L"CodeAtelier block user IPv6 raw endpoint")) {
    return false;
  }
  return true;
}

bool OpenPersistentEngine(UniqueWfpEngine* engine) {
  HANDLE raw_engine = nullptr;
  DWORD result = FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, nullptr,
                                 &raw_engine);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"FwpmEngineOpen0(persistent)", result);
    return false;
  }
  engine->reset(raw_engine);
  return true;
}

FWPM_FILTER_ENUM_TEMPLATE0 PersistentFilterEnumTemplate() {
  FWPM_FILTER_ENUM_TEMPLATE0 filter_template{};
  filter_template.providerKey = const_cast<GUID*>(&kPersistentProvider);
  // A zero actionMask matches no action types and BFE rejects the template as
  // FWP_E_NEVER_MATCH. UINT32_MAX explicitly means to ignore action type.
  filter_template.actionMask = UINT32_MAX;
  return filter_template;
}

bool RemovePersistentFence() {
  UniqueWfpEngine engine;
  if (!OpenPersistentEngine(&engine)) {
    return false;
  }
  FWPM_FILTER_ENUM_TEMPLATE0 filter_template =
      PersistentFilterEnumTemplate();
  HANDLE enum_handle = nullptr;
  DWORD result = FwpmFilterCreateEnumHandle0(engine.get(), &filter_template,
                                             &enum_handle);
  if (result != ERROR_SUCCESS) {
    PrintFailure(L"FwpmFilterCreateEnumHandle0(persistent)", result);
    return false;
  }
  FWPM_FILTER0** entries = nullptr;
  UINT32 count = 0;
  result = FwpmFilterEnum0(engine.get(), enum_handle, 100, &entries, &count);
  if (result == ERROR_SUCCESS) {
    for (UINT32 index = 0; index < count; ++index) {
      FwpmFilterDeleteById0(engine.get(), entries[index]->filterId);
    }
  }
  if (entries != nullptr) {
    FwpmFreeMemory0(reinterpret_cast<void**>(&entries));
  }
  FwpmFilterDestroyEnumHandle0(engine.get(), enum_handle);
  DWORD sublayer_result =
      FwpmSubLayerDeleteByKey0(engine.get(), &kPersistentSublayer);
  DWORD provider_result =
      FwpmProviderDeleteByKey0(engine.get(), &kPersistentProvider);
  bool removed = (sublayer_result == ERROR_SUCCESS ||
                  sublayer_result == FWP_E_SUBLAYER_NOT_FOUND) &&
                 (provider_result == ERROR_SUCCESS ||
                  provider_result == FWP_E_PROVIDER_NOT_FOUND);
  std::wcout << L"WFP_PERSISTENT_REMOVE "
             << (removed ? L"PASS" : L"FAIL") << L" filters=" << count
             << L"\n";
  return removed;
}

bool VerifyPersistentFence() {
  UniqueWfpEngine engine;
  if (!OpenPersistentEngine(&engine)) {
    return false;
  }
  FWPM_PROVIDER0* provider = nullptr;
  FWPM_SUBLAYER0* sublayer = nullptr;
  DWORD provider_result =
      FwpmProviderGetByKey0(engine.get(), &kPersistentProvider, &provider);
  DWORD sublayer_result =
      FwpmSubLayerGetByKey0(engine.get(), &kPersistentSublayer, &sublayer);
  WfpPointer owned_provider(provider);
  WfpPointer owned_sublayer(sublayer);

  FWPM_FILTER_ENUM_TEMPLATE0 filter_template =
      PersistentFilterEnumTemplate();
  HANDLE enum_handle = nullptr;
  UINT32 count = 0;
  FWPM_FILTER0** entries = nullptr;
  DWORD result = FwpmFilterCreateEnumHandle0(engine.get(), &filter_template,
                                             &enum_handle);
  if (result == ERROR_SUCCESS) {
    result = FwpmFilterEnum0(engine.get(), enum_handle, 100, &entries, &count);
    FwpmFilterDestroyEnumHandle0(engine.get(), enum_handle);
  }
  bool filters_valid = result == ERROR_SUCCESS && count == 8;
  for (UINT32 index = 0; filters_valid && index < count; ++index) {
    filters_valid =
        (entries[index]->flags & FWPM_FILTER_FLAG_PERSISTENT) != 0 &&
        entries[index]->providerKey != nullptr &&
        IsEqualGUID(*entries[index]->providerKey, kPersistentProvider) &&
        IsEqualGUID(entries[index]->subLayerKey, kPersistentSublayer);
  }
  if (entries != nullptr) {
    FwpmFreeMemory0(reinterpret_cast<void**>(&entries));
  }
  bool passed = provider_result == ERROR_SUCCESS &&
                sublayer_result == ERROR_SUCCESS &&
                (provider->flags & FWPM_PROVIDER_FLAG_PERSISTENT) != 0 &&
                (sublayer->flags & FWPM_SUBLAYER_FLAG_PERSISTENT) != 0 &&
                filters_valid;
  std::wcout << L"WFP_PERSISTENT_VERIFY "
             << (passed ? L"PASS" : L"FAIL") << L" filters=" << count
             << L"\n";
  return passed;
}

bool InstallPersistentFence(const std::wstring& user_name,
                            u_short allowed_v4_port,
                            u_short allowed_v6_port) {
  UniqueWfpEngine engine;
  if (!OpenPersistentEngine(&engine)) {
    return false;
  }
  if (FwpmTransactionBegin0(engine.get(), 0) != ERROR_SUCCESS) {
    return false;
  }
  FWPM_PROVIDER0 provider{};
  provider.providerKey = kPersistentProvider;
  provider.displayData.name =
      const_cast<wchar_t*>(L"CodeAtelier persistent WFP probe provider");
  provider.flags = FWPM_PROVIDER_FLAG_PERSISTENT;
  DWORD result = FwpmProviderAdd0(engine.get(), &provider, nullptr);
  if (result != ERROR_SUCCESS) {
    FwpmTransactionAbort0(engine.get());
    PrintFailure(L"FwpmProviderAdd0(persistent)", result);
    return false;
  }
  FWPM_SUBLAYER0 sublayer{};
  sublayer.subLayerKey = kPersistentSublayer;
  sublayer.displayData.name =
      const_cast<wchar_t*>(L"CodeAtelier persistent WFP probe sublayer");
  sublayer.flags = FWPM_SUBLAYER_FLAG_PERSISTENT;
  sublayer.providerKey = const_cast<GUID*>(&kPersistentProvider);
  sublayer.weight = 0x102;
  result = FwpmSubLayerAdd0(engine.get(), &sublayer, nullptr);
  if (result != ERROR_SUCCESS) {
    FwpmTransactionAbort0(engine.get());
    PrintFailure(L"FwpmSubLayerAdd0(persistent)", result);
    return false;
  }

  EXPLICIT_ACCESS_W access{};
  BuildExplicitAccessWithNameW(&access, const_cast<wchar_t*>(user_name.c_str()),
                               FWP_ACTRL_MATCH_FILTER, GRANT_ACCESS, 0);
  ULONG descriptor_size = 0;
  PSECURITY_DESCRIPTOR raw_descriptor = nullptr;
  result = BuildSecurityDescriptorW(nullptr, nullptr, 1, &access, 0, nullptr,
                                    nullptr, &descriptor_size,
                                    &raw_descriptor);
  LocalPointer descriptor(raw_descriptor);
  FWP_BYTE_BLOB descriptor_blob{descriptor_size,
                                static_cast<UINT8*>(raw_descriptor)};
  constexpr UINT8 kBlockWeight = 14;
  constexpr UINT32 kFlags = FWPM_FILTER_FLAG_PERSISTENT;
  bool added = result == ERROR_SUCCESS &&
      AddLoopbackUserPermit(engine.get(), kPersistentSublayer,
          FWPM_LAYER_ALE_AUTH_CONNECT_V4, &descriptor_blob, allowed_v4_port,
          false, L"CodeAtelier persistent IPv4 loopback permit", kFlags,
          &kPersistentProvider) &&
      AddUserFilter(engine.get(), kPersistentSublayer,
          FWPM_LAYER_ALE_AUTH_CONNECT_V4, &descriptor_blob, 0, false,
          kBlockWeight, FWP_ACTION_BLOCK, L"CodeAtelier persistent IPv4 block",
          kFlags, &kPersistentProvider) &&
      AddLoopbackUserPermit(engine.get(), kPersistentSublayer,
          FWPM_LAYER_ALE_AUTH_CONNECT_V6, &descriptor_blob, allowed_v6_port,
          true, L"CodeAtelier persistent IPv6 loopback permit", kFlags,
          &kPersistentProvider) &&
      AddUserFilter(engine.get(), kPersistentSublayer,
          FWPM_LAYER_ALE_AUTH_CONNECT_V6, &descriptor_blob, 0, false,
          kBlockWeight, FWP_ACTION_BLOCK, L"CodeAtelier persistent IPv6 block",
          kFlags, &kPersistentProvider) &&
      AddUserFilter(engine.get(), kPersistentSublayer,
          FWPM_LAYER_ALE_AUTH_LISTEN_V4, &descriptor_blob, 0, false,
          kBlockWeight, FWP_ACTION_BLOCK, L"CodeAtelier persistent IPv4 listen",
          kFlags, &kPersistentProvider) &&
      AddUserFilter(engine.get(), kPersistentSublayer,
          FWPM_LAYER_ALE_AUTH_LISTEN_V6, &descriptor_blob, 0, false,
          kBlockWeight, FWP_ACTION_BLOCK, L"CodeAtelier persistent IPv6 listen",
          kFlags, &kPersistentProvider) &&
      AddRawEndpointBlock(engine.get(), kPersistentSublayer,
          FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4, &descriptor_blob,
          L"CodeAtelier persistent IPv4 raw", kFlags, &kPersistentProvider) &&
      AddRawEndpointBlock(engine.get(), kPersistentSublayer,
          FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6, &descriptor_blob,
          L"CodeAtelier persistent IPv6 raw", kFlags, &kPersistentProvider);
  if (!added || FwpmTransactionCommit0(engine.get()) != ERROR_SUCCESS) {
    FwpmTransactionAbort0(engine.get());
    return false;
  }
  std::wcout << L"WFP_PERSISTENT_INSTALL PASS filters=8\n";
  return true;
}

bool PublishUserFencePorts(const std::filesystem::path& control_directory,
                           u_short allowed_v4_port, u_short denied_v4_port,
                           u_short allowed_v6_port, u_short denied_v6_port) {
  std::filesystem::path temporary = control_directory / L"ports.tmp";
  std::filesystem::path ready = control_directory / L"ports.ready";
  std::wofstream stream(temporary, std::ios::out | std::ios::trunc);
  if (!stream) {
    std::wcerr << L"FAIL create user fence ports file\n";
    return false;
  }
  stream << allowed_v4_port << L"\n"
         << denied_v4_port << L"\n"
         << allowed_v6_port << L"\n"
         << denied_v6_port << L"\n";
  stream.close();
  if (!stream.good()) {
    std::wcerr << L"FAIL write user fence ports file\n";
    return false;
  }
  if (!MoveFileExW(temporary.c_str(), ready.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    PrintFailure(L"publish user fence ports", GetLastError());
    return false;
  }
  return true;
}

bool WaitForUserFenceDone(const std::filesystem::path& control_directory) {
  std::filesystem::path done = control_directory / L"done.txt";
  constexpr DWORD kAttempts = 300;
  for (DWORD attempt = 0; attempt < kAttempts; ++attempt) {
    if (std::filesystem::exists(done)) {
      return true;
    }
    Sleep(100);
  }
  std::wcerr << L"FAIL timed out waiting for user fence completion\n";
  return false;
}

bool RunWfpUserController(const std::wstring& user_name,
                          const std::wstring& control_directory_text) {
  std::filesystem::path control_directory(control_directory_text);
  UniqueSocket allowed_v4_listener;
  UniqueSocket denied_v4_listener;
  UniqueSocket allowed_v6_listener;
  UniqueSocket denied_v6_listener;
  u_short allowed_v4_port = 0;
  u_short denied_v4_port = 0;
  u_short allowed_v6_port = 0;
  u_short denied_v6_port = 0;
  if (!StartLoopbackListener(AF_INET, &allowed_v4_listener,
                             &allowed_v4_port) ||
      !StartLoopbackListener(AF_INET, &denied_v4_listener, &denied_v4_port) ||
      !StartLoopbackListener(AF_INET6, &allowed_v6_listener,
                             &allowed_v6_port) ||
      !StartLoopbackListener(AF_INET6, &denied_v6_listener,
                             &denied_v6_port)) {
    PrintFailure(L"start user fence loopback listeners", WSAGetLastError());
    return false;
  }

  UniqueSocket allowed_v4_udp;
  UniqueSocket denied_v4_udp;
  UniqueSocket allowed_v6_udp;
  UniqueSocket denied_v6_udp;
  if (!StartUdpEchoSocket(AF_INET, allowed_v4_port, &allowed_v4_udp) ||
      !StartUdpEchoSocket(AF_INET, denied_v4_port, &denied_v4_udp) ||
      !StartUdpEchoSocket(AF_INET6, allowed_v6_port, &allowed_v6_udp) ||
      !StartUdpEchoSocket(AF_INET6, denied_v6_port, &denied_v6_udp)) {
    PrintFailure(L"start user fence UDP echo sockets", WSAGetLastError());
    WSACleanup();
    return false;
  }

  UniqueWfpEngine engine;
  if (!InstallDynamicUserFence(user_name, allowed_v4_port, allowed_v6_port,
                               &engine)) {
    WSACleanup();
    return false;
  }

  std::atomic_bool stop_udp = false;
  std::array<std::thread, 4> udp_threads = {
      std::thread(RunUdpEchoLoop, allowed_v4_udp.get(), &stop_udp),
      std::thread(RunUdpEchoLoop, denied_v4_udp.get(), &stop_udp),
      std::thread(RunUdpEchoLoop, allowed_v6_udp.get(), &stop_udp),
      std::thread(RunUdpEchoLoop, denied_v6_udp.get(), &stop_udp)};
  if (!PublishUserFencePorts(control_directory, allowed_v4_port,
                             denied_v4_port, allowed_v6_port,
                             denied_v6_port)) {
    stop_udp.store(true);
    for (std::thread& thread : udp_threads) {
      thread.join();
    }
    WSACleanup();
    return false;
  }
  std::wcout << L"WFP_USER_CONTROLLER READY user=" << user_name
             << L" allowedV4Port=" << allowed_v4_port
             << L" deniedV4Port=" << denied_v4_port
             << L" allowedV6Port=" << allowed_v6_port
             << L" deniedV6Port=" << denied_v6_port << L"\n";
  bool completed = WaitForUserFenceDone(control_directory);
  stop_udp.store(true);
  for (std::thread& thread : udp_threads) {
    thread.join();
  }
  std::wcout << L"WFP_USER_CONTROLLER "
             << (completed ? L"PASS" : L"FAIL") << L"\n";
  WSACleanup();
  return completed;
}

bool RunWfpProbe() {
  std::wstring image = CurrentExecutablePath();
  UniqueSocket listener;
  u_short port = 0;
  if (image.empty() ||
      !StartLoopbackListener(AF_INET, &listener, &port)) {
    PrintFailure(L"start loopback listener", WSAGetLastError());
    return false;
  }

  bool baseline = LaunchNetworkClient(image, port, 0);
  UniqueWfpEngine engine;
  if (!baseline || !InstallDynamicAppIdBlock(image, port, &engine)) {
    std::wcout << L"WFP_DEMO UNSUPPORTED baseline="
               << (baseline ? L"pass" : L"fail")
               << L" reason=filter-install-failed\n";
    WSACleanup();
    return false;
  }

  bool target_blocked =
      LaunchNetworkClient(image, port, kNetworkBlockedExitCode);
  bool same_image_sibling_blocked =
      LaunchNetworkClient(image, port, kNetworkBlockedExitCode);

  std::filesystem::path copied_image =
      std::filesystem::path(image).parent_path() / L"network_ipc_demo_copy.exe";
  std::error_code copy_error;
  std::filesystem::copy_file(image, copied_image,
                             std::filesystem::copy_options::overwrite_existing,
                             copy_error);
  bool copied_image_allowed =
      !copy_error && LaunchNetworkClient(copied_image.wstring(), port, 0);
  std::error_code remove_error;
  std::filesystem::remove(copied_image, remove_error);

  bool passed = target_blocked && same_image_sibling_blocked &&
                copied_image_allowed;
  std::wcout << L"WFP_DEMO " << (passed ? L"PASS" : L"FAIL")
             << L" scope=app-id-not-process-instance"
             << L" targetBlocked=" << (target_blocked ? L"yes" : L"no")
             << L" sameImageSiblingBlocked="
             << (same_image_sibling_blocked ? L"yes" : L"no")
             << L" copiedImageAllowed="
             << (copied_image_allowed ? L"yes" : L"no") << L"\n";
  WSACleanup();
  return passed;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 5 && std::wstring(argv[1]) == L"--ipc-client") {
    return RunIpcClient(argv[2], argv[3], argv[4]);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--network-client") {
    return RunNetworkClient(AF_INET, argv[2]);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--network-client-v6") {
    return RunNetworkClient(AF_INET6, argv[2]);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--udp-client") {
    return RunDatagramClient(AF_INET, argv[2], false);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--udp-client-v6") {
    return RunDatagramClient(AF_INET6, argv[2], false);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--external-client") {
    return RunExternalTcpClient(AF_INET, argv[2]);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--external-client-v6") {
    return RunExternalTcpClient(AF_INET6, argv[2]);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--dns-client") {
    return RunDatagramClient(AF_INET, argv[2], true);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--dns-client-v6") {
    return RunDatagramClient(AF_INET6, argv[2], true);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--listen-probe") {
    return RunListenProbe(AF_INET);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--listen-probe-v6") {
    return RunListenProbe(AF_INET6);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--raw-probe") {
    return RunRawProbe(AF_INET);
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--raw-probe-v6") {
    return RunRawProbe(AF_INET6);
  }
  if (argc == 4 && std::wstring(argv[1]) == L"--network-descendant") {
    return RunNetworkDescendant(argv[2], argv[3]);
  }
  if (argc == 4 &&
      std::wstring(argv[1]) == L"--restricted-network-launch") {
    return RunRestrictedNetworkLauncher(argv[2], argv[3]);
  }
  if (argc == 2 && std::wstring(argv[1]) == L"--ipc") {
    return RunIpcProbe() ? 0 : 1;
  }
  if (argc == 2 && std::wstring(argv[1]) == L"--wfp") {
    return RunWfpProbe() ? 0 : 1;
  }
  if (argc == 4 && std::wstring(argv[1]) == L"--wfp-user-controller") {
    return RunWfpUserController(argv[2], argv[3]) ? 0 : 1;
  }
  if (argc == 5 && std::wstring(argv[1]) == L"--wfp-persistent-install") {
    return InstallPersistentFence(argv[2],
                                  static_cast<u_short>(std::stoul(argv[3])),
                                  static_cast<u_short>(std::stoul(argv[4])))
               ? 0
               : 1;
  }
  if (argc == 2 && std::wstring(argv[1]) == L"--wfp-persistent-verify") {
    return VerifyPersistentFence() ? 0 : 1;
  }
  if (argc == 2 && std::wstring(argv[1]) == L"--wfp-persistent-remove") {
    return RemovePersistentFence() ? 0 : 1;
  }

  std::wcerr << L"usage: network_ipc_demo.exe --ipc | --wfp | "
                L"--network-client[-v6] <port> | "
                L"--restricted-network-launch <client-mode> <port> | "
                L"--wfp-user-controller <user> <control-directory>\n";
  return 2;
}
