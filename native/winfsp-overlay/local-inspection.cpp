// Local 异常私有卷的原生离线检查租约，供 helper 启停及显式恢复读取使用。
// 1. 记录版本、helper/宿主 PID 与创建时间；mount.lock 由 Store 持排他句柄，记录先 flush 再服务。
// 2. 正常收尾才记 closed；检查始终要求旧 helper 退出，active 还要求旧宿主退出，PID 复用按创建时间区分。
// 3. 检查固定控制目录祖先/objects/baselines，拒绝链接/共享锁/无记录/权限未知，终态只等待 stop。
// 不打开来源、不改数据库或旧记录、不挂载、不解除服务 .lock；不推导 Runtime 子进程已排空。
#include "local-inspection.hpp"

#include <iostream>
#include <sstream>

namespace overlay {
namespace {
struct MountOwner {
  std::string state;
  DWORD owner = 0;
  UINT64 ownerCreated = 0;
  DWORD helper = 0;
  UINT64 helperCreated = 0;
};

UINT64 creationTime(HANDLE process) {
  FILETIME start{}, end{}, kernel{}, user{};
  require(GetProcessTimes(process, &start, &end, &kernel, &user));
  return (static_cast<UINT64>(start.dwHighDateTime) << 32) | start.dwLowDateTime;
}

bool gone(DWORD pid, UINT64 expected) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  if (!process.value) {
    if (GetLastError() == ERROR_INVALID_PARAMETER) {
      return true;
    }
    throw Error{STATUS_ACCESS_DENIED};
  }
  if (creationTime(process.value) != expected) {
    return true;
  }
  auto state = WaitForSingleObject(process.value, 0);
  if (state != WAIT_OBJECT_0 && state != WAIT_TIMEOUT) {
    throw Error{STATUS_UNSUCCESSFUL};
  }
  return state == WAIT_OBJECT_0;
}

MountOwner readOwner(HANDLE file) {
  LARGE_INTEGER size{};
  require(GetFileSizeEx(file, &size));
  if (size.QuadPart < 1 || size.QuadPart > 256) {
    throw Error{STATUS_FILE_INVALID};
  }
  LARGE_INTEGER zero{};
  require(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN));
  std::string data(static_cast<size_t>(size.QuadPart), '\0');
  DWORD count = 0;
  require(ReadFile(file, data.data(), static_cast<DWORD>(data.size()), &count, nullptr));
  require(count == data.size());
  std::istringstream input(data);
  std::string format;
  std::string extra;
  MountOwner record;
  if (!(input >> format >> record.state >> record.owner >> record.ownerCreated >> record.helper >>
        record.helperCreated) || input >> extra || format != "local-owner-v1" ||
      (record.state != "active" && record.state != "closed") || !record.owner ||
      !record.ownerCreated || !record.helper || !record.helperCreated) {
    throw Error{STATUS_FILE_INVALID};
  }
  return record;
}

void saveOwner(HANDLE file, const MountOwner& record) {
  std::ostringstream output;
  output << "local-owner-v1 " << record.state << ' ' << record.owner << ' ' << record.ownerCreated
         << ' ' << record.helper << ' ' << record.helperCreated << '\n';
  auto data = output.str();
  LARGE_INTEGER zero{};
  require(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN));
  DWORD count = 0;
  require(WriteFile(file, data.data(), static_cast<DWORD>(data.size()), &count, nullptr));
  require(count == data.size());
  require(SetEndOfFile(file));
  require(FlushFileBuffers(file));
}

void pinDirectory(const fs::path& path, std::vector<Handle>& handles) {
  Handle directory(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
                                FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(directory.value != INVALID_HANDLE_VALUE);
  BY_HANDLE_FILE_INFORMATION info{};
  require(GetFileInformationByHandle(directory.value, &info));
  if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  handles.push_back(std::move(directory));
}
}  // namespace

void recordLocalMount(HANDLE file, DWORD owner) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, owner));
  require(process.value != nullptr && WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT);
  saveOwner(file, {"active", owner, creationTime(process.value), GetCurrentProcessId(),
                   creationTime(GetCurrentProcess())});
}

void closeLocalMount(HANDLE file) {
  auto record = readOwner(file);
  if (record.helper != GetCurrentProcessId() || record.helperCreated != creationTime(GetCurrentProcess())) {
    throw Error{STATUS_FILE_INVALID};
  }
  record.state = "closed";
  saveOwner(file, record);
}

void inspectLocal(const fs::path& control) {
  if (!control.is_absolute() || control.wstring().rfind(L"\\\\", 0) == 0 ||
      control.lexically_normal() != control || control.root_name().wstring().size() != 2) {
    throw Error{STATUS_OBJECT_NAME_INVALID};
  }
  std::vector<Handle> pinned;
  auto ancestor = control.root_path();
  pinDirectory(ancestor, pinned);
  for (const auto& part : control.relative_path()) {
    ancestor /= part;
    pinDirectory(ancestor, pinned);
  }
  pinDirectory(control / L"objects", pinned);
  pinDirectory(control / L"baselines", pinned);
  Handle file(CreateFileW((control / L"mount.lock").c_str(), GENERIC_READ, 0, nullptr,
                           OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(file.value != INVALID_HANDLE_VALUE);
  BY_HANDLE_FILE_INFORMATION info{};
  require(GetFileInformationByHandle(file.value, &info));
  if (info.nNumberOfLinks != 1 ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  auto record = readOwner(file.value);
  if (!gone(record.helper, record.helperCreated) ||
      (record.state == "active" && !gone(record.owner, record.ownerCreated))) {
    throw Error{STATUS_SHARING_VIOLATION};
  }
  std::cout << "{\"version\":1,\"state\":\"local-inspection-ready\"}\n" << std::flush;
  std::string command;
  if (!std::getline(std::cin, command) || command != "stop") {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  std::cout << "{\"version\":1,\"state\":\"local-inspection-closed\"}\n" << std::flush;
}
}  // namespace overlay
