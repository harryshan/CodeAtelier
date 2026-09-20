/**
 * 实现 CodeAtelier Windows Sandbox 的单实例 C++ supervisor 与专用账户 bootstrap。
 * TypeScript Broker 只以固定 argv 启动 self-check/execute，执行请求通过继承 stdin 的有界二进制帧传入；
 * supervisor 使用 DPAPI state、工作区 ACL、Job 和私有 Named Pipe 启动同一二进制的 bootstrap 模式。
 *
 * 1. self-check 核对 state 所属宿主 SID、专用账户 SID/密码、WFP 持久规则和原生二进制存在性。
 * 2. execute 生成 execution/root capability SID，向已打开的工作区原对象安装账户与 capability ACE。
 * 3. CreateProcessWithLogonW 以固定 bootstrap 入口启动专用账户进程，先分配 KILL_ON_JOB_CLOSE Job 再恢复。
 * 4. bootstrap 通过只允许宿主/SYSTEM/专用账户且核对 PID 的 Named Pipe 取得命令，创建 WRITE_RESTRICTED token 后启动真实工具。
 * 5. Broker stdin 关闭、超时或异常会终止 Job；正常/异常退出都按唯一 SID 撤销本次 ACE，清理不确定返回专用错误码。
 * 6. stdout 只承载工具 stdout/stderr；stderr 只输出有界控制记录，不记录命令、路径、SID、密码或工具内容。
 *
 * restricted token、default DACL、Job 和 capability SID 的底层算法复用已验证探针源；通过宏重命名其 wmain，
 * 探针入口不会暴露在产品二进制的顶层命令分派中。该 supervisor 不提升权限，也不创建账户或 WFP 规则。
 */

#define wmain CodeAtelierRestrictedProbeMain
#include "../../experiments/windows-restricted-token-demo/restricted_token_demo.cpp"
#undef wmain

#include <wincrypt.h>

#include <atomic>
#include <map>
#include <sstream>

namespace {

constexpr uint32_t kRequestMagic = 0x42534143;
constexpr uint32_t kRequestVersion = 1;
constexpr DWORD kCleanupFailureExitCode = 70;
constexpr DWORD kSelfCheckFailureExitCode = 71;
constexpr DWORD kProtocolFailureExitCode = 72;
constexpr size_t kMaximumStringBytes = 64 * 1024;
constexpr uint32_t kMaximumArguments = 64;
constexpr char kDpapiEntropy[] = "CodeAtelier.WindowsSandbox.Secret.v1";

struct ProductRequest {
  std::wstring execution_instance_id;
  std::wstring working_directory;
  std::wstring executable;
  std::vector<std::wstring> arguments;
  std::wstring private_directory;
  DWORD timeout_ms = 0;
};

struct InstallationState {
  std::wstring account_name;
  std::wstring account_sid;
  std::wstring generation_id;
  std::wstring protected_password;
  std::wstring installed_by_sid;
};

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) {
    return L"";
  }
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                  static_cast<int>(value.size()), nullptr, 0);
  if (count <= 0) {
    return L"";
  }
  std::wstring result(static_cast<size_t>(count), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), count) !=
      count) {
    return L"";
  }
  return result;
}

std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) {
    return "";
  }
  int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                  static_cast<int>(value.size()), nullptr, 0,
                                  nullptr, nullptr);
  if (count <= 0) {
    return "";
  }
  std::string result(static_cast<size_t>(count), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), count,
                          nullptr, nullptr) != count) {
    return "";
  }
  return result;
}

bool ReadExact(HANDLE handle, void* output, DWORD size) {
  BYTE* cursor = static_cast<BYTE*>(output);
  DWORD remaining = size;
  while (remaining > 0) {
    DWORD read = 0;
    if (!ReadFile(handle, cursor, remaining, &read, nullptr) || read == 0) {
      return false;
    }
    cursor += read;
    remaining -= read;
  }
  return true;
}

bool WriteExact(HANDLE handle, const void* input, DWORD size) {
  const BYTE* cursor = static_cast<const BYTE*>(input);
  DWORD remaining = size;
  while (remaining > 0) {
    DWORD written = 0;
    if (!WriteFile(handle, cursor, remaining, &written, nullptr) ||
        written == 0) {
      return false;
    }
    cursor += written;
    remaining -= written;
  }
  return true;
}

