// Windows 来源发布执行租约，供宿主 Publisher 和未知恢复检查使用。
// 1. openGate 固定普通本地文件/父目录并拒绝共享打开，避免恢复与既有 helper 同时执行。
// 2. readRecord/processGone 校验有界记录及 PID+创建时间+终止状态；未知身份不自动接管。
// 3. publicationSession 在单线程 stdin 协议内调用所有来源副作用；没有短命令子进程。
// 4. 显式 finish 才 flush closed；EOF/协议失败仍 active。检查模式不改旧记录/来源，仅可按哈希释放固定协调锁。
// 5. 每项失败返回固定状态并封闭后续写命令；允许 finish 证明执行已排空，不等于批次成功。
// 6. v2 记录在首次来源副作用前 flush mutated；旧 v1 一律按可能写入处理，缺失 journal 不是未开始证明。
// 普通 OS 权限约束仍适用；不排除外部宿主写者，不承诺多文件原子提交或断电持久性。
#include "publication-lease.hpp"
#include "publish.hpp"
#include "store.hpp"
#include <iostream>
#include <sstream>

namespace overlay {
namespace {
struct Record {
  std::string state;
  DWORD owner = 0;
  UINT64 ownerCreated = 0;
  DWORD helper = 0;
  UINT64 helperCreated = 0;
  std::string generation;
  bool mutated = false;
};

UINT64 created(HANDLE process) {
  FILETIME start{}, end{}, kernel{}, user{};
  require(GetProcessTimes(process, &start, &end, &kernel, &user));
  return (static_cast<UINT64>(start.dwHighDateTime) << 32) | start.dwLowDateTime;
}

bool processGone(DWORD pid, UINT64 expected) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  if (!process.value) {
    if (GetLastError() == ERROR_INVALID_PARAMETER) {
      return true;
    }
    throw Error{STATUS_ACCESS_DENIED};
  }
  if (created(process.value) != expected) {
    return true;
  }
  auto state = WaitForSingleObject(process.value, 0);
  if (state == WAIT_OBJECT_0) {
    return true;
  }
  if (state != WAIT_TIMEOUT) {
    throw Error{STATUS_UNSUCCESSFUL};
  }
  return false;
}

bool identifier(const std::string& value) {
  return value.size() == 36 && value.find_first_not_of("0123456789abcdef-") == std::string::npos;
}

Record readRecord(HANDLE file) {
  LARGE_INTEGER size{};
  require(GetFileSizeEx(file, &size));
  if (size.QuadPart < 1 || size.QuadPart > 512) {
    throw Error{STATUS_FILE_INVALID};
  }
  std::string bytes(static_cast<size_t>(size.QuadPart), '\0');
  DWORD count = 0;
  require(ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr));
  if (count != bytes.size()) {
    throw Error{STATUS_FILE_INVALID};
  }
  std::istringstream input(bytes);
  unsigned version = 0;
  Record record;
  std::string extra;
  if (!(input >> version >> record.state >> record.owner >> record.ownerCreated >> record.helper >>
        record.helperCreated >> record.generation) || (version != 1 && version != 2) ||
      (record.state != "active" && record.state != "closed") || !record.owner || !record.ownerCreated ||
      !record.helper || !record.helperCreated || !identifier(record.generation)) {
    throw Error{STATUS_FILE_INVALID};
  }
  unsigned mutation = 1;
  if ((version == 2 && (!(input >> mutation) || mutation > 1)) || input >> extra) {
    throw Error{STATUS_FILE_INVALID};
  }
  record.mutated = mutation != 0;
  return record;
}

void writeRecord(HANDLE file, const Record& record) {
  std::ostringstream output;
  output << "2 " << record.state << ' ' << record.owner << ' ' << record.ownerCreated << ' '
         << record.helper << ' ' << record.helperCreated << ' ' << record.generation << ' '
         << (record.mutated ? 1 : 0) << '\n';
  auto bytes = output.str();
  LARGE_INTEGER zero{};
  require(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN));
  DWORD count = 0;
  require(WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr));
  require(count == bytes.size());
  require(SetEndOfFile(file));
  require(FlushFileBuffers(file));
}

