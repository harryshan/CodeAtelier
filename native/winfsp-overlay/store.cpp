// Store 的 Windows/SQLite 实现；宿主 helper 持有 lower 与控制目录租约，所有调用串行。
// 1. UTF/句柄/Query 和 Transaction 管理 Win32/数据库操作；累计计量拆分 SQL 与对象读取耗时。
//    Git/Local 每种固定 SQL 缓存一个空闲 statement，Local 最多 128 种；嵌套独立借用。
//    归还时 reset/清除绑定，错误实例丢弃；关闭连接前全部释放，不缓存查询结果。
// 2. 构造函数验证来源身份和持久格式，按需导入对象并合并目录；lower .git 永远遮蔽。
//    Local 的目录枚举在同一事务导入新条目；独立 lookup 仍逐项提交，失败回滚污染保护不变。
// 3. create/promote/rename/remove 持久化私有状态；旧对象保留，崩溃不猜测或回写 lower。
// 4. security 用 Windows 继承算法合成 DACL，SetSecurity 只保存描述符，不改来源 ACL。
// 5. 可选 GitLower 按目录事务导入不可变树，read 直接返回 blob，只有写入才物化对象。
// 6. Local 模式独立格式和保留名称校验避免旧私有 gitfile 路径混入无仓库视图。
//    changes.cpp 保存按需读版本和不可变基线；内容/命名空间修改在副作用前调用 capture。
//    Local v6 按观察代次和对象来源保留跨轮依赖；旧实验格式不自动迁移。
#include "store.hpp"

#include <objbase.h>

#include <algorithm>
#include <chrono>
#include <cstring>

#include "git-lower.hpp"

namespace overlay {
QueryMetrics queryMetrics;

UINT64 monotonicMicros() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

void require(bool ok) {
  if (!ok) {
    throw Error{FspNtStatusFromWin32(GetLastError())};
  }
}

void checked(NTSTATUS value) {
  if (!NT_SUCCESS(value)) {
    throw Error{value};
  }
}

UINT64 now() {
  FILETIME time;
  GetSystemTimeAsFileTime(&time);
  return (static_cast<UINT64>(time.dwHighDateTime) << 32) | time.dwLowDateTime;
}

std::string utf8(const std::wstring& value) {
  if (value.empty()) {
    return {};
  }
  int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                   static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  require(length != 0);
  std::string output(length, '\0');
  require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                              static_cast<int>(value.size()), output.data(), length, nullptr,
                              nullptr) != 0);
  return output;
}

std::wstring wide(const std::string& value) {
  if (value.empty()) {
    return {};
  }
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                   static_cast<int>(value.size()), nullptr, 0);
  require(length != 0);
  std::wstring output(length, L'\0');
  require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                              static_cast<int>(value.size()), output.data(), length) != 0);
  return output;
}

std::wstring fold(const std::wstring& value) {
  std::wstring output(value.size(), L'\0');
  require(LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_UPPERCASE, value.data(),
                        static_cast<int>(value.size()), output.data(),
                        static_cast<int>(output.size()), nullptr, nullptr, 0) != 0);
  return output;
}

Handle::Handle(Handle&& other) noexcept : value(other.value) {
  other.value = INVALID_HANDLE_VALUE;
}

Handle& Handle::operator=(Handle&& other) noexcept {
  if (this != &other) {
    if (value != INVALID_HANDLE_VALUE) {
      CloseHandle(value);
    }
    value = other.value;
    other.value = INVALID_HANDLE_VALUE;
  }
  return *this;
}

Handle::~Handle() {
  if (value != INVALID_HANDLE_VALUE) {
    CloseHandle(value);
  }
}

static void sqlite(int result) {
  if (result != SQLITE_OK) {
    throw Error{result == SQLITE_FULL ? STATUS_DISK_FULL : STATUS_UNEXPECTED_IO_ERROR};
  }
}

Query::Query(Store& store, const char* sql) {
  if (store.git || (store.localMode &&
                    (store.statements.contains(sql) || store.statements.size() < 128))) {
    pooled = &store.statements[sql];
    value = *pooled;
    *pooled = nullptr;
    if (value) {
      return;
    }
  }
  auto start = monotonicMicros();
  ++queryMetrics.prepares;
  auto result = sqlite3_prepare_v2(store.db, sql, -1, &value, nullptr);
  queryMetrics.prepareMicros += monotonicMicros() - start;
  sqlite(result);
}

Query::~Query() {
  // Reset releases read cursors/locks. Clear every binding before reuse; an
  // error or an already idle instance of this SQL falls back to finalization.
  if (pooled && !*pooled && sqlite3_reset(value) == SQLITE_OK &&
      sqlite3_clear_bindings(value) == SQLITE_OK) {
    *pooled = value;
  } else {
    sqlite3_finalize(value);
  }
}

Query& Query::number(int index, sqlite3_int64 number) {
  sqlite(sqlite3_bind_int64(value, index, number));
  return *this;
}

Query& Query::text(int index, const std::wstring& text) {
  auto bytes = utf8(text);
  sqlite(sqlite3_bind_text(value, index, bytes.data(), static_cast<int>(bytes.size()),
                           SQLITE_TRANSIENT));
  return *this;
}

Query& Query::blob(int index, const void* data, int size) {
  sqlite(sqlite3_bind_blob(value, index, data, size, SQLITE_TRANSIENT));
  return *this;
}