bool ReadFramedString(HANDLE handle, std::wstring* output) {
  uint32_t size = 0;
  if (!ReadExact(handle, &size, sizeof(size)) || size > kMaximumStringBytes) {
    return false;
  }
  std::string utf8(size, '\0');
  if (size > 0 && !ReadExact(handle, utf8.data(), size)) {
    return false;
  }
  *output = Utf8ToWide(utf8);
  return size == 0 || !output->empty();
}

bool WriteFramedString(HANDLE handle, const std::wstring& value) {
  std::string utf8 = WideToUtf8(value);
  if (utf8.size() > kMaximumStringBytes) {
    return false;
  }
  uint32_t size = static_cast<uint32_t>(utf8.size());
  return WriteExact(handle, &size, sizeof(size)) &&
         (size == 0 || WriteExact(handle, utf8.data(), size));
}

bool ReadProductRequest(HANDLE handle, ProductRequest* request) {
  uint32_t magic = 0;
  uint32_t version = 0;
  uint32_t argument_count = 0;
  if (!ReadExact(handle, &magic, sizeof(magic)) ||
      !ReadExact(handle, &version, sizeof(version)) ||
      magic != kRequestMagic || version != kRequestVersion ||
      !ReadFramedString(handle, &request->execution_instance_id) ||
      !ReadFramedString(handle, &request->working_directory) ||
      !ReadFramedString(handle, &request->executable) ||
      !ReadFramedString(handle, &request->private_directory) ||
      !ReadExact(handle, &request->timeout_ms, sizeof(request->timeout_ms)) ||
      !ReadExact(handle, &argument_count, sizeof(argument_count)) ||
      argument_count > kMaximumArguments) {
    return false;
  }
  request->arguments.clear();
  for (uint32_t index = 0; index < argument_count; ++index) {
    std::wstring argument;
    if (!ReadFramedString(handle, &argument)) {
      return false;
    }
    request->arguments.push_back(std::move(argument));
  }
  return !request->execution_instance_id.empty() &&
         !request->working_directory.empty() && !request->executable.empty() &&
         !request->private_directory.empty() && request->timeout_ms > 0;
}

bool WriteProductRequest(HANDLE handle, const ProductRequest& request) {
  uint32_t argument_count = static_cast<uint32_t>(request.arguments.size());
  if (!WriteExact(handle, &kRequestMagic, sizeof(kRequestMagic)) ||
      !WriteExact(handle, &kRequestVersion, sizeof(kRequestVersion)) ||
      !WriteFramedString(handle, request.execution_instance_id) ||
      !WriteFramedString(handle, request.working_directory) ||
      !WriteFramedString(handle, request.executable) ||
      !WriteFramedString(handle, request.private_directory) ||
      !WriteExact(handle, &request.timeout_ms, sizeof(request.timeout_ms)) ||
      !WriteExact(handle, &argument_count, sizeof(argument_count))) {
    return false;
  }
  for (const std::wstring& argument : request.arguments) {
    if (!WriteFramedString(handle, argument)) {
      return false;
    }
  }
  return true;
}

std::wstring Trim(const std::wstring& value) {
  size_t first = value.find_first_not_of(L" \t\r\n");
  if (first == std::wstring::npos) {
    return L"";
  }
  size_t last = value.find_last_not_of(L" \t\r\n");
  return value.substr(first, last - first + 1);
}

bool ReadInstallationState(const std::wstring& state_path,
                           InstallationState* state) {
  std::wifstream stream(state_path);
  if (!stream) {
    return false;
  }
  std::map<std::wstring, std::wstring> values;
  std::wstring line;
  while (std::getline(stream, line)) {
    size_t separator = line.find(L'=');
    if (separator == std::wstring::npos) {
      return false;
    }
    std::wstring key = Trim(line.substr(0, separator));
    std::wstring value = Trim(line.substr(separator + 1));
    if (key.empty() || values.contains(key)) {
      return false;
    }
    values.emplace(std::move(key), std::move(value));
  }
  if (values[L"version"] != L"1") {
    return false;
  }
  state->account_name = values[L"accountName"];
  state->account_sid = values[L"accountSid"];
  state->generation_id = values[L"generationId"];
  state->protected_password = values[L"protectedPassword"];
  state->installed_by_sid = values[L"installedBySid"];
  return !state->account_name.empty() && !state->account_sid.empty() &&
         !state->generation_id.empty() && !state->protected_password.empty() &&
         !state->installed_by_sid.empty();
}