Handle openGate(const fs::path& file, std::vector<Handle>& parents, bool& fresh, bool inspection) {
  if (!file.is_absolute() || file.wstring().rfind(L"\\\\", 0) == 0 ||
      file.lexically_normal() != file || file.root_name().wstring().size() != 2) {
    throw Error{STATUS_OBJECT_NAME_INVALID};
  }
  auto parent = file.root_path();
  auto pin = [&]() {
    Handle handle(CreateFileW(parent.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(handle.value != INVALID_HANDLE_VALUE);
    BY_HANDLE_FILE_INFORMATION info{};
    require(GetFileInformationByHandle(handle.value, &info));
    if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
      throw Error{STATUS_NOT_SUPPORTED};
    }
    parents.push_back(std::move(handle));
  };
  pin();
  for (const auto& part : file.parent_path().relative_path()) {
    parent /= part;
    pin();
  }
  Handle handle(CreateFileW(file.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                            inspection ? OPEN_EXISTING : OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  auto error = GetLastError();
  require(handle.value != INVALID_HANDLE_VALUE);
  fresh = !inspection && error != ERROR_ALREADY_EXISTS;
  BY_HANDLE_FILE_INFORMATION info{};
  require(GetFileInformationByHandle(handle.value, &info));
  if (info.nNumberOfLinks != 1 || info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  return handle;
}

std::wstring decoded(const std::string& value) {
  if (value.empty() || value.size() > 32768 || value.size() % 2 ||
      value.find_first_not_of("0123456789abcdef") != std::string::npos) {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  std::string bytes;
  const std::string digits = "0123456789abcdef";
  for (size_t i = 0; i < value.size(); i += 2) {
    bytes += static_cast<char>(digits.find(value[i]) * 16 + digits.find(value[i + 1]));
  }
  if (bytes.find('\0') != std::string::npos) {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  return wide(bytes);
}
}  // namespace

void publicationSession(const std::wstring& gate, const std::wstring& generation,
                        unsigned long owner, bool inspection) {
  const auto token = utf8(generation);
  if (!identifier(token) || !owner) {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  std::vector<Handle> parents;
  bool fresh = false;
  auto file = openGate(gate, parents, fresh, inspection);
  bool previousMutation = false;
  if (!fresh) {
    auto previous = readRecord(file.value);
    previousMutation = previous.mutated;
    if (inspection && previous.generation != token) {
      throw Error{STATUS_FILE_INVALID};
    }
    // A released OS file handle alone does not prove a terminated process has
    // drained every kernel operation. Validate the old helper's termination too.
    if (!processGone(previous.helper, previous.helperCreated) ||
        (previous.state == "active" && !processGone(previous.owner, previous.ownerCreated))) {
      throw Error{STATUS_SHARING_VIOLATION};
    }
  }
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, owner));
  require(process.value != nullptr);
  Record current{"active", owner, created(process.value), GetCurrentProcessId(), created(GetCurrentProcess()), token};
  if (!inspection) {
    writeRecord(file.value, current);
  }
  std::cout << "{\"version\":1,\"state\":\"publication-ready\",\"generation\":\"" << token
            << "\",\"mutated\":" << (inspection && previousMutation ? "true" : "false") << "}\n" << std::flush;
  auto beginWrite = [&]() {
    if (!current.mutated) {
      current.mutated = true;
      writeRecord(file.value, current);
    }
  };
  bool failed = false;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.size() > 128 * 1024) {
      throw Error{STATUS_INVALID_PARAMETER};
    }
    if (line == "finish") {
      if (!inspection) {
        current.state = "closed";
        writeRecord(file.value, current);
      }
      std::cout << "{\"version\":1,\"state\":\"publication-closed\"}\n" << std::flush;
      return;
    }
    try {
      if (inspection && !failed && line.rfind("release-lock ", 0) == 0) {
        publishDelete((fs::path(gate).parent_path() / L"publish.lock").wstring(), wide(line.substr(13)));
        std::cout << "{\"version\":1,\"state\":\"lock-released\"}\n" << std::flush;
        continue;
      }
      if (inspection || failed) {
        throw Error{STATUS_INVALID_PARAMETER};
      }
      std::istringstream input(line);
      std::string operation, a, b, c, d, extra;
      input >> operation >> a >> b >> c;
      if (operation == "replace") {
        if (!(input >> d) || input >> extra) { throw Error{STATUS_INVALID_PARAMETER}; }
        beginWrite();
        auto backup = publishReplace(decoded(a), decoded(b), wide(c), wide(d));
        std::cout << "{\"version\":1,\"state\":\"published\",\"backupIdentity\":\"" << utf8(backup) << "\"}\n";
      } else if (operation == "create" && !(input >> extra)) {
        beginWrite();
        publishCreate(decoded(a), decoded(b), wide(c));
        std::cout << "{\"version\":1,\"state\":\"created\"}\n";
      } else if (operation == "delete" && c.empty()) {
        beginWrite();
        publishDelete(decoded(a), wide(b));
        std::cout << "{\"version\":1,\"state\":\"deleted\"}\n";
      } else if (operation == "cleanup" && !(input >> extra)) {
        beginWrite();
        publishCleanup(decoded(a), wide(b), wide(c));
        std::cout << "{\"version\":1,\"state\":\"cleaned\"}\n";
      } else {
        throw Error{STATUS_INVALID_PARAMETER};
      }
    } catch (const Error& error) {
      failed = true;
      std::cout << "{\"version\":1,\"error\":\"native\",\"status\":" << static_cast<ULONG>(error.status) << "}\n";
    }
    std::cout << std::flush;
  }
}
}  // namespace overlay
