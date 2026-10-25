// GitLower 的常驻 Git 协议实现，仅供 commit lower PoC，源工作目录不参与寻址。
// 1. quote/start 用显式映像、受限继承句柄和 kill-on-close Job 建立二进制管道。
// 2. receive/request 校验有界响应、SHA-1、对象类型与终止状态；失败不重放查询。
// 3. tree 解析一层二进制 tree 并拒绝 Windows 冲突/特殊模式/属性转换；size/blob 按需读取。
// 仅查询本地对象；调用方清理 Git 环境并关闭 lazy fetch/replace，普通 Git index 单独管理。
#include "git-lower.hpp"

#include <algorithm>
#include <cstring>
#include <set>
#include <sstream>

namespace overlay {
static std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') {
      ++slashes;
      continue;
    }
    result.append(slashes * (character == L'"' ? 2 : 1), L'\\');
    slashes = 0;
    if (character == L'"') {
      result += L'\\';
    }
    result += character;
  }
  result.append(slashes * 2, L'\\');
  return result + L'"';
}

GitLower::GitLower(const fs::path& executable, const fs::path& gitDirectory) {
  if (!executable.is_absolute() || !gitDirectory.is_absolute()) {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  HANDLE read = INVALID_HANDLE_VALUE;
  HANDLE write = INVALID_HANDLE_VALUE;
  require(CreatePipe(&read, &write, &security, 0));
  Handle childInput(read);
  input = Handle(write);
  require(SetHandleInformation(input.value, HANDLE_FLAG_INHERIT, 0));
  require(CreatePipe(&read, &write, &security, 0));
  output = Handle(read);
  Handle childOutput(write);
  require(SetHandleInformation(output.value, HANDLE_FLAG_INHERIT, 0));
  Handle error(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(error.value != INVALID_HANDLE_VALUE);

  job = Handle(CreateJobObjectW(nullptr, nullptr));
  require(job.value != INVALID_HANDLE_VALUE);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits,
                                  sizeof(limits)));
  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
  std::vector<BYTE> attributes(attributeSize);
  auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  require(InitializeProcThreadAttributeList(list, 1, 0, &attributeSize));
  struct AttributeCleanup {
    LPPROC_THREAD_ATTRIBUTE_LIST value;
    ~AttributeCleanup() {
      DeleteProcThreadAttributeList(value);
    }
  } cleanup{list};
  HANDLE inherited[] = {childInput.value, childOutput.value, error.value};
  require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                    sizeof(inherited), nullptr, nullptr));
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = childInput.value;
  startup.StartupInfo.hStdOutput = childOutput.value;
  startup.StartupInfo.hStdError = error.value;
  startup.lpAttributeList = list;
  std::wstring command = quote(executable.wstring()) + L" --git-dir=" +
                         quote(gitDirectory.wstring()) + L" cat-file --batch-command";
  PROCESS_INFORMATION created{};
  require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                         CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                         nullptr, gitDirectory.c_str(), &startup.StartupInfo, &created));
  process = Handle(created.hProcess);
  Handle thread(created.hThread);
  if (!AssignProcessToJobObject(job.value, process.value)) {
    auto failure = GetLastError();
    TerminateProcess(process.value, 1);
    throw Error{FspNtStatusFromWin32(failure)};
  }
  require(ResumeThread(thread.value) != static_cast<DWORD>(-1));
}

void GitLower::receive(void* destination, size_t size) {
  auto bytes = static_cast<BYTE*>(destination);
  auto deadline = GetTickCount64() + 30000;
  unsigned spins = 0;
  while (size) {
    if (!pending.empty()) {
      auto count = std::min(size, pending.size());
      memcpy(bytes, pending.data(), count);
      pending.erase(0, count);
      bytes += count;
      size -= count;
      continue;
    }
    DWORD available = 0;
    require(PeekNamedPipe(output.value, nullptr, 0, nullptr, &available, nullptr));
    if (!available) {
      if (WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT || GetTickCount64() > deadline) {
        throw Error{STATUS_IO_TIMEOUT};
      }
      if (++spins < 1000) {
        SwitchToThread();
      } else {
        Sleep(1);
      }
      continue;
    }
    spins = 0;
    char buffer[65536];
    DWORD received = 0;
    require(ReadFile(output.value, buffer,
                     static_cast<DWORD>(std::min<size_t>(sizeof(buffer), available)), &received,
                     nullptr));
    if (!received) {
      throw Error{STATUS_UNEXPECTED_IO_ERROR};
    }
    pending.assign(buffer, received);
  }
}