std::wstring CurrentUserSidString() {
  UniqueHandle token;
  if (!QueryCurrentToken(&token)) {
    return L"";
  }
  DWORD size = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &size);
  std::vector<BYTE> buffer(size);
  if (size == 0 || !GetTokenInformation(token.get(), TokenUser, buffer.data(),
                                         size, &size)) {
    return L"";
  }
  return SidToString(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid);
}

bool LookupAccountSid(const std::wstring& account_name,
                      std::vector<BYTE>* sid) {
  DWORD sid_size = 0;
  DWORD domain_size = 0;
  SID_NAME_USE use{};
  LookupAccountNameW(nullptr, account_name.c_str(), nullptr, &sid_size, nullptr,
                     &domain_size, &use);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || sid_size == 0) {
    return false;
  }
  sid->resize(sid_size);
  std::vector<wchar_t> domain(domain_size);
  return LookupAccountNameW(nullptr, account_name.c_str(), sid->data(),
                            &sid_size, domain.data(), &domain_size, &use) !=
         FALSE;
}

bool UnprotectPassword(const std::wstring& encoded, std::wstring* password) {
  DWORD protected_size = 0;
  if (!CryptStringToBinaryW(encoded.c_str(), 0, CRYPT_STRING_BASE64, nullptr,
                            &protected_size, nullptr, nullptr) ||
      protected_size == 0) {
    return false;
  }
  std::vector<BYTE> protected_bytes(protected_size);
  if (!CryptStringToBinaryW(encoded.c_str(), 0, CRYPT_STRING_BASE64,
                            protected_bytes.data(), &protected_size, nullptr,
                            nullptr)) {
    return false;
  }
  DATA_BLOB input{protected_size, protected_bytes.data()};
  DATA_BLOB entropy{static_cast<DWORD>(sizeof(kDpapiEntropy) - sizeof(char)),
                    reinterpret_cast<BYTE*>(const_cast<char*>(kDpapiEntropy))};
  DATA_BLOB output{};
  if (!CryptUnprotectData(&input, nullptr, &entropy, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &output)) {
    SecureZeroMemory(protected_bytes.data(), protected_bytes.size());
    return false;
  }
  LocalPointer owned_output(output.pbData);
  if (output.cbData == 0 || output.cbData % sizeof(wchar_t) != 0) {
    SecureZeroMemory(output.pbData, output.cbData);
    return false;
  }
  password->assign(reinterpret_cast<wchar_t*>(output.pbData),
                   output.cbData / sizeof(wchar_t));
  SecureZeroMemory(output.pbData, output.cbData);
  SecureZeroMemory(protected_bytes.data(), protected_bytes.size());
  return !password->empty();
}

bool RunFixedProcess(const std::wstring& executable,
                     const std::wstring& argument) {
  std::wstring command_line = QuoteArgument(executable) + L" " + argument;
  std::vector<wchar_t> mutable_command(command_line.begin(),
                                       command_line.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  SECURITY_ATTRIBUTES inherit_output{};
  inherit_output.nLength = sizeof(inherit_output);
  inherit_output.bInheritHandle = TRUE;
  UniqueHandle null_output(CreateFileW(
      L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      &inherit_output, OPEN_EXISTING, 0, nullptr));
  if (!null_output) {
    return false;
  }
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = null_output.get();
  startup.hStdError = null_output.get();
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable.c_str(), mutable_command.data(), nullptr,
                      nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr,
                      &startup, &process)) {
    return false;
  }
  UniqueHandle process_handle(process.hProcess);
  UniqueHandle thread_handle(process.hThread);
  if (WaitForSingleObject(process_handle.get(), 15000) != WAIT_OBJECT_0) {
    TerminateProcess(process_handle.get(), 1);
    return false;
  }
  DWORD exit_code = 1;
  return GetExitCodeProcess(process_handle.get(), &exit_code) && exit_code == 0;
}

