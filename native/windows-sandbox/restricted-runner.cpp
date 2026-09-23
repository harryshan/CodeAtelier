/**
 * 实现 CodeAtelier Windows Sandbox 的单实例 C++ supervisor 与专用账户 bootstrap。
 * TypeScript Broker 只以固定 argv 启动 self-check/execute/launch-agent-runtime，请求通过继承 stdin 的有界二进制帧传入；
 * supervisor 使用 DPAPI state、工作区 ACL、Job 和私有 Named Pipe 启动同一二进制的 bootstrap 模式，并代理 Agent Runtime IPC。
 *
 * 1. self-check 核对 state 所属宿主 SID、专用账户 SID/密码、拒绝登录权、WFP 持久规则，以及受保护 Node 24/Agent Runtime entry 和各 Worker bundle 摘要。
 * 2. execute 生成 execution/root capability SID；共享账户 ACE 始终提供 normal-side 读写候选权限，每实例 capability ACE 再决定 WRITE_RESTRICTED token 实际可写的根。
 * 3. CreateProcessWithLogonW 以固定 bootstrap 入口启动专用账户进程，先分配 KILL_ON_JOB_CLOSE Job 再恢复。
 * 4. bootstrap 使用专用账户自身的全新环境块，通过只允许宿主/SYSTEM/专用账户且核对 PID 的 Named Pipe 取得命令，创建 WRITE_RESTRICTED token 后启动真实工具。
 * 5. Broker stdin 关闭、超时或异常会终止 Job；正常/异常退出撤销本实例 capability ACE，共享账户 ACE 仅由 Broker 最后引用的两阶段 release 撤销，清理不确定返回专用错误码。
 * 6. Push Runner 仅从宿主 Credential Manager 读取绑定 host 的 HTTPS 凭据，并经同 Job askpass pipe 交付；capability runner 只把短期、host-bound proxy token 放入自身环境，不取得宿主凭据。
 * 7. Agent Runtime 模式只启动受保护 Node/entry，联合核对 pipe 客户端身份后发送启动首帧并代理原始 Broker 字节流；初始 CWD 使用私有目录。
 * 8. stdout 只承载工具输出或 Agent Runtime IPC；stderr 只输出有界控制记录，不记录命令、路径、SID、密码或工具内容。
 *
 * restricted token、default DACL、Job 和 capability SID 的底层算法复用已验证探针源；通过宏重命名其 wmain，
 * 探针入口不会暴露在产品二进制的顶层命令分派中。该 supervisor 不提升权限，也不创建账户或 WFP 规则。
 */

#define wmain CodeAtelierRestrictedProbeMain
#include "../../experiments/windows-restricted-token-demo/restricted_token_demo.cpp"
#undef wmain

#include <wincrypt.h>
#include <TlHelp32.h>
#include <wincred.h>
#include <ntsecapi.h>
#include <userenv.h>

#include <atomic>
#include <map>
#include <sstream>

