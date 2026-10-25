// Windows overlay 对象/事务接口，供 WinFsp callbacks 与原生解析测试使用。
// 1. Win32 RAII、错误及 SQLite 查询封装统一资源与失败处理。
// 2. Store 按需导入 lower 元数据，持久化命名空间、删除标记、ACL 和虚拟 inode。
// 3. copy-up 先 flush 私有对象再发布引用；文件 rename 固化内容，目录 rename 保留 live lower。
// 4. security/reparse 接口维护虚拟卷权限和内部链接；finish 仅在状态可信时标记干净卸载。
// 不复制工作目录，不读取 lower .git；来源打开禁止重解析与写访问，控制目录不暴露于挂载。
#pragma once
#include <aclapi.h>
#include <winfsp/winfsp.h>
#include <winsqlite/winsqlite3.h>
#include <winternl.h>

#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace overlay {
namespace fs = std::filesystem;
struct Error {
  NTSTATUS status;
};
void require(bool ok);
void checked(NTSTATUS status);
std::string utf8(const std::wstring& value);
std::wstring wide(const std::string& value);
std::wstring fold(const std::wstring& value);
UINT64 now();
std::vector<BYTE> internalReparse(const void* buffer, size_t size, const fs::path& origin,
                                  const fs::path& root, const fs::path& targetRoot);
std::vector<BYTE> lowerReparse(HANDLE handle, const fs::path& origin, const fs::path& root,
                               const fs::path& targetRoot);

struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  Handle() = default;
  explicit Handle(HANDLE value) : value(value) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept;
  Handle& operator=(Handle&& other) noexcept;
  ~Handle();
};

struct Query {
  sqlite3_stmt* value = nullptr;
  Query(sqlite3* db, const char* sql);
  ~Query();
  Query& number(int index, sqlite3_int64 value);
  Query& text(int index, const std::wstring& value);
  Query& blob(int index, const void* data, int size);
  bool step();
  sqlite3_int64 number(int column);
  std::wstring text(int column);
  std::vector<BYTE> blob(int column);
};

struct Node {
  sqlite3_int64 id = 0;
  sqlite3_int64 parent = 0;
  std::wstring origin;
  std::wstring object;
  FSP_FSCTL_FILE_INFO info{};
  std::vector<BYTE> security;
  std::vector<BYTE> reparse;
  Handle content;
  bool directory() const {
    return (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  }
};
using NodePtr = std::shared_ptr<Node>;
struct Entry {
  std::wstring name;
  NodePtr node;
};

class Store {
 public:
  sqlite3* db = nullptr;
  fs::path source;
  fs::path root;
  fs::path workspace;
  Handle lease;
  Handle lower;
  Handle controlDirectory;
  Handle objectsDirectory;
  std::recursive_mutex mutex;
  UINT32 serial = 0;
  bool poisoned = false;
  std::map<sqlite3_int64, std::weak_ptr<Node>> cache;

  Store(const fs::path& source, const fs::path& root, const fs::path& workspace, bool create);
  ~Store();
  void sql(const char* text);
  NodePtr node(sqlite3_int64 id);
  NodePtr lookup(const std::wstring& path);
  std::wstring name(const NodePtr& node);
  NodePtr child(const NodePtr& parent, const std::wstring& name);
  std::vector<Entry> list(const NodePtr& parent);
  NodePtr create(const std::wstring& path, DWORD attributes, PSECURITY_DESCRIPTOR security);
  void rename(const std::wstring& from, const std::wstring& to, bool replace);
  void remove(const std::wstring& path, sqlite3_int64 expected);
  void promote(const NodePtr& node);
  void save(const NodePtr& node);
  void setSecurity(const NodePtr& node, SECURITY_INFORMATION information,
                   PSECURITY_DESCRIPTOR modification);
  void setReparse(const NodePtr& node, const void* data, size_t size);
  void finish();
  void pinParents(const NodePtr& node);
  std::vector<BYTE> security(const NodePtr& node);
  FSP_FSCTL_FILE_INFO info(const NodePtr& node);
  HANDLE content(const NodePtr& node, bool write);
  Handle openLower(const std::wstring& path,
                   DWORD sharing = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);

 private:
  NodePtr import(const NodePtr& parent, const std::wstring& name, const std::wstring& origin);
  std::pair<NodePtr, std::wstring> parent(const std::wstring& path);
  NodePtr insert(Node value);
  void link(sqlite3_int64 parent, const std::wstring& name, sqlite3_int64 id, bool touch = true);
};
FSP_FILE_SYSTEM_INTERFACE& callbacks();
}  // namespace overlay