bool Query::step() {
  auto start = monotonicMicros();
  int result = sqlite3_step(value);
  auto elapsed = monotonicMicros() - start;
  if (sqlite3_stmt_readonly(value)) {
    ++queryMetrics.reads;
    queryMetrics.readMicros += elapsed;
  } else {
    ++queryMetrics.writes;
    queryMetrics.writeMicros += elapsed;
  }
  if (result == SQLITE_ROW) {
    return true;
  }
  if (result != SQLITE_DONE) {
    sqlite(result);
  }
  return false;
}

sqlite3_int64 Query::number(int column) {
  return sqlite3_column_int64(value, column);
}

std::wstring Query::text(int column) {
  auto text = sqlite3_column_text(value, column);
  return text ? wide(reinterpret_cast<const char*>(text)) : L"";
}

std::vector<BYTE> Query::blob(int column) {
  auto data = static_cast<const BYTE*>(sqlite3_column_blob(value, column));
  int size = sqlite3_column_bytes(value, column);
  return size ? std::vector<BYTE>(data, data + size) : std::vector<BYTE>{};
}

struct Transaction {
  Store& store;
  bool done = false;
  explicit Transaction(Store& store) : store(store) {
    store.sql("BEGIN IMMEDIATE");
  }
  void commit() {
    try {
      store.sql("COMMIT");
      done = true;
    } catch (...) {
      store.poisoned = true;
      throw;
    }
  }
  ~Transaction() {
    if (!done) {
      // Shared open nodes may contain tentative metadata. Never reuse them
      // after rollback.
      store.poisoned = true;
      sqlite3_exec(store.db, "ROLLBACK", nullptr, nullptr, nullptr);
    }
  }
};
static FSP_FSCTL_FILE_INFO fileInfo(HANDLE handle, bool allowReparse = false) {
  BY_HANDLE_FILE_INFORMATION raw{};
  require(GetFileInformationByHandle(handle, &raw));
  if (!allowReparse && (raw.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    throw Error{STATUS_REPARSE_POINT_NOT_RESOLVED};
  }
  FSP_FSCTL_FILE_INFO info{};
  info.FileAttributes = raw.dwFileAttributes;
  info.FileSize = (static_cast<UINT64>(raw.nFileSizeHigh) << 32) | raw.nFileSizeLow;
  info.AllocationSize = (info.FileSize + 4095) & ~4095ULL;
  info.CreationTime = (static_cast<UINT64>(raw.ftCreationTime.dwHighDateTime) << 32) |
                      raw.ftCreationTime.dwLowDateTime;
  info.LastWriteTime = (static_cast<UINT64>(raw.ftLastWriteTime.dwHighDateTime) << 32) |
                       raw.ftLastWriteTime.dwLowDateTime;
  info.LastAccessTime = (static_cast<UINT64>(raw.ftLastAccessTime.dwHighDateTime) << 32) |
                        raw.ftLastAccessTime.dwLowDateTime;
  info.ChangeTime = info.LastWriteTime;
  info.IndexNumber = (static_cast<UINT64>(raw.nFileIndexHigh) << 32) | raw.nFileIndexLow;
  info.HardLinks = 1;
  return info;
}

static std::vector<BYTE> descriptor(HANDLE handle) {
  DWORD size = 0;
  constexpr DWORD information =
      OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  GetKernelObjectSecurity(handle, information, nullptr, 0, &size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    require(false);
  }
  std::vector<BYTE> result(size);
  require(GetKernelObjectSecurity(handle, information, result.data(), size, &size));
  return result;
}

static void detachRootInheritance(std::vector<BYTE>& bytes) {
  // The virtual root has no source parent. Preserve effective inherited
  // permissions as explicit ACEs; otherwise SetPrivateObjectSecurity drops them
  // on the first grant.
  PACL acl = nullptr;
  BOOL present = FALSE;
  BOOL defaulted = FALSE;
  require(GetSecurityDescriptorDacl(bytes.data(), &present, &acl, &defaulted));
  if (present && acl) {
    for (WORD index = 0; index < acl->AceCount; ++index) {
      void* raw = nullptr;
      require(GetAce(acl, index, &raw));
      static_cast<ACE_HEADER*>(raw)->AceFlags &= ~INHERITED_ACE;
    }
  }
  require(SetSecurityDescriptorControl(
      bytes.data(), SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ,
      SE_DACL_PROTECTED));
}

void Store::sql(const char* text) {
  auto start = monotonicMicros();
  auto result = sqlite3_exec(db, text, nullptr, nullptr, nullptr);
  queryMetrics.execMicros += monotonicMicros() - start;
  sqlite(result);
}

Store::Store(const fs::path& sourcePath, const fs::path& directory, const fs::path& workspacePath,
             bool create, const fs::path& gitExecutable, const fs::path& gitDirectory,
             const std::wstring& tree, bool localMode)
    : source(fs::absolute(sourcePath)), root(fs::absolute(directory)), workspace(workspacePath),
      localMode(localMode) {
  try {
    if (localMode && !tree.empty()) {
      throw Error{STATUS_INVALID_PARAMETER};
    }
    if (create) {
      if (!fs::create_directory(root)) {
        throw Error{STATUS_OBJECT_NAME_COLLISION};
      }
      fs::create_directory(root / L"objects");
      if (localMode) {
        fs::create_directory(root / L"baselines");
      }
    }
    // No shared lease: a second mount must never open the same private state
    // concurrently.
    lease = Handle(CreateFileW((root / L"mount.lock").c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                               nullptr, OPEN_ALWAYS,
                               FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(lease.value != INVALID_HANDLE_VALUE);
    fileInfo(lease.value);
    controlDirectory =
        Handle(CreateFileW(root.c_str(), FILE_LIST_DIRECTORY | READ_CONTROL,
                           FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                           FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(controlDirectory.value != INVALID_HANDLE_VALUE);
    fileInfo(controlDirectory.value);
    objectsDirectory =
        Handle(CreateFileW((root / L"objects").c_str(), FILE_LIST_DIRECTORY | READ_CONTROL,
                           FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                           FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(objectsDirectory.value != INVALID_HANDLE_VALUE);
    fileInfo(objectsDirectory.value);
    if (localMode) {
      baselinesDirectory = Handle(CreateFileW(
          (root / L"baselines").c_str(), FILE_LIST_DIRECTORY | READ_CONTROL,
          FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
          FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      require(baselinesDirectory.value != INVALID_HANDLE_VALUE);
      fileInfo(baselinesDirectory.value);
    }
    lower = Handle(CreateFileW(source.c_str(),
                               FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
                               FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                               FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(lower.value != INVALID_HANDLE_VALUE);
    auto identity = fileInfo(lower.value);
    BY_HANDLE_FILE_INFORMATION raw{};
    require(GetFileInformationByHandle(lower.value, &raw));
    std::wstring sourceIdentity = std::to_wstring(raw.dwVolumeSerialNumber) + L":" +
                                  std::to_wstring(identity.IndexNumber) + L":" +
                                  std::to_wstring(identity.CreationTime);
    if (!tree.empty()) {
      git = std::make_unique<GitLower>(gitExecutable, gitDirectory);
      // Bind restore to exactly the same immutable base and object database.
      sourceIdentity += L":" + tree + L":" + fs::absolute(gitDirectory).wstring();
    }
    auto database = utf8((root / L"overlay.sqlite").wstring());
    sqlite(sqlite3_open_v2(database.c_str(), &db,
                           SQLITE_OPEN_READWRITE | (create ? SQLITE_OPEN_CREATE : 0), nullptr));
    sql("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA "
        "foreign_keys=ON;");
    if (create) {
      sql("CREATE TABLE meta(version INTEGER,source TEXT,identity TEXT,serial "
          "INTEGER,clean INTEGER);"
          "CREATE TABLE nodes(id INTEGER PRIMARY KEY AUTOINCREMENT,parent "
          "INTEGER,origin TEXT,object TEXT,info BLOB,security BLOB,reparse "
          "BLOB);"
          "CREATE TABLE entries(parent INTEGER,key TEXT,name TEXT,node "
          "INTEGER,PRIMARY KEY(parent,key));");
      GUID guid{};
      require(SUCCEEDED(CoCreateGuid(&guid)));
      serial = guid.Data1 ? guid.Data1 : 1;
      Query(*this, "INSERT INTO meta VALUES(?,?,?,?,0)")
          .number(1, localMode ? 6 : 2)
          .text(2, source.wstring())
          .text(3, sourceIdentity)
          .number(4, serial)
          .step();
      Node value;
      value.origin = git ? tree : L"\\";
      value.info = identity;
      value.security = descriptor(lower.value);
      detachRootInheritance(value.security);
      auto rootNode = insert(std::move(value));
      if (rootNode->id != 1) {
        throw Error{STATUS_FILE_CORRUPT_ERROR};
      }
      if (localMode) {
        sql("CREATE TABLE local_state(epoch INTEGER,seal TEXT); INSERT INTO local_state VALUES(0,'');"
            "CREATE TABLE epoch_transitions(id TEXT PRIMARY KEY,epoch INTEGER,seal TEXT);"
            "CREATE TABLE epoch_links(epoch INTEGER,dependency INTEGER,PRIMARY KEY(epoch,dependency));"
            "CREATE TABLE object_epochs(object TEXT,epoch INTEGER,PRIMARY KEY(object,epoch));"
            "CREATE TABLE acknowledgements(id TEXT PRIMARY KEY,epoch INTEGER,selection TEXT,seal TEXT);"
            "CREATE TABLE change_epochs(path TEXT,epoch INTEGER,PRIMARY KEY(path,epoch));"
            "CREATE TABLE observations(path TEXT,name TEXT,stamp TEXT,epoch INTEGER,PRIMARY KEY(epoch,path));"
            "CREATE TABLE baselines(path TEXT PRIMARY KEY,name TEXT,kind INTEGER,"
            "object TEXT,stamp TEXT,attributes INTEGER,security BLOB,flags INTEGER);");
      }
    } else {
      Query meta(*this, "SELECT version,source,identity,serial,clean FROM meta");
      if (!meta.step() || meta.number(0) != (localMode ? 6 : 2) || meta.number(4) != 1 ||
          fold(meta.text(1)) != fold(source.wstring()) || meta.text(2) != sourceIdentity) {
        throw Error{STATUS_FILE_INVALID};
      }
      serial = static_cast<UINT32>(meta.number(3));
      if (!node(1)->directory()) {
        throw Error{STATUS_FILE_CORRUPT_ERROR};
      }
      sql("UPDATE meta SET clean=0");
    }
    if (git) {
      // OpenFile normalized names look up an inode in its parent. The primary
      // (parent,key) index otherwise scans every sibling for each file opened.
      sql("CREATE INDEX IF NOT EXISTS entries_inode ON entries(parent,node)");
    }
  } catch (...) {
    closeDatabase();
    throw;
  }
}

Store::~Store() {
  closeDatabase();
}

void Store::closeDatabase() noexcept {
  for (auto& [sql, statement] : statements) {
    sqlite3_finalize(statement);
  }
  statements.clear();
  if (db) {
    sqlite3_close_v2(db);
    db = nullptr;
  }
}

void Store::finish() {
  if (poisoned) {
    throw Error{STATUS_FILE_INVALID};
  }
  sql("UPDATE meta SET clean=1; PRAGMA wal_checkpoint(TRUNCATE)");
}

Handle Store::openLower(const std::wstring& origin, DWORD sharing) {
  ++lowerOpens;
  if (git) {
    // A Git lower must never silently fall back to a source working file.
    throw Error{STATUS_NOT_SUPPORTED};
  }
  if (origin.empty()) {
    throw Error{STATUS_OBJECT_NAME_NOT_FOUND};
  }
  std::wstring relative = origin == L"\\" ? L"" : origin.substr(1);
  if (relative.size() > 32000) {
    throw Error{STATUS_NAME_TOO_LONG};
  }
  UNICODE_STRING name{};
  name.Buffer = relative.data();
  name.Length = static_cast<USHORT>(relative.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &name,
                             OBJ_CASE_INSENSITIVE | 0x1000 /* OBJ_DONT_REPARSE */, lower.value,
                             nullptr);
  IO_STATUS_BLOCK io{};
  HANDLE raw = INVALID_HANDLE_VALUE;
  using NtOpen =
      NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, ULONG, ULONG);
  static auto open =
      reinterpret_cast<NtOpen>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtOpenFile"));
  checked(open(&raw, FILE_GENERIC_READ, &attributes, &io, sharing,
               FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT));
  Handle handle(raw);
  fileInfo(handle.value, true);
  if (localMode) {
    // An NTFS short name can resolve to .git even when the requested spelling
    // differs. Check the normalized opened path, without following reparses or
    // enumerating the directory. The virtual volume never advertises aliases.
    std::vector<wchar_t> normalized(32768);
    auto length = GetFinalPathNameByHandleW(handle.value, normalized.data(),
                                           static_cast<DWORD>(normalized.size()), VOLUME_NAME_NONE);
    require(length > 0 && length < normalized.size());
    for (const auto& component : fs::path(std::wstring(normalized.data(), length))) {
      if (fold(component.wstring()) == L".GIT") {
        throw Error{STATUS_OBJECT_NAME_NOT_FOUND};
      }
    }
  }
  return handle;
}

NodePtr Store::insert(Node value) {
  Query(*this,
        "INSERT INTO nodes(parent,origin,object,info,security,reparse) "
        "VALUES(?,?,?,?,?,?)")
      .number(1, value.parent)
      .text(2, value.origin)
      .text(3, value.object)
      .blob(4, &value.info, sizeof(value.info))
      .blob(5, value.security.data(), static_cast<int>(value.security.size()))
      .blob(6, value.reparse.data(), static_cast<int>(value.reparse.size()))
      .step();
  value.id = sqlite3_last_insert_rowid(db);
  value.info.IndexNumber = value.id;
  auto result = std::make_shared<Node>(std::move(value));
  save(result);
  cache[result->id] = result;
  return result;
}

void Store::save(const NodePtr& node) {
  try {
    Query(*this,
          "UPDATE nodes SET "
          "parent=?,origin=?,object=?,info=?,security=?,reparse=? WHERE id=?")
        .number(1, node->parent)
        .text(2, node->origin)
        .text(3, node->object)
        .blob(4, &node->info, sizeof(node->info))
        .blob(5, node->security.data(), static_cast<int>(node->security.size()))
        .blob(6, node->reparse.data(), static_cast<int>(node->reparse.size()))
        .number(7, node->id)
        .step();
  } catch (...) {
    poisoned = true;
    throw;
  }
}

NodePtr Store::node(sqlite3_int64 id) {
  if (auto result = cache[id].lock()) {
    return result;
  }
  Query query(*this,
              "SELECT parent,origin,object,info,security,reparse FROM nodes "
              "WHERE id=?");
  query.number(1, id);
  if (!query.step()) {
    throw Error{STATUS_OBJECT_NAME_NOT_FOUND};
  }
  auto result = std::make_shared<Node>();
  result->id = id;
  result->parent = query.number(0);
  result->origin = query.text(1);
  result->object = query.text(2);
  auto bytes = query.blob(3);
  if (bytes.size() != sizeof(result->info)) {
    throw Error{STATUS_FILE_CORRUPT_ERROR};
  }
  memcpy(&result->info, bytes.data(), bytes.size());
  result->security = query.blob(4);
  result->reparse = query.blob(5);
  if (result->security.empty() || !IsValidSecurityDescriptor(result->security.data())) {
    throw Error{STATUS_FILE_CORRUPT_ERROR};
  }
  cache[id] = result;
  return result;
}

static void validName(const std::wstring& name) {
  if (name.empty() || name == L"." || name == L".." || name.size() > 255 ||
      name.find_first_of(L"\\/:*?\"<>|") != std::wstring::npos || name.back() == L' ' ||
      name.back() == L'.') {
    throw Error{STATUS_OBJECT_NAME_INVALID};
  }
}

void Store::pinParents(const NodePtr& value) {
  auto directory = value->directory() ? value : node(value->parent);
  while (directory->object.empty()) {
    directory->object = L".";
    save(directory);
    if (directory->id == 1) {
      break;
    }
    directory = node(directory->parent);
  }
}

void Store::link(sqlite3_int64 parent, const std::wstring& name, sqlite3_int64 id, bool touch) {
  Query(*this,
        "INSERT INTO entries VALUES(?,?,?,?) ON CONFLICT(parent,key) DO UPDATE "
        "SET name=excluded.name,node=excluded.node")
      .number(1, parent)
      .text(2, fold(name))
      .text(3, name)
      .number(4, id)
      .step();
  if (touch) {
    auto directory = node(parent);
    directory->info.LastWriteTime = directory->info.ChangeTime = now();
    pinParents(directory);
    save(directory);
  }
}

NodePtr Store::import(const NodePtr& parent, const std::wstring& name, const std::wstring& origin,
                      bool batchedImport) {
  auto handle = openLower(origin);
  Node value;
  value.parent = parent->id;
  value.origin = origin;
  value.info = fileInfo(handle.value, true);
  if (value.info.FileAttributes & FILE_ATTRIBUTE_ENCRYPTED) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  if (value.info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    value.reparse = lowerReparse(handle.value, source / origin.substr(1), source, workspace);
    value.info.ReparseTag =
        reinterpret_cast<REPARSE_DATA_BUFFER*>(value.reparse.data())->ReparseTag;
  }
  value.security = descriptor(handle.value);
  std::unique_ptr<Transaction> transaction;
  if (batchedImport) {
    // Only list() owns this batch. Never silently skip persistence outside a transaction.
    if (sqlite3_get_autocommit(db)) {
      throw Error{STATUS_INVALID_DEVICE_STATE};
    }
  } else {
    transaction = std::make_unique<Transaction>(*this);
  }
  auto result = insert(std::move(value));
  link(parent->id, name, result->id, false);
  if (transaction) {
    transaction->commit();
    ++lowerImportCommits;
  }
  return result;
}

NodePtr Store::child(const NodePtr& parent, const std::wstring& name, bool batchedImport) {
  validName(name);
  // Check before the private namespace too: Local never exposes a gitfile.
  if (localMode && fold(name) == L".GIT") {
    throw Error{STATUS_OBJECT_NAME_NOT_FOUND};
  }
  if (!parent->directory()) {
    throw Error{STATUS_NOT_A_DIRECTORY};
  }
  if (!parent->reparse.empty()) {
    throw Error{STATUS_REPARSE_POINT_NOT_RESOLVED};
  }
  Query query(*this, "SELECT node FROM entries WHERE parent=? AND key=?");
  query.number(1, parent->id).text(2, fold(name));
  if (query.step()) {
    if (query.number(0) == 0) {
      throw Error{STATUS_OBJECT_NAME_NOT_FOUND};
    }
    auto result = node(query.number(0));
    // Imported entries remain a live lower view until content is private or
    // renamed.
    if (!git && result->object.empty() && !result->origin.empty()) {
      auto handle = openLower(result->origin);
    }
    return result;
  }
  if (fold(name) == L".GIT") {
    throw Error{parent->id == 1 ? STATUS_OBJECT_NAME_NOT_FOUND : STATUS_NOT_SUPPORTED};
  }
  if (parent->origin.empty()) {
    throw Error{STATUS_OBJECT_NAME_NOT_FOUND};
  }
  if (git) {
    importGitDirectory(parent);
    Query imported(*this, "SELECT node FROM entries WHERE parent=? AND key=?");
    imported.number(1, parent->id).text(2, fold(name));
    if (!imported.step() || !imported.number(0)) {
      throw Error{STATUS_OBJECT_NAME_NOT_FOUND};
    }
    return node(imported.number(0));
  }
  auto origin = parent->origin == L"\\" ? L"\\" + name : parent->origin + L"\\" + name;
  return import(parent, name, origin, batchedImport);
}

NodePtr Store::lookup(const std::wstring& path) {
  if (gitIncompatible) {
    // Once a directory cannot be represented faithfully, don't expose a
    // partial repository as if unsupported entries were simply missing.
    throw Error{STATUS_NOT_SUPPORTED};
  }
  if (path.empty() || path[0] != L'\\') {
    throw Error{STATUS_OBJECT_NAME_INVALID};
  }
  auto current = node(1);
  size_t start = 1;
  while (start < path.size()) {
    size_t end = path.find(L'\\', start);
    current = child(current, path.substr(start, end == std::wstring::npos ? end : end - start));
    if (end == std::wstring::npos) {
      break;
    }
    start = end + 1;
  }
  return current;
}

std::wstring Store::name(const NodePtr& value) {
  if (value->id == 1) {
    return L"\\";
  }
  Query query(*this, "SELECT name FROM entries WHERE parent=? AND node=?");
  query.number(1, value->parent).number(2, value->id);
  if (!query.step()) {
    throw Error{STATUS_FILE_INVALID};
  }
  auto prefix = name(node(value->parent));
  return prefix + (prefix == L"\\" ? L"" : L"\\") + query.text(0);
}

std::pair<NodePtr, std::wstring> Store::parent(const std::wstring& path) {
  auto slash = path.find_last_of(L'\\');
  if (slash == std::wstring::npos || path == L"\\") {
    throw Error{STATUS_OBJECT_NAME_INVALID};
  }
  auto name = path.substr(slash + 1);
  validName(name);
  // All namespace mutations use parent(); reject before any transaction or
  // copy-up so a forbidden rename cannot consume the source entry.
  if (localMode && fold(name) == L".GIT") {
    throw Error{STATUS_ACCESS_DENIED};
  }
  return {lookup(slash == 0 ? L"\\" : path.substr(0, slash)), name};
}

static bool missing(NTSTATUS status) {
  return status == STATUS_OBJECT_NAME_NOT_FOUND || status == STATUS_OBJECT_PATH_NOT_FOUND ||
         status == STATUS_NO_SUCH_FILE;
}

static std::vector<BYTE> childDescriptor(const std::vector<BYTE>& parent) {
  // Store owner/group, but no copied root capability ACEs: child DACLs inherit
  // dynamically so revoking a root grant also revokes access to imported files.
  SECURITY_DESCRIPTOR descriptor{};
  require(InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION));
  PSID owner = nullptr;
  PSID group = nullptr;
  BOOL defaulted = FALSE;
  require(GetSecurityDescriptorOwner(const_cast<BYTE*>(parent.data()), &owner, &defaulted));
  require(GetSecurityDescriptorGroup(const_cast<BYTE*>(parent.data()), &group, &defaulted));
  require(SetSecurityDescriptorOwner(&descriptor, owner, FALSE));
  require(SetSecurityDescriptorGroup(&descriptor, group, FALSE));
  ACL empty{};
  require(InitializeAcl(&empty, sizeof(empty), ACL_REVISION));
  require(SetSecurityDescriptorDacl(&descriptor, TRUE, &empty, FALSE));
  DWORD length = 0;
  MakeSelfRelativeSD(&descriptor, nullptr, &length);
  std::vector<BYTE> result(length);
  require(MakeSelfRelativeSD(&descriptor, result.data(), &length));
  return result;
}

void Store::importGitDirectory(const NodePtr& parent) {
  if (parent->origin.empty() || importedTrees.contains(parent->id)) {
    return;
  }
  const std::vector<GitEntry>* entries = nullptr;
  try {
    entries = &git->tree(parent->origin);
  } catch (const Error& error) {
    if (error.status == STATUS_NOT_SUPPORTED) {
      gitIncompatible = true;
    }
    throw;
  }
  auto sd = childDescriptor(node(1)->security);
  Transaction transaction(*this);
  for (const auto& entry : *entries) {
    Query existing(*this, "SELECT 1 FROM entries WHERE parent=? AND key=?");
    existing.number(1, parent->id).text(2, fold(entry.name));
    if (existing.step()) {
      continue;
    }
    Node value;
    value.parent = parent->id;
    value.origin = entry.oid;
    value.security = sd;
    value.info.FileAttributes = entry.directory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
    value.info.HardLinks = 1;
    value.info.CreationTime = value.info.LastWriteTime = value.info.LastAccessTime =
        value.info.ChangeTime = node(1)->info.CreationTime;
    value.info.FileSize = entry.directory ? 0 : git->size(entry.oid);
    value.info.AllocationSize = (value.info.FileSize + 4095) & ~4095ULL;
    auto result = insert(std::move(value));
    link(parent->id, entry.name, result->id, false);
  }
  transaction.commit();
  importedTrees.insert(parent->id);
}

std::vector<Entry> Store::list(const NodePtr& parent) {
  if (!parent->directory()) {
    throw Error{STATUS_NOT_A_DIRECTORY};
  }
  if (!parent->reparse.empty()) {
    throw Error{STATUS_REPARSE_POINT_NOT_RESOLVED};
  }
  if (git) {
    importGitDirectory(parent);
  } else if (!parent->origin.empty()) {
    ++lowerEnumerations;
    Handle handle;
    try {
      handle = openLower(parent->origin);
    } catch (const Error& error) {
      if (parent->object.empty() || !missing(error.status)) {
        throw;
      }
    }
    if (handle.value != INVALID_HANDLE_VALUE) {
      // Preserve FULL durability, ACL and source validation. Batching only avoids
      // one flush per new directory entry; it is not a snapshot of the live source.
      std::unique_ptr<Transaction> transaction;
      const auto changesBefore = sqlite3_total_changes(db);
      if (localMode) {
        transaction = std::make_unique<Transaction>(*this);
      }
      alignas(8) BYTE buffer[65536];
      bool first = true;
      for (;;) {
        if (!GetFileInformationByHandleEx(
                handle.value, first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
                buffer, sizeof(buffer))) {
          if (GetLastError() == ERROR_NO_MORE_FILES) {
            break;
          }
          require(false);
        }
        first = false;
        auto entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer);
        for (;;) {
          std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
          if (name != L"." && name != L".." &&
              !((localMode || parent->id == 1) && fold(name) == L".GIT")) {
            try {
              child(parent, name, localMode);
            } catch (const Error& error) {
              if (!missing(error.status)) {
                throw;
              }
            }
          }
          if (!entry->NextEntryOffset) {
            break;
          }
          entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<BYTE*>(entry) +
                                                           entry->NextEntryOffset);
        }
      }
      if (transaction) {
        transaction->commit();
        if (sqlite3_total_changes(db) != changesBefore) {
          ++lowerImportCommits;
        }
      }
    }
  }
  std::vector<Entry> result;
  Query query(*this, "SELECT name,node FROM entries WHERE parent=? AND node<>0 ORDER BY key");
  query.number(1, parent->id);
  while (query.step()) {
    try {
      result.push_back({query.text(0), child(parent, query.text(0))});
    } catch (const Error& error) {
      if (!missing(error.status)) {
        throw;
      }
    }
  }
  return result;
}

NodePtr Store::create(const std::wstring& path, DWORD attributes, PSECURITY_DESCRIPTOR sd) {
  auto [directory, name] = parent(path);
  try {
    child(directory, name);
    throw Error{STATUS_OBJECT_NAME_COLLISION};
  } catch (const Error& error) {
    if (!missing(error.status)) {
      throw;
    }
  }
  if (attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_ENCRYPTED)) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  capture(path, 2);
  Node value;
  value.parent = directory->id;
  value.info.FileAttributes = attributes;
  value.info.CreationTime = value.info.LastWriteTime = value.info.ChangeTime =
      value.info.LastAccessTime = now();
  value.info.HardLinks = 1;
  auto length = GetSecurityDescriptorLength(sd);
  value.security.assign(static_cast<BYTE*>(sd), static_cast<BYTE*>(sd) + length);
  Transaction transaction(*this);
  auto result = insert(std::move(value));
  if (!result->directory()) {
    promote(result);
  }
  link(directory->id, name, result->id);
  trackObject(result);
  transaction.commit();
  return result;
}

void Store::promote(const NodePtr& value) {
  if (!value->reparse.empty()) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  if (value->directory() || !value->object.empty()) {
    return;
  }
  if (localMode && !value->origin.empty()) {
    capture(this->name(value));
  }
  pinParents(value);
  GUID guid{};
  require(SUCCEEDED(CoCreateGuid(&guid)));
  wchar_t name[40];
  StringFromGUID2(guid, name, 40);
  fs::path object = root / L"objects" / name;
  Handle output(CreateFileW(object.c_str(), GENERIC_READ | GENERIC_WRITE,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                            CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                            nullptr));
  require(output.value != INVALID_HANDLE_VALUE);
  if (git && !value->origin.empty()) {
    const auto& bytes = git->blob(value->origin);
    DWORD written = 0;
    require(
        WriteFile(output.value, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr));
    if (written != bytes.size()) {
      throw Error{STATUS_DISK_FULL};
    }
  } else if (!value->origin.empty()) {
    // Deny concurrent write/delete while copying; the cached read handle has no
    // write access.
    auto input = baselineInput(value);
    if (input.value == INVALID_HANDLE_VALUE) {
      input = openLower(value->origin, FILE_SHARE_READ);
    }
    std::vector<BYTE> buffer(1024 * 1024);
    for (;;) {
      DWORD count = 0;
      require(
          ReadFile(input.value, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr));
      if (!count) {
        break;
      }
      DWORD written = 0;
      require(WriteFile(output.value, buffer.data(), count, &written, nullptr));
      if (written != count) {
        throw Error{STATUS_DISK_FULL};
      }
    }
  }
  require(FlushFileBuffers(output.value));
  auto previous = value->object;
  value->object = name;
  try {
    save(value);
  } catch (...) {
    value->object = previous;
    throw;
  }
  value->content = std::move(output);
  trackObject(value);
}

HANDLE Store::content(const NodePtr& value, bool write) {
  if (!value->reparse.empty()) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  if (write) {
    if (localMode && !value->object.empty()) {
      // Later turns may edit retained private files. Keep their original B and
      // associate the new turn's read dependencies before the next write.
      capture(name(value));
    }
    promote(value);
    trackObject(value);
  }
  if (value->content.value == INVALID_HANDLE_VALUE) {
    if (value->object.empty()) {
      value->content = openLower(value->origin);
    } else {
      value->content = Handle(CreateFileW(
          (root / L"objects" / value->object).c_str(), GENERIC_READ | GENERIC_WRITE,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
          FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      require(value->content.value != INVALID_HANDLE_VALUE);
      fileInfo(value->content.value);
    }
  }
  return value->content.value;
}

FSP_FSCTL_FILE_INFO Store::info(const NodePtr& value) {
  auto result = value->info;
  if (git && (value->object.empty() || value->directory())) {
    return result;
  }
  if (!value->directory() && value->reparse.empty()) {
    auto actual = fileInfo(content(value, false));
    result.FileSize = actual.FileSize;
    result.AllocationSize = actual.AllocationSize;
    if (value->object.empty()) {
      result.LastWriteTime = actual.LastWriteTime;
      result.ChangeTime = actual.ChangeTime;
    }
  }
  if (value->directory() && value->reparse.empty() && !value->origin.empty()) {
    try {
      auto handle = openLower(value->origin);
      auto actual = fileInfo(handle.value);
      result.LastWriteTime = std::max(result.LastWriteTime, actual.LastWriteTime);
      result.ChangeTime = std::max(result.ChangeTime, actual.ChangeTime);
    } catch (const Error& error) {
      if (value->object.empty() || !missing(error.status)) {
        throw;
      }
    }
  }
  result.IndexNumber = value->id;
  return result;
}

DWORD Store::read(const NodePtr& value, void* buffer, UINT64 offset, DWORD length) {
  if (git && value->object.empty()) {
    const auto& bytes = git->blob(value->origin);
    auto count = offset >= bytes.size()
                     ? 0
                     : static_cast<DWORD>(std::min<UINT64>(length, bytes.size() - offset));
    if (count) {
      memcpy(buffer, bytes.data() + offset, count);
    }
    return count;
  }
  HANDLE handle = content(value, false);
  auto observed = observeRead(value, handle);
  LARGE_INTEGER position{};
  position.QuadPart = offset;
  require(SetFilePointerEx(handle, position, nullptr, FILE_BEGIN));
  DWORD transferred = 0;
  require(ReadFile(handle, buffer, length, &transferred, nullptr));
  // A source writer racing this read must not produce a silently mixed view.
  observeRead(value, handle, observed);
  return transferred;
}

void Store::rename(const std::wstring& from, const std::wstring& to, bool replace) {
  auto value = lookup(from);
  auto [oldParent, oldName] = parent(from);
  auto [newParent, newName] = parent(to);
  for (auto ancestor = newParent; ancestor->id != 1; ancestor = node(ancestor->parent)) {
    if (ancestor->id == value->id) {
      throw Error{STATUS_INVALID_PARAMETER};
    }
  }
  try {
    auto existing = child(newParent, newName);
    if (existing->id != value->id && (!replace || existing->directory() || value->directory())) {
      throw Error{STATUS_OBJECT_NAME_COLLISION};
    }
  } catch (const Error& error) {
    if (!missing(error.status)) {
      throw;
    }
  }
  // A renamed regular file belongs to the private namespace and must survive
  // removal of its former lower path. Directories retain live lower children.
  capture(from, 2);
  capture(to, 2);
  if (!value->directory() && value->reparse.empty()) {
    promote(value);
    trackObject(value);
  }
  if (!value->reparse.empty()) {
    internalReparse(value->reparse.data(), value->reparse.size(), workspace / to.substr(1),
                    workspace, workspace);
  }
  Transaction transaction(*this);
  link(oldParent->id, oldName, 0);
  link(newParent->id, newName, value->id);
  auto previous = value->parent;
  value->parent = newParent->id;
  if (value->directory()) {
    value->object = L".";
  }
  if (!value->reparse.empty()) {
    value->origin.clear();
  }
  try {
    save(value);
    transaction.commit();
  } catch (...) {
    value->parent = previous;
    throw;
  }
}

void Store::remove(const std::wstring& path, sqlite3_int64 expected) {
  // Replacement may already have unlinked an inode that still has open handles.
  // Its delayed Cleanup must not remove the new occupant at the same name.
  Query linked(*this, "SELECT 1 FROM entries WHERE node=? LIMIT 1");
  linked.number(1, expected);
  if (!linked.step()) {
    return;
  }
  auto value = lookup(path);
  if (value->id != expected) {
    throw Error{STATUS_FILE_INVALID};
  }
  if (value->directory() && value->reparse.empty() && !list(value).empty()) {
    throw Error{STATUS_DIRECTORY_NOT_EMPTY};
  }
  auto [directory, name] = parent(path);
  capture(path, 2);
  link(directory->id, name, 0);
}

std::vector<BYTE> Store::security(const NodePtr& value) {
  if (value->id == 1) {
    return value->security;
  }
  auto inherited = security(node(value->parent));
  PSECURITY_DESCRIPTOR output = nullptr;
  GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE,
                          FILE_ALL_ACCESS};
  require(CreatePrivateObjectSecurityEx(
      inherited.data(), value->security.data(), &output, nullptr, value->directory(),
      SEF_DACL_AUTO_INHERIT | SEF_AVOID_PRIVILEGE_CHECK | SEF_AVOID_OWNER_CHECK, nullptr,
      &mapping));
  auto bytes = static_cast<BYTE*>(output);
  std::vector<BYTE> result(bytes, bytes + GetSecurityDescriptorLength(output));
  DestroyPrivateObjectSecurity(&output);
  return result;
}

void Store::setSecurity(const NodePtr& value, SECURITY_INFORMATION information,
                        PSECURITY_DESCRIPTOR modification) {
  // Audit ACLs require separate privilege-aware capture; never silently discard
  // them.
  if (information & (SACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION)) {
    throw Error{STATUS_NOT_SUPPORTED};
  }
  if (value->id != 1) {
    capture(name(value), 4);
  }
  auto current = security(value);
  PSECURITY_DESCRIPTOR output = nullptr;
  checked(FspSetSecurityDescriptor(current.data(), information, modification, &output));
  auto bytes = static_cast<BYTE*>(output);
  auto previous = value->security;
  value->security.assign(bytes, bytes + GetSecurityDescriptorLength(output));
  FspDeleteSecurityDescriptor(output, reinterpret_cast<NTSTATUS (*)()>(FspSetSecurityDescriptor));
  try {
    save(value);
  } catch (...) {
    value->security = previous;
    throw;
  }
}

void Store::setReparse(const NodePtr& value, const void* data, size_t size) {
  if (value->id == 1 || (value->directory() && value->reparse.empty() && !list(value).empty())) {
    throw Error{STATUS_DIRECTORY_NOT_EMPTY};
  }
  // New links accept only relative in-volume targets. Source junctions are
  // translated on import.
  auto bytes = internalReparse(data, size, workspace / name(value).substr(1), workspace, workspace);
  capture(name(value), 4);
  value->reparse = std::move(bytes);
  value->origin.clear();
  value->info.FileAttributes |= FILE_ATTRIBUTE_REPARSE_POINT;
  value->info.ReparseTag =
      reinterpret_cast<REPARSE_DATA_BUFFER*>(value->reparse.data())->ReparseTag;
  save(value);
}
}  // namespace overlay