namespace {

constexpr uint32_t kRequestMagic = 0x42534143;
constexpr uint32_t kRequestVersion = 2;
constexpr DWORD kCleanupFailureExitCode = 70;
constexpr DWORD kSelfCheckFailureExitCode = 71;
constexpr DWORD kProtocolFailureExitCode = 72;
constexpr NTSTATUS kStatusObjectNameNotFound =
    static_cast<NTSTATUS>(0xC0000034L);
constexpr size_t kMaximumStringBytes = 64 * 1024;
constexpr uint32_t kMaximumArguments = 64;
constexpr uint32_t kMaximumRoots = 96;
constexpr char kDpapiEntropy[] = "CodeAtelier.WindowsSandbox.Secret.v1";

struct ProductRoot {
  uint32_t flags = 0;
  std::wstring path;
  std::wstring device_id;
  std::wstring file_id;
  std::wstring identity_digest;
};

struct ProductRequest {
  std::wstring execution_instance_id;
  std::wstring working_directory;
  std::wstring executable;
  std::vector<std::wstring> arguments;
  std::wstring private_directory;
  DWORD timeout_ms = 0;
  std::wstring manifest_digest;
  std::wstring git_global_config;
  std::wstring proxy_url;
  std::wstring proxy_host;
  std::wstring proxy_token;
  std::wstring askpass_pipe;
  DWORD lease_epoch = 0;
  std::vector<ProductRoot> roots;
};

struct InstallationState {
  int version = 0;
  std::wstring account_name;
  std::wstring account_sid;
  std::wstring generation_id;
  std::wstring protected_password;
  std::wstring installed_by_sid;
  uint16_t relay_port_v4 = 0;
  uint16_t relay_port_v6 = 0;
  std::wstring runtime_node_sha256;
  std::wstring runtime_entry_sha256;
  std::wstring runtime_worker_sha256;
  std::wstring runtime_read_worker_sha256;
  std::wstring runtime_subagent_worker_sha256;
  std::wstring runtime_node_path;
  std::wstring runtime_entry_path;
  std::wstring runtime_worker_path;
  std::wstring runtime_read_worker_path;
  std::wstring runtime_subagent_worker_path;
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
  uint32_t root_count = 0;
  if (!ReadFramedString(handle, &request->manifest_digest) ||
      !ReadFramedString(handle, &request->git_global_config) ||
      !ReadFramedString(handle, &request->proxy_url) ||
      !ReadFramedString(handle, &request->proxy_host) ||
      !ReadFramedString(handle, &request->proxy_token) ||
      !ReadFramedString(handle, &request->askpass_pipe) ||
      !ReadExact(handle, &request->lease_epoch, sizeof(request->lease_epoch)) ||
      !ReadExact(handle, &root_count, sizeof(root_count)) ||
      root_count > kMaximumRoots) {
    return false;
  }
  request->roots.clear();
  for (uint32_t index = 0; index < root_count; ++index) {
    ProductRoot root;
    if (!ReadExact(handle, &root.flags, sizeof(root.flags)) ||
        (root.flags & ~7u) != 0 || !ReadFramedString(handle, &root.path) ||
        !ReadFramedString(handle, &root.device_id) ||
        !ReadFramedString(handle, &root.file_id) ||
        !ReadFramedString(handle, &root.identity_digest) || root.path.empty() ||
        root.device_id.empty() || root.file_id.empty() ||
        root.identity_digest.size() != 64) {
      return false;
    }
    request->roots.push_back(std::move(root));
  }
  return !request->execution_instance_id.empty() &&
         !request->working_directory.empty() && !request->executable.empty() &&
         !request->private_directory.empty() && request->timeout_ms > 0 &&
         !request->manifest_digest.empty() && request->lease_epoch > 0 &&
         !request->git_global_config.empty() && !request->roots.empty() &&
         (request->proxy_url.empty()
              ? request->proxy_host.empty() && request->proxy_token.empty() &&
                    request->askpass_pipe.empty()
              : (!request->proxy_host.empty() &&
                 (!request->proxy_token.empty() ||
                  !request->askpass_pipe.empty())));
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
  uint32_t root_count = static_cast<uint32_t>(request.roots.size());
  if (!WriteFramedString(handle, request.manifest_digest) ||
      !WriteFramedString(handle, request.git_global_config) ||
      !WriteFramedString(handle, request.proxy_url) ||
      !WriteFramedString(handle, request.proxy_host) ||
      !WriteFramedString(handle, request.proxy_token) ||
      !WriteFramedString(handle, request.askpass_pipe) ||
      !WriteExact(handle, &request.lease_epoch, sizeof(request.lease_epoch)) ||
      !WriteExact(handle, &root_count, sizeof(root_count))) {
    return false;
  }
  for (const ProductRoot& root : request.roots) {
    if (!WriteExact(handle, &root.flags, sizeof(root.flags)) ||
        !WriteFramedString(handle, root.path) ||
        !WriteFramedString(handle, root.device_id) ||
        !WriteFramedString(handle, root.file_id) ||
        !WriteFramedString(handle, root.identity_digest)) {
      return false;
    }
  }
  return true;
}

bool ReadRevokeRoots(HANDLE handle, std::vector<ProductRoot>* roots) {
  uint32_t magic = 0;
  uint32_t version = 0;
  uint32_t root_count = 0;
  if (!ReadExact(handle, &magic, sizeof(magic)) ||
      !ReadExact(handle, &version, sizeof(version)) ||
      !ReadExact(handle, &root_count, sizeof(root_count)) ||
      magic != kRequestMagic || version != kRequestVersion || root_count == 0 ||
      root_count > kMaximumRoots) {
    return false;
  }
  roots->clear();
  for (uint32_t index = 0; index < root_count; ++index) {
    ProductRoot root;
    if (!ReadExact(handle, &root.flags, sizeof(root.flags)) ||
        (root.flags & ~2u) != 0 || !ReadFramedString(handle, &root.path) ||
        !ReadFramedString(handle, &root.device_id) ||
        !ReadFramedString(handle, &root.file_id) ||
        !ReadFramedString(handle, &root.identity_digest) || root.path.empty() ||
        root.device_id.empty() || root.file_id.empty() ||
        root.identity_digest.size() != 64) {
      return false;
    }
    roots->push_back(std::move(root));
  }
  return true;
}

bool IsDigest(const std::wstring& value) {
  return value.size() == 64 &&
         std::all_of(value.begin(), value.end(), [](wchar_t character) {
           return (character >= L'0' && character <= L'9') ||
                  (character >= L'a' && character <= L'f');
         });
}

std::filesystem::path GrantJournalPath(const std::wstring& state_path,
                                       const ProductRoot& root) {
  return std::filesystem::path(state_path).parent_path() / L"grants" /
         (root.identity_digest + L".grant");
}

bool WriteGrantJournal(const std::wstring& state_path,
                       const ProductRoot& root) {
  if (!IsDigest(root.identity_digest)) {
    return false;
  }
  std::filesystem::path journal_path = GrantJournalPath(state_path, root);
  UniqueHandle journal(CreateFileW(
      journal_path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr));
  if (!journal) {
    return false;
  }
  uint32_t root_count = 1;
  return WriteExact(journal.get(), &kRequestMagic, sizeof(kRequestMagic)) &&
         WriteExact(journal.get(), &kRequestVersion,
                    sizeof(kRequestVersion)) &&
         WriteExact(journal.get(), &root_count, sizeof(root_count)) &&
         WriteExact(journal.get(), &root.flags, sizeof(root.flags)) &&
         WriteFramedString(journal.get(), root.path) &&
         WriteFramedString(journal.get(), root.device_id) &&
         WriteFramedString(journal.get(), root.file_id) &&
         WriteFramedString(journal.get(), root.identity_digest) &&
         FlushFileBuffers(journal.get());
}

bool RemoveGrantJournal(const std::wstring& state_path,
                        const ProductRoot& root) {
  if (!IsDigest(root.identity_digest)) {
    return false;
  }
  std::filesystem::path journal_path = GrantJournalPath(state_path, root);
  return DeleteFileW(journal_path.c_str()) != FALSE ||
         GetLastError() == ERROR_FILE_NOT_FOUND;
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
  const std::wstring version = values[L"version"];
  if (version != L"1" && version != L"2" && version != L"3" &&
      version != L"4") {
    return false;
  }
  if (version == L"4") {
    state->version = 4;
  } else if (version == L"3") {
    state->version = 3;
  } else if (version == L"2") {
    state->version = 2;
  } else {
    state->version = 1;
  }
  state->account_name = values[L"accountName"];
  state->account_sid = values[L"accountSid"];
  state->generation_id = values[L"generationId"];
  state->protected_password = values[L"protectedPassword"];
  state->installed_by_sid = values[L"installedBySid"];
  if (state->version == 2) {
    wchar_t* port_v4_end = nullptr;
    wchar_t* port_v6_end = nullptr;
    unsigned long relay_port_v4 =
        std::wcstoul(values[L"relayPortV4"].c_str(), &port_v4_end, 10);
    unsigned long relay_port_v6 =
        std::wcstoul(values[L"relayPortV6"].c_str(), &port_v6_end, 10);
    if (port_v4_end == values[L"relayPortV4"].c_str() ||
        *port_v4_end != L'\0' ||
        port_v6_end == values[L"relayPortV6"].c_str() ||
        *port_v6_end != L'\0' || relay_port_v4 < 1024 ||
        relay_port_v4 > 65535 || relay_port_v6 < 1024 ||
        relay_port_v6 > 65535) {
      return false;
    }
    state->relay_port_v4 = static_cast<uint16_t>(relay_port_v4);
    state->relay_port_v6 = static_cast<uint16_t>(relay_port_v6);
  }
  state->runtime_node_sha256 = values[L"runtimeNodeSha256"];
  state->runtime_entry_sha256 = values[L"runtimeEntrySha256"];
  state->runtime_worker_sha256 = values[L"runtimeWorkerSha256"];
  state->runtime_read_worker_sha256 = values[L"runtimeReadWorkerSha256"];
  state->runtime_subagent_worker_sha256 = values[L"runtimeSubagentWorkerSha256"];
  std::filesystem::path runtime_root =
      std::filesystem::path(state_path).parent_path() / L"runtime";
  state->runtime_node_path = (runtime_root / L"node.exe").wstring();
  state->runtime_entry_path =
      (runtime_root / L"agent-runtime.mjs").wstring();
  state->runtime_worker_path =
      (runtime_root / L"compaction-worker.mjs").wstring();
  state->runtime_read_worker_path =
      (runtime_root / L"read-file-worker.mjs").wstring();
  state->runtime_subagent_worker_path =
      (runtime_root / L"subagent-worker.mjs").wstring();
  bool base_valid = !state->account_name.empty() &&
                    !state->account_sid.empty() &&
                    !state->generation_id.empty() &&
                    !state->protected_password.empty() &&
                    !state->installed_by_sid.empty();
  return base_valid &&
         (state->version == 1 ||
          (IsDigest(state->runtime_node_sha256) &&
           IsDigest(state->runtime_entry_sha256) &&
           IsDigest(state->runtime_worker_sha256) &&
           (state->version == 2 ||
            IsDigest(state->runtime_read_worker_sha256)) &&
           (state->version < 4 ||
            IsDigest(state->runtime_subagent_worker_sha256))));
}

bool FileSha256(const std::wstring& path, std::wstring* digest) {
  UniqueHandle file(CreateFileW(
      path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  BY_HANDLE_FILE_INFORMATION information{};
  if (!file || !GetFileInformationByHandle(file.get(), &information) ||
      (information.dwFileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    return false;
  }

  HCRYPTPROV provider = 0;
  HCRYPTHASH hash = 0;
  bool valid = CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES,
                                    CRYPT_VERIFYCONTEXT) &&
               CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash);
  std::array<BYTE, 64 * 1024> buffer{};
  while (valid) {
    DWORD bytes_read = 0;
    if (!ReadFile(file.get(), buffer.data(), static_cast<DWORD>(buffer.size()),
                  &bytes_read, nullptr)) {
      valid = false;
      break;
    }
    if (bytes_read == 0) {
      break;
    }
    valid = CryptHashData(hash, buffer.data(), bytes_read, 0) != FALSE;
  }

  std::array<BYTE, 32> hash_bytes{};
  DWORD hash_size = static_cast<DWORD>(hash_bytes.size());
  valid = valid &&
          CryptGetHashParam(hash, HP_HASHVAL, hash_bytes.data(), &hash_size,
                            0) != FALSE &&
          hash_size == hash_bytes.size();
  if (hash != 0) {
    CryptDestroyHash(hash);
  }
  if (provider != 0) {
    CryptReleaseContext(provider, 0);
  }
  if (!valid) {
    return false;
  }

  constexpr wchar_t kHex[] = L"0123456789abcdef";
  digest->clear();
  digest->reserve(hash_bytes.size() * 2);
  for (BYTE byte : hash_bytes) {
    digest->push_back(kHex[byte >> 4]);
    digest->push_back(kHex[byte & 0x0f]);
  }
  return true;
}

bool RuntimeBundleMatches(const InstallationState& state) {
  std::wstring node_digest;
  std::wstring entry_digest;
  std::wstring worker_digest;
  std::wstring read_worker_digest;
  std::wstring subagent_worker_digest;

  return state.version >= 2 &&
         FileSha256(state.runtime_node_path, &node_digest) &&
         FileSha256(state.runtime_entry_path, &entry_digest) &&
         FileSha256(state.runtime_worker_path, &worker_digest) &&
         (state.version == 2 ||
          FileSha256(state.runtime_read_worker_path, &read_worker_digest)) &&
         (state.version < 4 ||
          FileSha256(state.runtime_subagent_worker_path,
                     &subagent_worker_digest)) &&
         node_digest == state.runtime_node_sha256 &&
         entry_digest == state.runtime_entry_sha256 &&
         worker_digest == state.runtime_worker_sha256 &&
         (state.version == 2 ||
          read_worker_digest == state.runtime_read_worker_sha256) &&
         (state.version < 4 ||
          subagent_worker_digest == state.runtime_subagent_worker_sha256);
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

std::array<const wchar_t*, 4> RequiredDenyRights() {
  return {L"SeDenyNetworkLogonRight", L"SeDenyBatchLogonRight",
          L"SeDenyServiceLogonRight", L"SeDenyRemoteInteractiveLogonRight"};
}

LSA_UNICODE_STRING LsaString(const wchar_t* value) {
  LSA_UNICODE_STRING result{};
  result.Buffer = const_cast<PWSTR>(value);
  result.Length = static_cast<USHORT>(wcslen(value) * sizeof(wchar_t));
  result.MaximumLength = result.Length + sizeof(wchar_t);
  return result;
}

bool AccountRightsMatch(PSID account_sid) {
  LSA_OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  LSA_HANDLE policy = nullptr;
  if (LsaOpenPolicy(nullptr, &attributes, POLICY_LOOKUP_NAMES, &policy) != 0) {
    return false;
  }
  PLSA_UNICODE_STRING rights = nullptr;
  ULONG count = 0;
  NTSTATUS status = LsaEnumerateAccountRights(policy, account_sid, &rights,
                                               &count);
  std::vector<std::wstring> actual;
  if (status == 0) {
    for (ULONG index = 0; index < count; ++index) {
      actual.emplace_back(rights[index].Buffer,
                          rights[index].Length / sizeof(wchar_t));
    }
    LsaFreeMemory(rights);
  }
  LsaClose(policy);
  if (status != 0) {
    return false;
  }
  for (const wchar_t* required : RequiredDenyRights()) {
    if (std::find(actual.begin(), actual.end(), required) == actual.end()) {
      return false;
    }
  }
  return true;
}

bool ConfigureAccountRights(PSID account_sid, bool remove) {
  LSA_OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  LSA_HANDLE policy = nullptr;
  if (LsaOpenPolicy(nullptr, &attributes,
                    POLICY_LOOKUP_NAMES | POLICY_CREATE_ACCOUNT,
                    &policy) != 0) {
    return false;
  }
  auto names = RequiredDenyRights();
  std::array<LSA_UNICODE_STRING, 4> rights{};
  for (size_t index = 0; index < names.size(); ++index) {
    rights[index] = LsaString(names[index]);
  }
  NTSTATUS status =
      remove ? LsaRemoveAccountRights(policy, account_sid, FALSE, rights.data(),
                                      static_cast<ULONG>(rights.size()))
             : LsaAddAccountRights(policy, account_sid, rights.data(),
                                   static_cast<ULONG>(rights.size()));
  LsaClose(policy);
  return status == 0 || (remove && status == kStatusObjectNameNotFound);
}

bool VerifyInstallation(const InstallationState& state,
                        const std::wstring& network_manager,
                        std::wstring* password,
                        bool require_account_rights = true,
                        bool require_wfp = true,
                        bool require_runtime_bundle = true) {
  if (CurrentUserSidString() != state.installed_by_sid ||
      (require_wfp && !std::filesystem::is_regular_file(network_manager)) ||
      (require_runtime_bundle && !RuntimeBundleMatches(state))) {
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
  return (!require_account_rights || AccountRightsMatch(account_sid.data())) &&
         (!require_wfp ||
          RunFixedProcess(
              network_manager,
              L"--wfp-persistent-verify " + QuoteArgument(state.account_name) +
                  L" " + std::to_wstring(state.relay_port_v4) + L" " +
                  std::to_wstring(state.relay_port_v6)));
}

class ObjectGrant {
 public:
  bool Install(const std::wstring& object_path, bool expect_file,
               bool writable, bool install_account, PSID account_sid,
               PSID capability_sid, const std::wstring& expected_device = L"",
               const std::wstring& expected_file = L"") {
    handle_.reset(CreateFileW(
        object_path.c_str(), READ_CONTROL | WRITE_DAC,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING,
        (expect_file ? 0 : FILE_FLAG_BACKUP_SEMANTICS) |
            FILE_FLAG_OPEN_REPARSE_POINT,
        nullptr));
    if (!handle_) {
      return false;
    }
    BY_HANDLE_FILE_INFORMATION information{};
    if (!GetFileInformationByHandle(handle_.get(), &information) ||
        (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        (((information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) ==
         expect_file)) {
      return false;
    }
    if (!expected_device.empty() && !expected_file.empty()) {
      wchar_t* end = nullptr;
      unsigned long long expected_device_value =
          wcstoull(expected_device.c_str(), &end, 10);
      if (end == expected_device.c_str() || *end != L'\0') {
        return false;
      }
      unsigned long long expected_file_value =
          wcstoull(expected_file.c_str(), &end, 10);
      unsigned long long actual_file_value =
          (static_cast<unsigned long long>(information.nFileIndexHigh) << 32) |
          information.nFileIndexLow;
      if (end == expected_file.c_str() || *end != L'\0' ||
          expected_device_value != information.dwVolumeSerialNumber ||
          expected_file_value != actual_file_value) {
        return false;
      }
    }

    PACL old_acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD result = GetSecurityInfo(handle_.get(), SE_FILE_OBJECT,
                                   DACL_SECURITY_INFORMATION, nullptr, nullptr,
                                   &old_acl, nullptr, &descriptor);
    LocalPointer owned_descriptor(descriptor);
    if (result != ERROR_SUCCESS) {
      return false;
    }

    bool has_account = HasExplicitSid(old_acl, account_sid);
    if ((install_account && has_account) || (!install_account && !has_account) ||
        (writable && HasExplicitSid(old_acl, capability_sid))) {
      return false;
    }

    std::vector<EXPLICIT_ACCESSW> entries;
    if (install_account) {
      EXPLICIT_ACCESSW entry{};
      entry.grfAccessPermissions = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE |
                                   FILE_GENERIC_WRITE | DELETE;
      entry.grfAccessMode = GRANT_ACCESS;
      entry.grfInheritance =
          expect_file ? NO_INHERITANCE : SUB_CONTAINERS_AND_OBJECTS_INHERIT;
      entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
      entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
      entry.Trustee.ptstrName = static_cast<LPWSTR>(account_sid);
      entries.push_back(entry);
    }
    if (writable) {
      EXPLICIT_ACCESSW entry{};
      entry.grfAccessPermissions = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE |
                                   FILE_GENERIC_WRITE | DELETE;
      entry.grfAccessMode = GRANT_ACCESS;
      entry.grfInheritance =
          expect_file ? NO_INHERITANCE : SUB_CONTAINERS_AND_OBJECTS_INHERIT;
      entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
      entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
      entry.Trustee.ptstrName = static_cast<LPWSTR>(capability_sid);
      entries.push_back(entry);
    }
    PACL new_acl = nullptr;
    result = entries.empty()
                 ? ERROR_SUCCESS
                 : SetEntriesInAclW(static_cast<ULONG>(entries.size()),
                                    entries.data(), old_acl, &new_acl);
    LocalPointer owned_acl(new_acl);
    if (result != ERROR_SUCCESS || (!entries.empty() &&
        SetSecurityInfo(handle_.get(), SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION, nullptr, nullptr, new_acl,
                        nullptr) != ERROR_SUCCESS)) {
      return false;
    }
    account_sid_.resize(GetLengthSid(account_sid));
    remove_account_ = install_account;
    remove_capability_ = writable;
    if (writable) {
      capability_sid_.resize(GetLengthSid(capability_sid));
    }
    return CopySid(static_cast<DWORD>(account_sid_.size()),
                   account_sid_.data(), account_sid) &&
           (!writable ||
            CopySid(static_cast<DWORD>(capability_sid_.size()),
                    capability_sid_.data(), capability_sid));
  }

  bool RevokeInstance() {
    return Revoke(false);
  }

  bool RevokeAll() {
    return Revoke(true);
  }

  static bool RevokeAccount(const std::wstring& object_path, bool expect_file,
                            PSID account_sid,
                            const std::wstring& expected_device,
                            const std::wstring& expected_file) {
    ObjectGrant grant;
    if (!grant.OpenAndVerify(object_path, expect_file, expected_device,
                             expected_file)) {
      return false;
    }
    grant.account_sid_.resize(GetLengthSid(account_sid));
    grant.remove_account_ = true;
    return CopySid(static_cast<DWORD>(grant.account_sid_.size()),
                   grant.account_sid_.data(), account_sid) &&
           grant.Revoke(true);
  }

 private:
  bool OpenAndVerify(const std::wstring& object_path, bool expect_file,
                     const std::wstring& expected_device,
                     const std::wstring& expected_file) {
    unsigned long long expected_device_value = 0;
    unsigned long long expected_file_value = 0;
    if (!ParseUnsigned(expected_device, &expected_device_value) ||
        !ParseUnsigned(expected_file, &expected_file_value)) {
      return false;
    }

    handle_.reset(CreateFileW(
        object_path.c_str(), READ_CONTROL | WRITE_DAC,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING,
        (expect_file ? 0 : FILE_FLAG_BACKUP_SEMANTICS) |
            FILE_FLAG_OPEN_REPARSE_POINT,
        nullptr));
    if (handle_ &&
        VerifyOpenedObject(handle_.get(), expect_file, expected_device_value,
                           expected_file_value)) {
      return true;
    }

    handle_.reset();
    if (!OpenByFileId(object_path, expected_device_value, expected_file_value,
                      expect_file)) {
      return false;
    }

    return VerifyOpenedObject(handle_.get(), expect_file, expected_device_value,
                              expected_file_value);
  }

  static bool ParseUnsigned(const std::wstring& value,
                            unsigned long long* output) {
    wchar_t* end = nullptr;
    unsigned long long parsed = wcstoull(value.c_str(), &end, 10);
    if (end == value.c_str() || *end != L'\0') {
      return false;
    }

    *output = parsed;
    return true;
  }

  static bool VerifyOpenedObject(HANDLE handle, bool expect_file,
                                 unsigned long long expected_device,
                                 unsigned long long expected_file) {
    BY_HANDLE_FILE_INFORMATION information{};
    if (!GetFileInformationByHandle(handle, &information) ||
        (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        (((information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) ==
          expect_file)) {
      return false;
    }
    unsigned long long actual_file_value =
        (static_cast<unsigned long long>(information.nFileIndexHigh) << 32) |
        information.nFileIndexLow;
    return expected_device == information.dwVolumeSerialNumber &&
           expected_file == actual_file_value;
  }

  bool OpenByFileId(const std::wstring& object_path,
                    unsigned long long expected_device,
                    unsigned long long expected_file, bool expect_file) {
    std::array<wchar_t, MAX_PATH> volume_path{};
    if (!GetVolumePathNameW(object_path.c_str(), volume_path.data(),
                            static_cast<DWORD>(volume_path.size()))) {
      if (object_path.size() < 3 || object_path[1] != L':' ||
          (object_path[2] != L'\\' && object_path[2] != L'/')) {
        return false;
      }

      volume_path[0] = object_path[0];
      volume_path[1] = L':';
      volume_path[2] = L'\\';
      volume_path[3] = L'\0';
    }

    std::array<wchar_t, MAX_PATH> volume_name{};
    if (!GetVolumeNameForVolumeMountPointW(
            volume_path.data(), volume_name.data(),
            static_cast<DWORD>(volume_name.size()))) {
      return false;
    }

    std::wstring volume_target(volume_name.data());
    if (!volume_target.empty() && volume_target.back() == L'\\') {
      volume_target.pop_back();
    }

    DWORD volume_serial = 0;
    if (!GetVolumeInformationW(volume_path.data(), nullptr, 0, &volume_serial,
                               nullptr, nullptr, nullptr, 0) ||
        expected_device != volume_serial) {
      return false;
    }

    UniqueHandle volume(CreateFileW(
        volume_target.c_str(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    if (!volume) {
      return false;
    }

    FILE_ID_DESCRIPTOR descriptor{};
    descriptor.dwSize = sizeof(descriptor);
    descriptor.Type = FileIdType;
    descriptor.FileId.QuadPart = static_cast<LONGLONG>(expected_file);
    handle_.reset(OpenFileById(
        volume.get(), &descriptor, READ_CONTROL | WRITE_DAC,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        (expect_file ? 0 : FILE_FLAG_BACKUP_SEMANTICS) |
            FILE_FLAG_OPEN_REPARSE_POINT));
    return static_cast<bool>(handle_);
  }

  bool Revoke(bool include_account) {
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
    std::vector<EXPLICIT_ACCESSW> entries;
    std::vector<PSID> sids;
    if (include_account && remove_account_) {
      sids.push_back(account_sid_.data());
    }
    if (remove_capability_) {
      sids.push_back(capability_sid_.data());
    }
    for (PSID sid : sids) {
      EXPLICIT_ACCESSW entry{};
      entry.grfAccessMode = REVOKE_ACCESS;
      entry.grfInheritance = NO_INHERITANCE;
      entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
      entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
      entry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
      entries.push_back(entry);
    }
    if (entries.empty()) {
      return true;
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
  bool remove_account_ = false;
  bool remove_capability_ = false;
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

class UniqueDesktop {
 public:
  UniqueDesktop() = default;
  explicit UniqueDesktop(HDESK handle) : handle_(handle) {}
  ~UniqueDesktop() {
    if (handle_ != nullptr) {
      CloseDesktop(handle_);
    }
  }
  UniqueDesktop(const UniqueDesktop&) = delete;
  UniqueDesktop& operator=(const UniqueDesktop&) = delete;
  HDESK get() const { return handle_; }
  explicit operator bool() const { return handle_ != nullptr; }
  void reset(HDESK handle) {
    if (handle_ != nullptr) {
      CloseDesktop(handle_);
    }
    handle_ = handle;
  }

 private:
  HDESK handle_ = nullptr;
};

class UniqueEnvironment {
 public:
  ~UniqueEnvironment() {
    if (value_ != nullptr) {
      DestroyEnvironmentBlock(value_);
    }
  }
  void** address() { return &value_; }
  void* get() const { return value_; }

 private:
  void* value_ = nullptr;
};

bool BuildSandboxEnvironment(const std::wstring& account_name,
                             const std::wstring& password,
                             UniqueEnvironment* environment) {
  HANDLE raw_token = nullptr;
  if (!LogonUserW(account_name.c_str(), L".", password.c_str(),
                  LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT,
                  &raw_token)) {
    return false;
  }
  UniqueHandle token(raw_token);
  return CreateEnvironmentBlock(environment->address(), token.get(), FALSE) !=
         FALSE;
}

bool CreatePrivateDesktop(PSID account_sid, PSID execution_sid,
                          PSID capability_sid, std::wstring* desktop_name,
                          UniqueDesktop* desktop) {
  std::wstring current_sid = CurrentUserSidString();
  std::wstring sddl =
      L"D:P(A;;GA;;;SY)(A;;GA;;;" + current_sid + L")(A;;GA;;;" +
      SidToString(account_sid) + L")(A;;GA;;;" +
      SidToString(execution_sid) + L")(A;;GA;;;" +
      SidToString(capability_sid) + L")";
  PSECURITY_DESCRIPTOR raw = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl.c_str(), SDDL_REVISION_1, &raw, nullptr)) {
    return false;
  }
  LocalPointer descriptor(raw);
  SECURITY_ATTRIBUTES attributes{};
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = raw;
  GUID identifier{};
  wchar_t identifier_text[40]{};
  if (CoCreateGuid(&identifier) != S_OK ||
      StringFromGUID2(identifier, identifier_text,
                      static_cast<int>(std::size(identifier_text))) == 0) {
    return false;
  }
  *desktop_name = L"CodeAtelierSandbox-" + std::wstring(identifier_text);
  desktop->reset(CreateDesktopW(desktop_name->c_str(), nullptr, nullptr, 0,
                                GENERIC_ALL, &attributes));
  return static_cast<bool>(*desktop);
}

bool ConfigureProductJob(SECURITY_ATTRIBUTES* security_attributes,
                         DWORD timeout_ms, UniqueHandle* job) {
  job->reset(CreateJobObjectW(security_attributes, nullptr));
  if (!*job) {
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
      JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_JOB_TIME |
      JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  limits.BasicLimitInformation.ActiveProcessLimit = 128;
  limits.BasicLimitInformation.PerJobUserTimeLimit.QuadPart =
      static_cast<LONGLONG>(timeout_ms) * 10000LL * 4LL;
  limits.JobMemoryLimit = 8ULL * 1024ULL * 1024ULL * 1024ULL;
  return SetInformationJobObject(job->get(), JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits)) != FALSE;
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

std::wstring MakeAgentRuntimePipeName() {
  GUID identifier{};
  if (CoCreateGuid(&identifier) != S_OK) {
    return L"";
  }
  wchar_t text[40]{};
  if (StringFromGUID2(identifier, text, static_cast<int>(std::size(text))) ==
      0) {
    return L"";
  }
  return L"\\\\.\\pipe\\CodeAtelier.AgentRuntime." + std::wstring(text);
}

std::string JsonString(const std::wstring& value) {
  std::string utf8 = WideToUtf8(value);
  std::string escaped;
  escaped.reserve(utf8.size() + 2);
  escaped.push_back('"');
  constexpr char kHex[] = "0123456789abcdef";
  for (unsigned char character : utf8) {
    switch (character) {
      case '"':
        escaped += "\\\"";
        break;
      case '\\':
        escaped += "\\\\";
        break;
      case '\b':
        escaped += "\\b";
        break;
      case '\f':
        escaped += "\\f";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        if (character < 0x20) {
          escaped += "\\u00";
          escaped.push_back(kHex[character >> 4]);
          escaped.push_back(kHex[character & 0x0f]);
        } else {
          escaped.push_back(static_cast<char>(character));
        }
    }
  }
  escaped.push_back('"');
  return escaped;
}

bool WriteRuntimeStartupDescriptor(HANDLE pipe,
                                   const std::wstring& session_id,
                                   const std::wstring& task_id,
                                   const std::wstring& execution_instance_id,
                                   const std::wstring& nonce) {
  std::string payload =
      "{\"protocolVersion\":1,\"identity\":{\"sessionId\":" +
      JsonString(session_id) + ",\"taskId\":" + JsonString(task_id) +
      ",\"executionInstanceId\":" + JsonString(execution_instance_id) +
      ",\"kind\":\"agent-runtime\"},\"nonce\":" + JsonString(nonce) +
      "}";
  if (payload.size() > kMaximumStringBytes) {
    return false;
  }
  uint32_t size = static_cast<uint32_t>(payload.size());
  return WriteExact(pipe, &size, sizeof(size)) &&
         WriteExact(pipe, payload.data(), size);
}

std::wstring BuildCommandLine(const std::wstring& executable,
                              const std::vector<std::wstring>& arguments) {
  std::wstring command_line = QuoteArgument(executable);
  for (const std::wstring& argument : arguments) {
    command_line += L" " + QuoteArgument(argument);
  }
  return command_line;
}

bool SetPrivateEnvironment(const std::wstring& private_directory,
                           const std::wstring& git_global_config,
                           const std::wstring& proxy_url,
                           const std::wstring& proxy_host,
                           const std::wstring& proxy_token,
                           const std::wstring& askpass_pipe) {
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
  SetEnvironmentVariableW(L"NODE_OPTIONS", nullptr);
  SetEnvironmentVariableW(L"NODE_PATH", nullptr);
  SetEnvironmentVariableW(L"NODE_REPL_EXTERNAL_MODULE", nullptr);
  SetEnvironmentVariableW(L"NODE_EXTRA_CA_CERTS", nullptr);
  SetEnvironmentVariableW(L"ALL_PROXY", nullptr);
  SetEnvironmentVariableW(L"all_proxy", nullptr);
  SetEnvironmentVariableW(L"NO_PROXY", nullptr);
  SetEnvironmentVariableW(L"no_proxy", nullptr);
  SetEnvironmentVariableW(L"HTTP_PROXY", nullptr);
  SetEnvironmentVariableW(L"http_proxy", nullptr);
  SetEnvironmentVariableW(L"GIT_PROXY_COMMAND", nullptr);
  SetEnvironmentVariableW(L"GIT_SSH", nullptr);
  SetEnvironmentVariableW(L"GIT_SSH_COMMAND", nullptr);
  SetEnvironmentVariableW(L"SSH_AUTH_SOCK", nullptr);
  SetEnvironmentVariableW(L"GIT_CONFIG_SYSTEM", nullptr);
  SetEnvironmentVariableW(L"GIT_CONFIG_NOSYSTEM", nullptr);
  SetEnvironmentVariableW(L"GIT_CONFIG_COUNT", nullptr);
  for (size_t index = 0; index < 64; ++index) {
    std::wstring suffix = std::to_wstring(index);
    SetEnvironmentVariableW((L"GIT_CONFIG_KEY_" + suffix).c_str(), nullptr);
    SetEnvironmentVariableW((L"GIT_CONFIG_VALUE_" + suffix).c_str(), nullptr);
  }
  SetEnvironmentVariableW(L"GIT_TERMINAL_PROMPT", L"0");
  SetEnvironmentVariableW(L"GIT_PAGER", L"cat");
  SetEnvironmentVariableW(L"PAGER", L"cat");
  SetEnvironmentVariableW(L"GIT_EDITOR", L"true");
  if (!git_global_config.empty() &&
      !SetEnvironmentVariableW(L"GIT_CONFIG_GLOBAL",
                               git_global_config.c_str())) {
    return false;
  }
  if (!proxy_url.empty()) {
    if (proxy_url.rfind(L"http://127.0.0.1:", 0) != 0 ||
        (proxy_token.empty() == askpass_pipe.empty())) {
      return false;
    }
    std::wstring authenticated_proxy = proxy_token.empty()
                                           ? L"http://codeatelier@" +
                                                 proxy_url.substr(7)
                                           : L"http://codeatelier:" +
                                                 proxy_token + L"@" +
                                                 proxy_url.substr(7);
    if (!SetEnvironmentVariableW(L"HTTPS_PROXY", authenticated_proxy.c_str()) ||
        !SetEnvironmentVariableW(L"https_proxy", authenticated_proxy.c_str()) ||
        !SetEnvironmentVariableW(L"HTTP_PROXY", authenticated_proxy.c_str()) ||
        !SetEnvironmentVariableW(L"http_proxy", authenticated_proxy.c_str()) ||
        !SetEnvironmentVariableW(L"CODEATELIER_PUSH_HOST",
                                 proxy_host.c_str())) {
      return false;
    }
    if (!askpass_pipe.empty()) {
      std::wstring executable = CurrentExecutablePath();
      if (!SetEnvironmentVariableW(L"GIT_ASKPASS", executable.c_str()) ||
          !SetEnvironmentVariableW(L"GIT_ASKPASS_REQUIRE", L"force") ||
          !SetEnvironmentVariableW(L"CODEATELIER_ASKPASS_PIPE",
                                   askpass_pipe.c_str())) {
        return false;
      }
    } else {
      SetEnvironmentVariableW(L"GIT_ASKPASS", nullptr);
      SetEnvironmentVariableW(L"GIT_ASKPASS_REQUIRE", nullptr);
      SetEnvironmentVariableW(L"CODEATELIER_ASKPASS_PIPE", nullptr);
    }
  } else {
    SetEnvironmentVariableW(L"HTTPS_PROXY", nullptr);
    SetEnvironmentVariableW(L"https_proxy", nullptr);
    SetEnvironmentVariableW(L"CODEATELIER_ASKPASS_PIPE", nullptr);
    SetEnvironmentVariableW(L"CODEATELIER_PUSH_HOST", nullptr);
  }
  return true;
}

struct HostCredential {
  std::wstring username;
  std::wstring password;
};

std::wstring CredentialSecret(const CREDENTIALW& credential) {
  if (credential.CredentialBlob == nullptr ||
      credential.CredentialBlobSize == 0) {
    return L"";
  }
  bool likely_utf16 =
      credential.CredentialBlobSize % sizeof(wchar_t) == 0;
  if (likely_utf16) {
    size_t zero_high_bytes = 0;
    for (DWORD index = 1; index < credential.CredentialBlobSize; index += 2) {
      zero_high_bytes += credential.CredentialBlob[index] == 0 ? 1 : 0;
    }
    likely_utf16 = zero_high_bytes * 4 >= credential.CredentialBlobSize;
  }
  if (likely_utf16) {
    size_t character_count =
        credential.CredentialBlobSize / sizeof(wchar_t);
    const wchar_t* characters =
        reinterpret_cast<const wchar_t*>(credential.CredentialBlob);
    while (character_count > 0 && characters[character_count - 1] == L'\0') {
      character_count -= 1;
    }
    return std::wstring(characters, characters + character_count);
  }
  std::string utf8(
      reinterpret_cast<const char*>(credential.CredentialBlob),
      credential.CredentialBlobSize);
  return Utf8ToWide(utf8);
}

bool LoadHostCredential(const std::wstring& host, HostCredential* output) {
  std::array<std::wstring, 3> targets = {
      L"git:https://" + host, L"git:https://" + host + L"/",
      L"LegacyGeneric:target=git:https://" + host};
  for (const std::wstring& target : targets) {
    PCREDENTIALW credential = nullptr;
    if (!CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &credential)) {
      continue;
    }
    std::wstring secret = CredentialSecret(*credential);
    std::wstring username =
        credential->UserName == nullptr ? L"" : credential->UserName;
    CredFree(credential);
    if (!secret.empty()) {
      output->username = username.empty() ? L"oauth2" : username;
      output->password = std::move(secret);
      return true;
    }
  }
  return false;
}

bool ProcessBelongsToJob(DWORD process_id, HANDLE job) {
  UniqueHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                   process_id));
  BOOL belongs = FALSE;
  return process && IsProcessInJob(process.get(), job, &belongs) && belongs;
}

bool TokenContainsSid(HANDLE token, TOKEN_INFORMATION_CLASS information_class,
                      PSID expected_sid) {
  DWORD size = 0;
  GetTokenInformation(token, information_class, nullptr, 0, &size);
  if (size == 0) {
    return false;
  }
  std::vector<BYTE> buffer(size);
  if (!GetTokenInformation(token, information_class, buffer.data(), size,
                           &size)) {
    return false;
  }
  const TOKEN_GROUPS* groups =
      reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    if (EqualSid(groups->Groups[index].Sid, expected_sid)) {
      return true;
    }
  }
  return false;
}

bool VerifyAgentRuntimeClient(HANDLE pipe, HANDLE job, PSID account_sid,
                              PSID execution_sid, PSID capability_sid,
                              const std::wstring& expected_image,
                              DWORD* process_id,
                              ULONGLONG* creation_time_100ns) {
  ULONG client_pid = 0;
  if (!GetNamedPipeClientProcessId(pipe, &client_pid) || client_pid == 0 ||
      !ProcessBelongsToJob(client_pid, job)) {
    return false;
  }
  UniqueHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                   client_pid));
  HANDLE raw_token = nullptr;
  if (!process || !OpenProcessToken(process.get(), TOKEN_QUERY, &raw_token)) {
    return false;
  }
  UniqueHandle token(raw_token);
  BOOL restricted = FALSE;
  DWORD restricted_size = sizeof(restricted);
  if (!GetTokenInformation(token.get(), TokenIsRestricted, &restricted,
                           restricted_size, &restricted_size) ||
      !restricted) {
    return false;
  }

  DWORD user_size = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &user_size);
  std::vector<BYTE> user_buffer(user_size);
  if (user_size == 0 ||
      !GetTokenInformation(token.get(), TokenUser, user_buffer.data(),
                           user_size, &user_size) ||
      !EqualSid(reinterpret_cast<TOKEN_USER*>(user_buffer.data())->User.Sid,
                account_sid) ||
      !TokenContainsSid(token.get(), TokenRestrictedSids, execution_sid) ||
      !TokenContainsSid(token.get(), TokenRestrictedSids, capability_sid)) {
    return false;
  }

  std::vector<wchar_t> image(32768);
  DWORD image_size = static_cast<DWORD>(image.size());
  if (!QueryFullProcessImageNameW(process.get(), 0, image.data(), &image_size) ||
      _wcsicmp(std::wstring(image.data(), image_size).c_str(),
               expected_image.c_str()) != 0) {
    return false;
  }

  FILETIME created{}, exited{}, kernel{}, user{};
  ULARGE_INTEGER created_value{};
  if (!GetProcessTimes(process.get(), &created, &exited, &kernel, &user)) {
    return false;
  }
  created_value.LowPart = created.dwLowDateTime;
  created_value.HighPart = created.dwHighDateTime;
  *process_id = client_pid;
  *creation_time_100ns = created_value.QuadPart;
  return true;
}

void ServeAskpass(const std::wstring& pipe_name,
                  SECURITY_ATTRIBUTES* security, HANDLE job,
                  const std::wstring& token,
                  const std::shared_ptr<HostCredential>& host_credential,
                  const std::shared_ptr<std::atomic_bool>& stop,
                  const std::shared_ptr<std::atomic_bool>& ready) {
  while (!stop->load()) {
    UniqueHandle pipe(CreateNamedPipeW(
        pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
            PIPE_REJECT_REMOTE_CLIENTS,
        1, 4096, 4096, 5000, security));
    if (!pipe) {
      return;
    }
    ready->store(true);
    if (!ConnectNamedPipe(pipe.get(), nullptr) &&
        GetLastError() != ERROR_PIPE_CONNECTED) {
      return;
    }
    if (stop->load()) {
      return;
    }
    ULONG client_pid = 0;
    BYTE request_kind = 0;
    if (GetNamedPipeClientProcessId(pipe.get(), &client_pid) &&
        ProcessBelongsToJob(client_pid, job) &&
        ReadExact(pipe.get(), &request_kind, sizeof(request_kind))) {
      if (request_kind == 'U') {
        WriteFramedString(pipe.get(), L"codeatelier");
      } else if (request_kind == 'P') {
        WriteFramedString(pipe.get(), token);
      } else if (request_kind == 'u' && !host_credential->username.empty()) {
        WriteFramedString(pipe.get(), host_credential->username);
      } else if (request_kind == 'p' && !host_credential->password.empty()) {
        WriteFramedString(pipe.get(), host_credential->password);
      }
    }
    FlushFileBuffers(pipe.get());
    DisconnectNamedPipe(pipe.get());
  }
}

void StopAskpass(const std::wstring& pipe_name,
                 const std::shared_ptr<std::atomic_bool>& stop,
                 std::thread* thread) {
  if (!thread->joinable()) {
    return;
  }
  stop->store(true);
  // 唤醒尚未连接的 ConnectNamedPipe；CancelSynchronousIo 同时打断已经连接但
  // 不发送完整请求或不读取响应的客户端所造成的 ReadFile/FlushFileBuffers 阻塞。
  CancelSynchronousIo(thread->native_handle());
  UniqueHandle wake(CreateFileW(pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE,
                                0, nullptr, OPEN_EXISTING, 0, nullptr));
  CancelSynchronousIo(thread->native_handle());
  thread->join();
}

int RunAskpass(const std::wstring& prompt) {
  wchar_t pipe_name[512]{};
  DWORD length = GetEnvironmentVariableW(L"CODEATELIER_ASKPASS_PIPE", pipe_name,
                                         static_cast<DWORD>(std::size(pipe_name)));
  std::wstring lowered = prompt;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), towlower);
  wchar_t host[512]{};
  DWORD host_length = GetEnvironmentVariableW(
      L"CODEATELIER_PUSH_HOST", host, static_cast<DWORD>(std::size(host)));
  bool proxy_prompt = lowered.find(L"127.0.0.1") != std::wstring::npos ||
                      lowered.find(L"proxy") != std::wstring::npos;
  bool host_prompt = host_length > 0 && host_length < std::size(host) &&
                     lowered.find(L"https://" + std::wstring(host)) !=
                         std::wstring::npos;
  if (length == 0 || length >= std::size(pipe_name) ||
      (!proxy_prompt && !host_prompt) || !WaitNamedPipeW(pipe_name, 10000)) {
    return 1;
  }
  UniqueHandle pipe(CreateFileW(pipe_name, GENERIC_READ | GENERIC_WRITE, 0,
                                nullptr, OPEN_EXISTING, 0, nullptr));
  if (!pipe) {
    return 1;
  }
  bool username_prompt = lowered.find(L"username") != std::wstring::npos;
  BYTE kind = proxy_prompt ? (username_prompt ? 'U' : 'P')
                           : (username_prompt ? 'u' : 'p');
  std::wstring response;
  if (!WriteExact(pipe.get(), &kind, sizeof(kind)) ||
      !ReadFramedString(pipe.get(), &response) || response.empty()) {
    return 1;
  }
  std::wcout << response << L"\n";
  return 0;
}

// WRITE_RESTRICTED 仅在写访问时检查 restricting SID。产品 token 只放入本实例
// execution/root capability；不能加入 Everyone，否则公共可写对象会绕过写根边界。
bool CreateProductRestrictedPrimaryToken(PSID execution_sid,
                                         PSID capability_sid,
                                         UniqueHandle* restricted_token) {
  HANDLE raw_current = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(),
                        TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY |
                            TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_PRIVILEGES |
                            TOKEN_ADJUST_SESSIONID,
                        &raw_current)) {
    return false;
  }
  UniqueHandle current_token(raw_current);
  DWORD user_size = 0;
  GetTokenInformation(current_token.get(), TokenUser, nullptr, 0, &user_size);
  if (user_size == 0) {
    return false;
  }
  std::vector<BYTE> user_buffer(user_size);
  if (!GetTokenInformation(current_token.get(), TokenUser, user_buffer.data(),
                           user_size, &user_size)) {
    return false;
  }
  auto* token_user = reinterpret_cast<TOKEN_USER*>(user_buffer.data());
  std::array<SID_AND_ATTRIBUTES, 2> restricting_sids{};
  restricting_sids[0].Sid = execution_sid;
  restricting_sids[1].Sid = capability_sid;
  HANDLE raw_restricted = nullptr;
  if (!CreateRestrictedToken(current_token.get(), kRestrictedTokenFlags, 0,
                             nullptr, 0, nullptr,
                             static_cast<DWORD>(restricting_sids.size()),
                             restricting_sids.data(), &raw_restricted)) {
    return false;
  }
  restricted_token->reset(raw_restricted);

  std::array<EXPLICIT_ACCESSW, 2> entries{};
  std::array<PSID, 2> sids = {token_user->User.Sid, execution_sid};
  for (size_t index = 0; index < entries.size(); ++index) {
    entries[index].grfAccessPermissions = GENERIC_ALL;
    entries[index].grfAccessMode = GRANT_ACCESS;
    entries[index].grfInheritance = NO_INHERITANCE;
    entries[index].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entries[index].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    entries[index].Trustee.ptstrName = static_cast<LPWSTR>(sids[index]);
  }
  PACL default_dacl = nullptr;
  DWORD result = SetEntriesInAclW(static_cast<ULONG>(entries.size()),
                                  entries.data(), nullptr, &default_dacl);
  LocalPointer owned_dacl(default_dacl);
  TOKEN_DEFAULT_DACL default_dacl_info{};
  default_dacl_info.DefaultDacl = default_dacl;
  if (result != ERROR_SUCCESS ||
      !SetTokenInformation(restricted_token->get(), TokenDefaultDacl,
                           &default_dacl_info, sizeof(default_dacl_info))) {
    return false;
  }

  LUID change_notify{};
  if (!LookupPrivilegeValueW(nullptr, SE_CHANGE_NOTIFY_NAME, &change_notify)) {
    return false;
  }
  TOKEN_PRIVILEGES privileges{};
  privileges.PrivilegeCount = 1;
  privileges.Privileges[0].Luid = change_notify;
  privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
  SetLastError(ERROR_SUCCESS);
  return AdjustTokenPrivileges(restricted_token->get(), FALSE, &privileges, 0,
                               nullptr, nullptr) &&
         GetLastError() != ERROR_NOT_ALL_ASSIGNED;
}

int RunProductBootstrap(const std::wstring& pipe_name,
                        const std::wstring& execution_sid_text,
                        const std::wstring& capability_sid_text,
                        const std::wstring& desktop_name) {
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
      !SetPrivateEnvironment(request.private_directory,
                             request.git_global_config, request.proxy_url,
                             request.proxy_host, request.proxy_token,
                             request.askpass_pipe)) {
    return 24;
  }
  SecureZeroMemory(request.proxy_token.data(),
                   request.proxy_token.size() * sizeof(wchar_t));
  request.proxy_token.clear();
  UniqueHandle restricted_token;
  if (!CreateProductRestrictedPrimaryToken(
          execution_sid.get(), capability_sid.get(), &restricted_token)) {
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
  startup.lpDesktop = const_cast<LPWSTR>(desktop_name.c_str());
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  const bool agent_runtime =
      request.arguments.size() == 2 &&
      request.arguments[1].rfind(L"\\\\.\\pipe\\CodeAtelier.AgentRuntime.",
                                 0) == 0;
  startup.hStdError = GetStdHandle(agent_runtime ? STD_ERROR_HANDLE
                                                 : STD_OUTPUT_HANDLE);
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
  FILETIME created{}, exited{}, kernel{}, user{};
  ULARGE_INTEGER created_value{};
  if (GetProcessTimes(process_handle.get(), &created, &exited, &kernel,
                      &user)) {
    created_value.LowPart = created.dwLowDateTime;
    created_value.HighPart = created.dwHighDateTime;
  }
  if (!agent_runtime) {
    std::wcerr << L"CODEATELIER_RUNTIME_STARTED pid=" << process.dwProcessId
               << L" created100ns=" << created_value.QuadPart << L"\n";
    std::wcerr.flush();
  }
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

struct AgentRuntimeProxyResult {
  bool started = false;
  bool cancelled = false;
  DWORD exit_code = 1;
};

bool RunAgentRuntimeProxy(HANDLE runtime_pipe, HANDLE bootstrap_process,
                          HANDLE job, PSID account_sid, PSID execution_sid,
                          PSID capability_sid,
                          const InstallationState& state,
                          const ProductRequest& request,
                          const std::wstring& session_id,
                          const std::wstring& task_id,
                          const std::wstring& nonce,
                          AgentRuntimeProxyResult* result) {
  bool connected = false;
  std::thread connector([&]() {
    connected = ConnectNamedPipe(runtime_pipe, nullptr) != FALSE ||
                GetLastError() == ERROR_PIPE_CONNECTED;
  });
  std::array<HANDLE, 2> connection_wait = {connector.native_handle(),
                                            bootstrap_process};
  DWORD connection_result = WaitForMultipleObjects(
      static_cast<DWORD>(connection_wait.size()), connection_wait.data(),
      FALSE, 10000);
  if (connection_result != WAIT_OBJECT_0) {
    CancelSynchronousIo(connector.native_handle());
    connector.join();
    return false;
  }
  connector.join();
  if (!connected) {
    return false;
  }

  DWORD runtime_pid = 0;
  ULONGLONG creation_time_100ns = 0;
  if (!VerifyAgentRuntimeClient(runtime_pipe, job, account_sid, execution_sid,
                                capability_sid, state.runtime_node_path,
                                &runtime_pid, &creation_time_100ns) ||
      !WriteRuntimeStartupDescriptor(runtime_pipe, session_id, task_id,
                                     request.execution_instance_id, nonce)) {
    return false;
  }

  result->started = true;
  std::wcerr << L"CODEATELIER_RUNTIME_STARTED pid=" << runtime_pid
             << L" created100ns=" << creation_time_100ns << L"\n";
  std::wcerr.flush();

  HANDLE broker_input = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE broker_output = GetStdHandle(STD_OUTPUT_HANDLE);
  auto stop = std::make_shared<std::atomic_bool>(false);
  auto cancelled = std::make_shared<std::atomic_bool>(false);
  auto proxy_failed = std::make_shared<std::atomic_bool>(false);
  std::thread broker_to_runtime([=]() {
    std::array<BYTE, 64 * 1024> buffer{};
    while (!stop->load()) {
      DWORD read = 0;
      if (!ReadFile(broker_input, buffer.data(),
                    static_cast<DWORD>(buffer.size()), &read, nullptr) ||
          read == 0) {
        if (!stop->exchange(true)) {
          cancelled->store(true);
          TerminateJobObject(job, 30);
          CancelIoEx(runtime_pipe, nullptr);
        }
        return;
      }
      if (!WriteExact(runtime_pipe, buffer.data(), read)) {
        if (!stop->exchange(true)) {
          proxy_failed->store(true);
          TerminateJobObject(job, 32);
        }
        return;
      }
    }
  });
  std::thread runtime_to_broker([=]() {
    std::array<BYTE, 64 * 1024> buffer{};
    while (!stop->load()) {
      DWORD read = 0;
      if (!ReadFile(runtime_pipe, buffer.data(),
                    static_cast<DWORD>(buffer.size()), &read, nullptr) ||
          read == 0) {
        return;
      }
      if (!WriteExact(broker_output, buffer.data(), read)) {
        if (!stop->exchange(true)) {
          proxy_failed->store(true);
          TerminateJobObject(job, 33);
          CancelIoEx(runtime_pipe, nullptr);
        }
        return;
      }
    }
  });

  DWORD wait =
      WaitForSingleObject(bootstrap_process, request.timeout_ms + 10000);
  if (wait != WAIT_OBJECT_0) {
    proxy_failed->store(true);
    TerminateJobObject(job, 31);
    WaitForSingleObject(bootstrap_process, 5000);
  }
  stop->store(true);
  CancelSynchronousIo(broker_to_runtime.native_handle());
  CancelIoEx(runtime_pipe, nullptr);
  broker_to_runtime.join();
  runtime_to_broker.join();

  result->cancelled = cancelled->load();
  if (!GetExitCodeProcess(bootstrap_process, &result->exit_code)) {
    return false;
  }
  return !proxy_failed->load();
}

int RunProductSupervisor(const std::wstring& state_path,
                         const std::wstring& network_manager,
                         bool agent_runtime = false) {
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
  std::wstring runtime_session_id;
  std::wstring runtime_task_id;
  std::wstring runtime_nonce;
  if (agent_runtime) {
    if (_wcsicmp(request.executable.c_str(),
                 state.runtime_node_path.c_str()) != 0 ||
        request.arguments.size() != 3 || request.arguments[0].empty() ||
        request.arguments[0].size() > 120 || request.arguments[1].empty() ||
        request.arguments[1].size() > 120 ||
        !IsDigest(request.arguments[2]) || !request.proxy_url.empty() ||
        !request.proxy_host.empty() || !request.proxy_token.empty() ||
        !request.askpass_pipe.empty()) {
      SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
      std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=protocol\n";
      return kProtocolFailureExitCode;
    }
    runtime_session_id = request.arguments[0];
    runtime_task_id = request.arguments[1];
    runtime_nonce = request.arguments[2];
  }
  std::vector<BYTE> account_sid;
  SidPointer execution_sid = CreateCapabilitySid();
  SidPointer capability_sid = CreateCapabilitySid();
  if (!LookupAccountSid(state.account_name, &account_sid) || !execution_sid ||
      !capability_sid) {
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return kSelfCheckFailureExitCode;
  }

  std::vector<ObjectGrant> manifest_grants;
  std::vector<ProductRoot> journaled_roots;
  manifest_grants.reserve(request.roots.size());
  bool working_directory_granted = false;
  bool private_directory_granted = false;
  bool git_global_config_granted = false;
  bool manifest_valid = true;
  for (const ProductRoot& root : request.roots) {
    bool writable = (root.flags & 1u) != 0;
    bool expect_file = (root.flags & 2u) != 0;
    bool install_account = (root.flags & 4u) != 0;
    if (expect_file && writable) {
      manifest_valid = false;
      break;
    }
    working_directory_granted =
        working_directory_granted ||
        (writable && _wcsicmp(root.path.c_str(),
                              request.working_directory.c_str()) == 0);
    private_directory_granted =
        private_directory_granted ||
        (writable && _wcsicmp(root.path.c_str(),
                              request.private_directory.c_str()) == 0);
    git_global_config_granted =
        git_global_config_granted ||
        (expect_file && _wcsicmp(root.path.c_str(),
                                 request.git_global_config.c_str()) == 0);
    ObjectGrant grant;
    if (install_account && !WriteGrantJournal(state_path, root)) {
      manifest_valid = false;
      break;
    }
    if (install_account) {
      journaled_roots.push_back(root);
    }
    if (!grant.Install(root.path, expect_file, writable, install_account,
                       account_sid.data(), capability_sid.get(),
                       root.device_id, root.file_id)) {
      manifest_valid = false;
      break;
    }
    manifest_grants.push_back(std::move(grant));
  }
  auto revoke_failed_launch = [&]() {
    bool clean = true;
    for (ObjectGrant& grant : manifest_grants) {
      clean = grant.RevokeAll() && clean;
    }
    // journal 是崩溃恢复定位原对象的最后证据；任何 ACE 撤销失败时必须完整保留。
    if (clean) {
      for (const ProductRoot& root : journaled_roots) {
        clean = RemoveGrantJournal(state_path, root) && clean;
      }
    }
    return clean;
  };
  auto fail_launch = [&](DWORD requested_exit_code) {
    bool clean = revoke_failed_launch();
    if (!clean) {
      std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=cleanup\n";
      return static_cast<int>(kCleanupFailureExitCode);
    }
    std::wcerr << L"CODEATELIER_SUPERVISOR_ROLLBACK_COMPLETE\n";
    return static_cast<int>(requested_exit_code);
  };
  if (!manifest_valid || !working_directory_granted ||
      !private_directory_granted || !git_global_config_granted) {
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=manifest\n";
    return fail_launch(kSelfCheckFailureExitCode);
  }
  auto revoke_instance = [&]() {
    bool clean = true;
    for (ObjectGrant& grant : manifest_grants) {
      clean = grant.RevokeInstance() && clean;
    }
    return clean;
  };

  SECURITY_ATTRIBUTES pipe_security{};
  LocalPointer pipe_descriptor;
  std::wstring pipe_name = MakeProductPipeName();
  if (pipe_name.empty() ||
      !BuildPipeSecurity(account_sid.data(), &pipe_security, &pipe_descriptor)) {
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return fail_launch(kSelfCheckFailureExitCode);
  }
  UniqueHandle pipe(CreateNamedPipeW(
      pipe_name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
          PIPE_REJECT_REMOTE_CLIENTS,
      1, 64 * 1024, 64 * 1024, 5000, &pipe_security));
  if (!pipe) {
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return fail_launch(kSelfCheckFailureExitCode);
  }

  std::wstring runtime_pipe_name;
  UniqueHandle runtime_pipe;
  if (agent_runtime) {
    runtime_pipe_name = MakeAgentRuntimePipeName();
    if (runtime_pipe_name.empty()) {
      SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
      return fail_launch(kSelfCheckFailureExitCode);
    }
    runtime_pipe.reset(CreateNamedPipeW(
        runtime_pipe_name.c_str(),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
            PIPE_REJECT_REMOTE_CLIENTS,
        1, 1024 * 1024, 1024 * 1024, 5000, &pipe_security));
    if (!runtime_pipe) {
      SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
      return fail_launch(kSelfCheckFailureExitCode);
    }
    request.arguments = {state.runtime_entry_path, runtime_pipe_name};
    // 固定 Node/entry 从受保护目录启动，并以逐租约私有目录作为初始 CWD；
    // 真正工作区由经过认证的 start_task 帧交给 Runtime，避免 loader 在可写工作区起步。
    request.working_directory = request.private_directory;
  }

  PrivateObjectSecurity object_security;
  UniqueHandle job;
  std::wstring desktop_name;
  UniqueDesktop desktop;
  if (!object_security.Initialize(execution_sid.get()) ||
      !ConfigureProductJob(object_security.attributes(), request.timeout_ms,
                           &job) ||
      !CreatePrivateDesktop(account_sid.data(), execution_sid.get(),
                            capability_sid.get(), &desktop_name, &desktop)) {
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return fail_launch(kSelfCheckFailureExitCode);
  }

  auto askpass_stop = std::make_shared<std::atomic_bool>(false);
  auto askpass_ready = std::make_shared<std::atomic_bool>(false);
  auto host_credential = std::make_shared<HostCredential>();
  std::thread askpass_thread;
  const bool environment_proxy = request.askpass_pipe == L"environment";
  if (!request.askpass_pipe.empty() && !environment_proxy) {
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return fail_launch(kProtocolFailureExitCode);
  }
  request.askpass_pipe.clear();
  if (!request.proxy_url.empty()) {
    if (!environment_proxy) {
      LoadHostCredential(request.proxy_host, host_credential.get());
      request.askpass_pipe = MakeProductPipeName();
      if (request.askpass_pipe.empty()) {
        SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
        return fail_launch(kSelfCheckFailureExitCode);
      }
      askpass_thread = std::thread(
          ServeAskpass, request.askpass_pipe, &pipe_security, job.get(),
          request.proxy_token, host_credential, askpass_stop, askpass_ready);
      auto ready_deadline =
          std::chrono::steady_clock::now() + std::chrono::seconds(5);
      while (!askpass_ready->load() &&
             std::chrono::steady_clock::now() < ready_deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
      if (!askpass_ready->load()) {
        StopAskpass(request.askpass_pipe, askpass_stop, &askpass_thread);
        SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
        return fail_launch(kSelfCheckFailureExitCode);
      }
      SecureZeroMemory(request.proxy_token.data(),
                       request.proxy_token.size() * sizeof(wchar_t));
      request.proxy_token.clear();
    }
  }
  auto stop_askpass = [&]() {
    StopAskpass(request.askpass_pipe, askpass_stop, &askpass_thread);
    SecureZeroMemory(host_credential->password.data(),
                     host_credential->password.size() * sizeof(wchar_t));
    host_credential->password.clear();
  };

  std::wstring executable = CurrentExecutablePath();
  std::vector<std::wstring> bootstrap_arguments = {
      L"--bootstrap", pipe_name, SidToString(execution_sid.get()),
      SidToString(capability_sid.get()), desktop_name};
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
  startup.lpDesktop = const_cast<LPWSTR>(desktop_name.c_str());
  PROCESS_INFORMATION bootstrap{};
  UniqueEnvironment sandbox_environment;
  if (!BuildSandboxEnvironment(state.account_name, password,
                               &sandbox_environment)) {
    stop_askpass();
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return fail_launch(kSelfCheckFailureExitCode);
  }
  BOOL created = CreateProcessWithLogonW(
      state.account_name.c_str(), L".", password.c_str(), 0,
      executable.c_str(), mutable_command.data(),
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
      sandbox_environment.get(),
      request.working_directory.c_str(), &startup, &bootstrap);
  SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
  password.clear();
  if (!created) {
    stop_askpass();
    std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=launch\n";
    return fail_launch(kSelfCheckFailureExitCode);
  }
  UniqueHandle bootstrap_process(bootstrap.hProcess);
  UniqueHandle bootstrap_thread(bootstrap.hThread);
  bool assigned_to_job =
      AssignProcessToJobObject(job.get(), bootstrap_process.get()) != FALSE;
  bool bootstrap_ready =
      assigned_to_job &&
      ResumeThread(bootstrap_thread.get()) != static_cast<DWORD>(-1) &&
      ConnectAndSendRequest(pipe.get(), bootstrap.dwProcessId, request);
  if (!bootstrap_ready) {
    bool terminated = assigned_to_job
                          ? TerminateJobObject(job.get(),
                                               kSelfCheckFailureExitCode) != FALSE
                          : TerminateProcess(bootstrap_process.get(),
                                             kSelfCheckFailureExitCode) != FALSE;
    DWORD stopped = WaitForSingleObject(bootstrap_process.get(), 5000);
    stop_askpass();
    if (!terminated || stopped != WAIT_OBJECT_0) {
      std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=cleanup\n";
      return kCleanupFailureExitCode;
    }
    return fail_launch(kSelfCheckFailureExitCode);
  }

  if (agent_runtime) {
    AgentRuntimeProxyResult proxy_result;
    bool proxy_clean = RunAgentRuntimeProxy(
        runtime_pipe.get(), bootstrap_process.get(), job.get(),
        account_sid.data(), execution_sid.get(), capability_sid.get(), state,
        request, runtime_session_id, runtime_task_id, runtime_nonce,
        &proxy_result);
    if (!proxy_clean) {
      TerminateJobObject(job.get(), kProtocolFailureExitCode);
      if (WaitForSingleObject(bootstrap_process.get(), 5000) != WAIT_OBJECT_0) {
        stop_askpass();
        std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=cleanup\n";
        return kCleanupFailureExitCode;
      }
    }
    stop_askpass();
    bool grants_clean = proxy_result.started ? revoke_instance()
                                               : revoke_failed_launch();
    if (!grants_clean) {
      std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=cleanup\n";
      return kCleanupFailureExitCode;
    }
    if (!proxy_clean) {
      if (!proxy_result.started) {
        std::wcerr << L"CODEATELIER_SUPERVISOR_ROLLBACK_COMPLETE\n";
      }
      std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=protocol\n";
      return kProtocolFailureExitCode;
    }
    std::wcerr << L"CODEATELIER_SUPERVISOR_COMPLETE cancelled="
               << (proxy_result.cancelled ? L"true" : L"false") << L"\n";
    return static_cast<int>(proxy_result.exit_code & 0xff);
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
    if (WaitForSingleObject(bootstrap_process.get(), 5000) != WAIT_OBJECT_0) {
      stop_askpass();
      std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=cleanup\n";
      return kCleanupFailureExitCode;
    }
  }
  DWORD exit_code = 1;
  GetExitCodeProcess(bootstrap_process.get(), &exit_code);
  stop_askpass();
  bool clean = revoke_instance();
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

int RunProductRevoke(const std::wstring& state_path,
                     const std::wstring& network_manager) {
  std::vector<ProductRoot> roots;
  InstallationState state;
  std::wstring password;
  if (!ReadRevokeRoots(GetStdHandle(STD_INPUT_HANDLE), &roots) ||
      !ReadInstallationState(state_path, &state) ||
      !VerifyInstallation(state, network_manager, &password)) {
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=self_check\n";
    return kSelfCheckFailureExitCode;
  }
  SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
  std::vector<BYTE> account_sid;
  if (!LookupAccountSid(state.account_name, &account_sid)) {
    return kSelfCheckFailureExitCode;
  }
  for (const ProductRoot& root : roots) {
    if (!ObjectGrant::RevokeAccount(root.path, (root.flags & 2u) != 0,
                                    account_sid.data(), root.device_id,
                                    root.file_id)) {
      std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=cleanup\n";
      return kCleanupFailureExitCode;
    }
    if (!RemoveGrantJournal(state_path, root)) {
      std::wcerr << L"CODEATELIER_SUPERVISOR_ERROR category=cleanup\n";
      return kCleanupFailureExitCode;
    }
  }
  std::wcout << L"CODEATELIER_REVOKE_OK count=" << roots.size() << L"\n";
  return 0;
}

int RunProductRevokeJournal(const std::wstring& state_path,
                            const std::wstring& network_manager) {
  InstallationState state;
  std::wstring password;
  if (!ReadInstallationState(state_path, &state) ||
      !VerifyInstallation(state, network_manager, &password, false, false,
                          false)) {
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return kSelfCheckFailureExitCode;
  }
  SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
  std::vector<BYTE> account_sid;
  if (!LookupAccountSid(state.account_name, &account_sid)) {
    return kSelfCheckFailureExitCode;
  }
  std::filesystem::path directory =
      std::filesystem::path(state_path).parent_path() / L"grants";
  std::error_code error;
  if (!std::filesystem::exists(directory, error)) {
    return error ? kCleanupFailureExitCode : 0;
  }
  size_t revoked = 0;
  for (const auto& entry : std::filesystem::directory_iterator(directory, error)) {
    if (error || !entry.is_regular_file(error) || error ||
        entry.path().extension() != L".grant") {
      return kCleanupFailureExitCode;
    }
    UniqueHandle journal(CreateFileW(
        entry.path().c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
        nullptr));
    BY_HANDLE_FILE_INFORMATION information{};
    std::vector<ProductRoot> roots;
    if (!journal || !GetFileInformationByHandle(journal.get(), &information) ||
        (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        !ReadRevokeRoots(journal.get(), &roots) || roots.size() != 1 ||
        entry.path().stem().wstring() != roots[0].identity_digest ||
        !ObjectGrant::RevokeAccount(
            roots[0].path, (roots[0].flags & 2u) != 0, account_sid.data(),
            roots[0].device_id, roots[0].file_id)) {
      return kCleanupFailureExitCode;
    }
    journal.reset();
    if (!DeleteFileW(entry.path().c_str())) {
      return kCleanupFailureExitCode;
    }
    revoked += 1;
  }
  std::wcout << L"CODEATELIER_REVOKE_JOURNAL_OK count=" << revoked << L"\n";
  return 0;
}

bool ProcessTokenMatches(HANDLE process, PSID account_sid) {
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &raw_token)) {
    return false;
  }
  UniqueHandle token(raw_token);
  DWORD size = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &size);
  if (size == 0) {
    return false;
  }
  std::vector<BYTE> buffer(size);
  if (!GetTokenInformation(token.get(), TokenUser, buffer.data(), size, &size)) {
    return false;
  }
  return EqualSid(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid,
                  account_sid) != FALSE;
}

int TerminateAccountProcesses(const std::wstring& state_path,
                              const std::wstring& network_manager) {
  InstallationState state;
  std::wstring password;
  if (!ReadInstallationState(state_path, &state) ||
      !VerifyInstallation(state, network_manager, &password, false, false,
                          false)) {
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return kSelfCheckFailureExitCode;
  }
  SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
  std::vector<BYTE> account_sid;
  if (!LookupAccountSid(state.account_name, &account_sid)) {
    return kSelfCheckFailureExitCode;
  }
  UniqueHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot) {
    return kCleanupFailureExitCode;
  }
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  size_t terminated = 0;
  if (Process32FirstW(snapshot.get(), &entry)) {
    do {
      UniqueHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION |
                                           PROCESS_TERMINATE | SYNCHRONIZE,
                                       FALSE, entry.th32ProcessID));
      if (process && ProcessTokenMatches(process.get(), account_sid.data())) {
        if (!TerminateProcess(process.get(), 70) ||
            WaitForSingleObject(process.get(), 5000) != WAIT_OBJECT_0) {
          return kCleanupFailureExitCode;
        }
        terminated += 1;
      }
    } while (Process32NextW(snapshot.get(), &entry));
  }
  std::wcout << L"CODEATELIER_ACCOUNT_PROCESSES_TERMINATED count="
             << terminated << L"\n";
  return 0;
}

