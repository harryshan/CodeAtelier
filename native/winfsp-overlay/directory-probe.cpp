// Win32 directory enumeration probe for the manual Local WinFsp verifier.
// 1. Read a mounted directory through 512-byte FileIdBothDirectoryInfo pages.
// 2. Change the owned lower fixture between pages; continuation retains the initial
//    names/metadata, whereas a second handle and explicit restart see the new source.
// 3. Check Unicode completeness, private additions/whiteouts and empty-directory EOF.
// Only the two explicit fixture paths are accessed; this program does not mount, publish,
// install drivers or delete fixture trees. Handles close through RAII on every outcome.
#include <Windows.h>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <string>

namespace fs = std::filesystem;
using Listing = std::map<std::wstring, LONGLONG>;

static void check(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

struct Directory {
  HANDLE handle;
  explicit Directory(const fs::path& path) {
    handle = CreateFileW(path.c_str(), FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE |
                           FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS,
                         nullptr);
    check(handle != INVALID_HANDLE_VALUE, "Open directory failed");
  }
  Directory(const Directory&) = delete;
  Directory& operator=(const Directory&) = delete;
  ~Directory() {
    CloseHandle(handle);
  }
};

static bool page(Directory& directory, bool restart, Listing& result) {
  alignas(8) BYTE buffer[512]{};
  if (!GetFileInformationByHandleEx(directory.handle,
        restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
        buffer, sizeof(buffer))) {
    check(GetLastError() == ERROR_NO_MORE_FILES, "Directory query failed unexpectedly");
    return false;
  }
  size_t offset = 0;
  for (;;) {
    check(offset + FIELD_OFFSET(FILE_ID_BOTH_DIR_INFO, FileName) <= sizeof(buffer), "Invalid entry");
    const auto entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer + offset);
    check(entry->FileNameLength % sizeof(wchar_t) == 0 &&
          offset + FIELD_OFFSET(FILE_ID_BOTH_DIR_INFO, FileName) + entry->FileNameLength <= sizeof(buffer),
          "Invalid name length");
    const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
    if (name != L"." && name != L"..") {
      check(name != L".git", "Git metadata visible");
      check(result.emplace(name, entry->EndOfFile.QuadPart).second, "Duplicate directory entry");
    }
    if (!entry->NextEntryOffset) {
      break;
    }
    check(entry->NextEntryOffset >= FIELD_OFFSET(FILE_ID_BOTH_DIR_INFO, FileName), "Invalid offset");
    offset += entry->NextEntryOffset;
  }
  return true;
}

static void drain(Directory& directory, Listing& entries) {
  size_t pages = 0;
  while (page(directory, false, entries)) {
    check(++pages < 10000, "Directory query failed to reach EOF");
  }
}

static Listing restarted(Directory& directory) {
  Listing entries;
  if (page(directory, true, entries)) {
    drain(directory, entries);
  }
  return entries;
}

static void put(const fs::path& file, const std::string& contents) {
  std::ofstream output(file, std::ios::binary);
  output << contents;
  check(output.good(), "Fixture write failed");
}

static std::set<std::wstring> names(const Listing& entries) {
  std::set<std::wstring> result;
  for (const auto& [name, size] : entries) {
    result.insert(name);
  }
  return result;
}

int wmain(int argc, wchar_t** argv) {
  try {
    check(argc == 3, "Expected mounted view and owned source fixture");
    const fs::path workspace(argv[1]);
    const fs::path source(argv[2]);
    std::set<std::wstring> expected;
    for (const auto& entry : fs::directory_iterator(source)) {
      if (entry.path().filename() != L".git") {
        expected.insert(entry.path().filename().wstring());
      }
    }
    check(expected.size() > 1000, "Fixture does not exercise pagination");
    Directory first(workspace);
    Listing initial;
    check(page(first, true, initial), "Initial page missing");
    check(initial.size() < expected.size(), "Fixture did not paginate");
    put(source / L"late.txt", "late");
    put(source / L"f0000.txt", "updated source metadata");
    check(fs::remove(source / L"f1499.txt"), "Fixture deletion failed");
    auto current = expected;
    current.insert(L"late.txt");
    current.erase(L"f1499.txt");
    {
      Directory second(workspace);
      check(names(restarted(second)) == current, "Second handle did not see current source");
    }
    drain(first, initial);
    check(names(initial) == expected, "Continuation changed the original enumeration");
    check(initial.at(L"f0000.txt") == 1, "Continuation did not preserve initial metadata");
    const auto refreshed = restarted(first);
    check(names(refreshed) == current, "Explicit restart did not refresh source");
    check(refreshed.at(L"f0000.txt") == 23, "Restart returned stale file size");

    put(workspace / L"upper.txt", "private");
    check(DeleteFileW((workspace / L"f0001.txt").c_str()), "Private whiteout failed");
    current.insert(L"upper.txt");
    current.erase(L"f0001.txt");
    check(names(restarted(first)) == current, "Restart ignored private namespace changes");
    check(fs::exists(source / L"f0001.txt"), "Whiteout deleted the source");
    check(!fs::exists(source / L"upper.txt"), "Private addition escaped to source");
    Directory empty(workspace / L"empty");
    check(restarted(empty).empty(), "Empty directory did not terminate cleanly");
    std::cout << "{\"passed\":true,\"initialEntries\":" << expected.size()
              << ",\"bufferBytes\":512,\"continuationSnapshot\":true,\"restartFresh\":true,"
              << "\"independentHandles\":true,\"privateNamespace\":true,\"emptyEof\":true}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "DIRECTORY_PROBE FAILED " << error.what() << "\n";
    return 1;
  }
}