std::string GitLower::line() {
  std::string result;
  for (size_t index = 0; index < 200; ++index) {
    char character = 0;
    receive(&character, 1);
    if (character == '\n') {
      return result;
    }
    result += character;
  }
  throw Error{STATUS_FILE_CORRUPT_ERROR};
}

UINT64 GitLower::request(const std::wstring& oid, const char* type, bool contents) {
  if (oid.size() != 40 || oid.find_first_not_of(L"0123456789abcdef") != std::wstring::npos) {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  auto command = std::string(contents ? "contents " : "info ") + utf8(oid) + "\n";
  DWORD written = 0;
  require(WriteFile(input.value, command.data(), static_cast<DWORD>(command.size()), &written,
                    nullptr));
  if (written != command.size()) {
    throw Error{STATUS_UNEXPECTED_IO_ERROR};
  }
  std::istringstream header(line());
  std::string actualOid;
  std::string actualType;
  UINT64 length = 0;
  if (!(header >> actualOid >> actualType >> length) || actualOid != utf8(oid) ||
      actualType != type) {
    throw Error{STATUS_FILE_CORRUPT_ERROR};
  }
  return length;
}

std::vector<BYTE> GitLower::object(const std::wstring& oid, const char* type, size_t limit) {
  auto length = request(oid, type, true);
  if (length > limit) {
    // The pending body makes this pipe unusable. Do not guess where a new response begins.
    TerminateJobObject(job.value, 1);
    throw Error{STATUS_FILE_TOO_LARGE};
  }
  std::vector<BYTE> result(static_cast<size_t>(length));
  receive(result.data(), result.size());
  char end = 0;
  receive(&end, 1);
  if (end != '\n') {
    throw Error{STATUS_FILE_CORRUPT_ERROR};
  }
  return result;
}

const std::vector<GitEntry>& GitLower::tree(const std::wstring& oid) {
  if (auto found = trees.find(oid); found != trees.end()) {
    return found->second;
  }
  auto bytes = object(oid, "tree", 32 * 1024 * 1024);
  ++metrics.treeReads;
  std::vector<GitEntry> entries;
  std::set<std::wstring> names;
  size_t offset = 0;
  while (offset < bytes.size()) {
    auto end = std::find(bytes.begin() + offset, bytes.end(), 0);
    auto length = static_cast<size_t>(end - bytes.begin()) - offset;
    if (end == bytes.end() || length < 3 || bytes.size() - offset - length - 1 < 20) {
      throw Error{STATUS_FILE_CORRUPT_ERROR};
    }
    std::string entry(reinterpret_cast<const char*>(bytes.data() + offset), length);
    auto space = entry.find(' ');
    auto mode = entry.substr(0, space);
    auto name = wide(entry.substr(space + 1));
    auto dot = name.find(L'.');
    auto stem = name.empty() || dot == 0 ? L"" : fold(name.substr(0, dot));
    bool device = stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" ||
                  (stem.size() == 4 && (stem.rfind(L"COM", 0) == 0 || stem.rfind(L"LPT", 0) == 0) &&
                   stem[3] >= L'1' && stem[3] <= L'9');
    if (space == std::string::npos || (mode != "40000" && mode != "100644" && mode != "100755") ||
        name.empty() || name.size() > 255 || device ||
        name.find_first_of(L"\\/:*?\"<>|") != std::wstring::npos || name.back() == L'.' ||
        name.back() == L' ' || fold(name) == L".GIT" || fold(name) == L".GITATTRIBUTES" ||
        fold(name) == L".GITMODULES" || !names.insert(fold(name)).second) {
      throw Error{STATUS_NOT_SUPPORTED};
    }
    offset += length + 1;
    constexpr wchar_t hex[] = L"0123456789abcdef";
    std::wstring child;
    for (size_t index = 0; index < 20; ++index) {
      child += hex[bytes[offset + index] >> 4];
      child += hex[bytes[offset + index] & 15];
    }
    offset += 20;
    entries.push_back({name, child, mode == "40000"});
  }
  return trees.emplace(oid, std::move(entries)).first->second;
}

UINT64 GitLower::size(const std::wstring& oid) {
  if (auto found = sizes.find(oid); found != sizes.end()) {
    return found->second;
  }
  auto length = request(oid, "blob", false);
  ++metrics.infoReads;
  sizes.emplace(oid, length);
  return length;
}

const std::vector<BYTE>& GitLower::blob(const std::wstring& oid) {
  if (oid != lastOid) {
    lastBlob = object(oid, "blob", 128 * 1024 * 1024);
    lastOid = oid;
    ++metrics.blobReads;
    metrics.blobBytes += lastBlob.size();
  }
  return lastBlob;
}
}  // namespace overlay