int RunAccountRights(const std::wstring& state_path,
                     const std::wstring& network_manager, bool remove) {
  InstallationState state;
  std::wstring password;
  if (!ReadInstallationState(state_path, &state) ||
      !VerifyInstallation(state, network_manager, &password, false, !remove,
                          !remove)) {
    SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
    return kSelfCheckFailureExitCode;
  }
  SecureZeroMemory(password.data(), password.size() * sizeof(wchar_t));
  std::vector<BYTE> account_sid;
  if (!LookupAccountSid(state.account_name, &account_sid) ||
      !ConfigureAccountRights(account_sid.data(), remove) ||
      (!remove && !AccountRightsMatch(account_sid.data()))) {
    return kCleanupFailureExitCode;
  }
  std::wcout << L"CODEATELIER_ACCOUNT_RIGHTS "
             << (remove ? L"REMOVED" : L"INSTALLED") << L"\n";
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc == 2) {
    wchar_t pipe_name[2]{};
    if (GetEnvironmentVariableW(L"CODEATELIER_ASKPASS_PIPE", pipe_name,
                                static_cast<DWORD>(std::size(pipe_name))) > 0) {
      return RunAskpass(argv[1]);
    }
  }
  if (argc == 4 && std::wstring(argv[1]) == L"--self-check") {
    return RunProductSelfCheck(argv[2], argv[3]);
  }
  if (argc == 4 && std::wstring(argv[1]) == L"--revoke") {
    return RunProductRevoke(argv[2], argv[3]);
  }
  if (argc == 4 && std::wstring(argv[1]) == L"--revoke-journal") {
    return RunProductRevokeJournal(argv[2], argv[3]);
  }
  if (argc == 4 &&
      std::wstring(argv[1]) == L"--terminate-account-processes") {
    return TerminateAccountProcesses(argv[2], argv[3]);
  }
  if (argc == 4 && std::wstring(argv[1]) == L"--install-account-rights") {
    return RunAccountRights(argv[2], argv[3], false);
  }
  if (argc == 4 && std::wstring(argv[1]) == L"--remove-account-rights") {
    return RunAccountRights(argv[2], argv[3], true);
  }
  if (argc == 4 && std::wstring(argv[1]) == L"--execute") {
    return RunProductSupervisor(argv[2], argv[3]);
  }
  if (argc == 4 && std::wstring(argv[1]) == L"--launch-agent-runtime") {
    return RunProductSupervisor(argv[2], argv[3], true);
  }
  if (argc == 6 && std::wstring(argv[1]) == L"--bootstrap") {
    return RunProductBootstrap(argv[2], argv[3], argv[4], argv[5]);
  }
  std::wcerr
      << L"CodeAtelier Sandbox supervisor accepts only fixed product modes.\n";
  return kProtocolFailureExitCode;
}