bool VerifyInstallation(const InstallationState& state,
                        const std::wstring& network_manager,
                        std::wstring* password) {
  if (CurrentUserSidString() != state.installed_by_sid ||
      !std::filesystem::is_regular_file(network_manager)) {
    return false;
  }
  std::vector<BYTE> account_sid;
  if (!LookupAccountSid(state.account_name, &account_sid) ||
      SidToString(account_sid.data()) != state.account_sid ||
      !UnprotectPassword(state.protected_password, password)) {
    return false;
  }
  UniqueHandle logon_token;
  HANDLE raw_token = nullptr;
  if (!LogonUserW(state.account_name.c_str(), L".", password->c_str(),
                  LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT,
                  &raw_token)) {
    SecureZeroMemory(password->data(), password->size() * sizeof(wchar_t));
    password->clear();
    return false;
  }
  logon_token.reset(raw_token);
  return RunFixedProcess(network_manager, L"--wfp-persistent-verify");
}

class WorkspaceGrant {
 public:
  bool Install(const std::wstring& directory, PSID account_sid,
               PSID capability_sid) {
    handle_.reset(CreateFileW(
        directory.c_str(), READ_CONTROL | WRITE_DAC,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!handle_) {
      return false;
    }
    BY_HANDLE_FILE_INFORMATION information{};
    if (!GetFileInformationByHandle(handle_.get(), &information) ||
        (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        (information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      return false;
    }

    PACL old_acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD result = GetSecurityInfo(handle_.get(), SE_FILE_OBJECT,
                                   DACL_SECURITY_INFORMATION, nullptr, nullptr,
                                   &old_acl, nullptr, &descriptor);
    LocalPointer owned_descriptor(descriptor);
    if (result != ERROR_SUCCESS || HasExplicitSid(old_acl, account_sid) ||
        HasExplicitSid(old_acl, capability_sid)) {
      return false;
    }

    std::array<EXPLICIT_ACCESSW, 2> entries{};
    std::array<PSID, 2> sids = {account_sid, capability_sid};
    for (size_t index = 0; index < entries.size(); ++index) {
      entries[index].grfAccessPermissions =
          FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
      entries[index].grfAccessMode = GRANT_ACCESS;
      entries[index].grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
      entries[index].Trustee.TrusteeForm = TRUSTEE_IS_SID;
      entries[index].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
      entries[index].Trustee.ptstrName = static_cast<LPWSTR>(sids[index]);
    }
    PACL new_acl = nullptr;
    result = SetEntriesInAclW(static_cast<ULONG>(entries.size()), entries.data(),
                              old_acl, &new_acl);
    LocalPointer owned_acl(new_acl);
    if (result != ERROR_SUCCESS ||
        SetSecurityInfo(handle_.get(), SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION, nullptr, nullptr, new_acl,
                        nullptr) != ERROR_SUCCESS) {
      return false;
    }
    account_sid_.resize(GetLengthSid(account_sid));
    capability_sid_.resize(GetLengthSid(capability_sid));
    return CopySid(static_cast<DWORD>(account_sid_.size()), account_sid_.data(),
                   account_sid) &&
           CopySid(static_cast<DWORD>(capability_sid_.size()),
                   capability_sid_.data(), capability_sid);
  }

  bool Revoke() {
    if (!handle_) {
      return true;
    }
    PACL current_acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD result = GetSecurityInfo(handle_.get(), SE_FILE_OBJECT,
                                   DACL_SECURITY_INFORMATION, nullptr, nullptr,
                                   &current_acl, nullptr, &descriptor);
    LocalPointer owned_descriptor(descriptor);
    if (result != ERROR_SUCCESS) {
      return false;
    }
    std::array<EXPLICIT_ACCESSW, 2> entries{};
    std::array<PSID, 2> sids = {account_sid_.data(), capability_sid_.data()};
    for (size_t index = 0; index < entries.size(); ++index) {
      entries[index].grfAccessMode = REVOKE_ACCESS;
      entries[index].grfInheritance = NO_INHERITANCE;
      entries[index].Trustee.TrusteeForm = TRUSTEE_IS_SID;
      entries[index].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
      entries[index].Trustee.ptstrName = static_cast<LPWSTR>(sids[index]);
    }
    PACL new_acl = nullptr;
    result = SetEntriesInAclW(static_cast<ULONG>(entries.size()), entries.data(),
                              current_acl, &new_acl);
    LocalPointer owned_acl(new_acl);
    return result == ERROR_SUCCESS &&
           SetSecurityInfo(handle_.get(), SE_FILE_OBJECT,
                           DACL_SECURITY_INFORMATION, nullptr, nullptr, new_acl,
                           nullptr) == ERROR_SUCCESS;
  }

 private:
  static bool HasExplicitSid(PACL acl, PSID sid) {
    if (acl == nullptr) {
      return true;
    }
    ULONG count = 0;
    PEXPLICIT_ACCESSW entries = nullptr;
    DWORD result = GetExplicitEntriesFromAclW(acl, &count, &entries);
    LocalPointer owned_entries(entries);
    if (result != ERROR_SUCCESS) {
      return true;
    }
    for (ULONG index = 0; index < count; ++index) {
      if (entries[index].Trustee.TrusteeForm == TRUSTEE_IS_SID &&
          EqualSid(entries[index].Trustee.ptstrName, sid)) {
        return true;
      }
    }
    return false;
  }

  UniqueHandle handle_;
  std::vector<BYTE> account_sid_;
  std::vector<BYTE> capability_sid_;
};

bool BuildPipeSecurity(PSID account_sid, SECURITY_ATTRIBUTES* attributes,
                       LocalPointer* descriptor) {
  std::wstring current_sid = CurrentUserSidString();
  std::wstring account_sid_text = SidToString(account_sid);
  std::wstring sddl = L"D:P(A;;GA;;;SY)(A;;GA;;;" + current_sid +
                      L")(A;;GA;;;" + account_sid_text + L")";
  PSECURITY_DESCRIPTOR raw = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl.c_str(), SDDL_REVISION_1, &raw, nullptr)) {
    return false;
  }
  descriptor->reset(raw);
  attributes->nLength = sizeof(*attributes);
  attributes->lpSecurityDescriptor = raw;
  attributes->bInheritHandle = FALSE;
  return true;
}

std::wstring MakeProductPipeName() {
  GUID identifier{};
  if (CoCreateGuid(&identifier) != S_OK) {
    return L"";
  }
  wchar_t text[40]{};
  if (StringFromGUID2(identifier, text, static_cast<int>(std::size(text))) ==
      0) {
    return L"";
  }
  return L"\\\\.\\pipe\\CodeAtelierSandbox-" + std::wstring(text);
}

std::wstring BuildCommandLine(const std::wstring& executable,
                              const std::vector<std::wstring>& arguments) {
  std::wstring command_line = QuoteArgument(executable);
  for (const std::wstring& argument : arguments) {
    command_line += L" " + QuoteArgument(argument);
  }
  return command_line;
}

bool SetPrivateEnvironment(const std::wstring& private_directory) {
  std::array<const wchar_t*, 5> names = {L"HOME", L"USERPROFILE",
                                          L"XDG_CONFIG_HOME", L"TEMP",
                                          L"TMP"};
  for (const wchar_t* name : names) {
    if (!SetEnvironmentVariableW(name, private_directory.c_str())) {
      return false;
    }
  }
  SetEnvironmentVariableW(L"CODEATELIER_API_KEY", nullptr);
  SetEnvironmentVariableW(L"OPENAI_API_KEY", nullptr);
  SetEnvironmentVariableW(L"GITHUB_TOKEN", nullptr);
  return true;
}

int RunProductBootstrap(const std::wstring& pipe_name,
                        const std::wstring& execution_sid_text,
                        const std::wstring& capability_sid_text) {
  PSID raw_execution_sid = nullptr;
  PSID raw_capability_sid = nullptr;
  if (!ConvertStringSidToSidW(execution_sid_text.c_str(), &raw_execution_sid) ||
      !ConvertStringSidToSidW(capability_sid_text.c_str(),
                              &raw_capability_sid)) {
    return 21;
  }
  LocalPointer execution_sid(raw_execution_sid);
  LocalPointer capability_sid(raw_capability_sid);
  if (!WaitNamedPipeW(pipe_name.c_str(), 10000)) {
    return 22;
  }
  UniqueHandle pipe(CreateFileW(pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE,
                                0, nullptr, OPEN_EXISTING, 0, nullptr));
  if (!pipe) {
    return 23;
  }
  ProductRequest request;
  if (!ReadProductRequest(pipe.get(), &request) ||
      !SetPrivateEnvironment(request.private_directory)) {
    return 24;
  }
  UniqueHandle restricted_token;
  if (!CreateRestrictedPrimaryToken(execution_sid.get(), capability_sid.get(),
                                    &restricted_token)) {
    return 25;
  }
  std::wstring command_line =
      BuildCommandLine(request.executable, request.arguments);
  std::vector<wchar_t> mutable_command(command_line.begin(),
                                       command_line.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_OUTPUT_HANDLE);
  PROCESS_INFORMATION process{};
  if (!CreateProcessAsUserW(
          restricted_token.get(), request.executable.c_str(),
          mutable_command.data(), nullptr, nullptr, TRUE,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, nullptr,
          request.working_directory.c_str(), &startup, &process)) {
    return 26;
  }
  UniqueHandle process_handle(process.hProcess);
  UniqueHandle thread_handle(process.hThread);
  std::wcerr << L"CODEATELIER_RUNTIME_STARTED pid=" << process.dwProcessId
             << L"\n";
  std::wcerr.flush();
  if (ResumeThread(thread_handle.get()) == static_cast<DWORD>(-1)) {
    TerminateProcess(process_handle.get(), 27);
    return 27;
  }
  DWORD wait = WaitForSingleObject(process_handle.get(), request.timeout_ms);
  if (wait != WAIT_OBJECT_0) {
    TerminateProcess(process_handle.get(), 28);
    WaitForSingleObject(process_handle.get(), 5000);
    return 28;
  }
  DWORD exit_code = 1;
  if (!GetExitCodeProcess(process_handle.get(), &exit_code)) {
    return 29;
  }
  return static_cast<int>(exit_code & 0xff);
}

bool ConnectAndSendRequest(HANDLE pipe, DWORD expected_pid,
                           const ProductRequest& request) {
  if (!ConnectNamedPipe(pipe, nullptr) &&
      GetLastError() != ERROR_PIPE_CONNECTED) {
    return false;
  }
  ULONG client_pid = 0;
  return GetNamedPipeClientProcessId(pipe, &client_pid) &&
         client_pid == expected_pid && WriteProductRequest(pipe, request);
}

int RunProductSupervisor(const std::wstring& state_path,
                         const std::wstring& network_manager) {
  ProductRequest request;
  if (!ReadProductRequest(GetStdHandle(STD_INPUT_HANDLE), &request)) {
    std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=protocol\n";
    return kProtocolFailureExitCode;
  }
  InstallationState state;
  std::wstring password;
  if (!ReadInstallationState(state_path, &state) ||
      !VerifyInstallation(state, network_manager, &password)) {
    std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=self_check\n";
    return kSelfCheckFailureExitCode;
  }
  std::vector<BYTE> account_sid;
  SidPointer execution_sid = CreateCapabilitySid();
  SidPointer capability_sid = CreateCapabilitySid();
  if (!LookupAccountSid(state.account_name, &account_sid) || !execution_sid ||
      !capability_sid) {
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return kSelfCheckFailureExitCode;
  }

  WorkspaceGrant workspace_grant;
  WorkspaceGrant private_grant;
  if (!workspace_grant.Install(request.working_directory, account_sid.data(),
                               capability_sid.get()) ||
      !private_grant.Install(request.private_directory, account_sid.data(),
                             capability_sid.get())) {
    workspace_grant.Revoke();
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=manifest\n";
    return kSelfCheckFailureExitCode;
  }

  SECURITY_ATTRIBUTES pipe_security{};
  LocalPointer pipe_descriptor;
  std::wstring pipe_name = MakeProductPipeName();
  if (pipe_name.empty() ||
      !BuildPipeSecurity(account_sid.data(), &pipe_security, &pipe_descriptor)) {
    private_grant.Revoke();
    workspace_grant.Revoke();
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return kSelfCheckFailureExitCode;
  }
  UniqueHandle pipe(CreateNamedPipeW(
      pipe_name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
          PIPE_REJECT_REMOTE_CLIENTS,
      1, 64 * 1024, 64 * 1024, 5000, &pipe_security));
  if (!pipe) {
    private_grant.Revoke();
    workspace_grant.Revoke();
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return kSelfCheckFailureExitCode;
  }

  PrivateObjectSecurity object_security;
  UniqueHandle job;
  if (!object_security.Initialize(execution_sid.get()) ||
      !ConfigureJob(object_security.attributes(), L"", &job)) {
    private_grant.Revoke();
    workspace_grant.Revoke();
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return kSelfCheckFailureExitCode;
  }

  std::wstring executable = CurrentExecutablePath();
  std::vector<std::wstring> bootstrap_arguments = {
      L"--bootstrap", pipe_name, SidToString(execution_sid.get()),
      SidToString(capability_sid.get())};
  std::wstring command_line =
      BuildCommandLine(executable, bootstrap_arguments);
  std::vector<wchar_t> mutable_command(command_line.begin(),
                                       command_line.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
  startup.wShowWindow = SW_HIDE;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION bootstrap{};
  BOOL created = CreateProcessWithLogonW(
      state.account_name.c_str(), L".", password.c_str(), 0,
      executable.c_str(), mutable_command.data(),
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, nullptr,
      request.working_directory.c_str(), &startup, &bootstrap);
  SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
  password.clear();
  if (!created) {
    private_grant.Revoke();
    workspace_grant.Revoke();
    std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=launch\n";
    return kSelfCheckFailureExitCode;
  }
  UniqueHandle bootstrap_process(bootstrap.hProcess);
  UniqueHandle bootstrap_thread(bootstrap.hThread);
  if (!AssignProcessToJobObject(job.get(), bootstrap_process.get()) ||
      ResumeThread(bootstrap_thread.get()) == static_cast<DWORD>(-1) ||
      !ConnectAndSendRequest(pipe.get(), bootstrap.dwProcessId, request)) {
    TerminateJobObject(job.get(), kSelfCheckFailureExitCode);
    WaitForSingleObject(bootstrap_process.get(), 5000);
    bool clean = private_grant.Revoke() && workspace_grant.Revoke();
    return clean ? kSelfCheckFailureExitCode : kCleanupFailureExitCode;
  }

  auto cancelled = std::make_shared<std::atomic_bool>(false);
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE job_handle = job.get();
  std::thread([input, job_handle, cancelled]() {
    BYTE cancel_byte = 0;
    DWORD read = 0;
    if (!ReadFile(input, &cancel_byte, 1, &read, nullptr) || read == 0) {
      cancelled->store(true);
      TerminateJobObject(job_handle, 30);
    }
  }).detach();

  DWORD wait =
      WaitForSingleObject(bootstrap_process.get(), request.timeout_ms + 10000);
  if (wait != WAIT_OBJECT_0) {
    TerminateJobObject(job.get(), 31);
    WaitForSingleObject(bootstrap_process.get(), 5000);
  }
  DWORD exit_code = 1;
  GetExitCodeProcess(bootstrap_process.get(), &exit_code);
  bool clean = private_grant.Revoke() && workspace_grant.Revoke();
  if (!clean) {
    std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=cleanup\n";
    return kCleanupFailureExitCode;
  }
  std::wcerr << L"CODEATELIER_SUPERVISOR_COMPLETE cancelled="
             << (cancelled->load() ? L"true" : L"false") << L"\n";
  return static_cast<int>(exit_code & 0xff);
}

int RunProductSelfCheck(const std::wstring& state_path,
                        const std::wstring& network_manager) {
  InstallationState state;
  std::wstring password;
  bool valid = ReadInstallationState(state_path, &state) &&
               VerifyInstallation(state, network_manager, &password);
  SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
  if (!valid) {
    std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=self_check\n";
    return kSelfCheckFailureExitCode;
  }
  std::wcout << L"CODEATELIER_SELF_CHECK_OK generation=" << state.generation_id
             << L"\n";
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc == 4 && std::wstring(argv[1]) == L"--self-check") {
    return RunProductSelfCheck(argv[2], argv[3]);
  }
  if (argc == 4 && std::wstring(argv[1]) == L"--execute") {
    return RunProductSupervisor(argv[2], argv[3]);
  }
  if (argc == 5 && std::wstring(argv[1]) == L"--bootstrap") {
    return RunProductBootstrap(argv[2], argv[3], argv[4]);
  }
  std::wcerr
      << L"CodeAtelier Sandbox supervisor accepts only fixed product modes.\n";
  return kProtocolFailureExitCode;
}
