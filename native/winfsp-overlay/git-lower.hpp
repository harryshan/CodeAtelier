// Git 提交 lower 的人工 PoC 接口，供 Store 复用现有 WinFsp 回调与 upper。
// 1. GitEntry/GitMetrics 表示一层 tree、真实读取计数与内容请求耗时，不表示工作文件快照。
// 2. GitLower 通过独占 Job 中的常驻 cat-file 查询固定 OID，不运行 checkout/filter。
// 3. tree/size 按需缓存元数据，blob 只缓存最近一个有界对象；不写磁盘内容缓存。
// 生命周期由 Store 拥有，异常关闭 Job 终止自己的 Git；不管理其他 Git 或产品任务。
#pragma once
#include <unordered_map>

#include "store.hpp"

namespace overlay {
struct GitEntry {
  std::wstring name;
  std::wstring oid;
  bool directory;
};

struct GitMetrics {
  UINT64 treeReads = 0;
  UINT64 infoReads = 0;
  UINT64 blobReads = 0;
  UINT64 blobBytes = 0;
  UINT64 objectMicros = 0;  // Successful tree/blob contents requests; excludes size-only queries.
};

class GitLower {
 public:
  GitMetrics metrics;
  GitLower(const fs::path& executable, const fs::path& gitDirectory);
  const std::vector<GitEntry>& tree(const std::wstring& oid);
  UINT64 size(const std::wstring& oid);
  const std::vector<BYTE>& blob(const std::wstring& oid);

 private:
  Handle job;
  Handle process;
  Handle input;
  Handle output;
  std::string pending;
  std::unordered_map<std::wstring, std::vector<GitEntry>> trees;
  std::unordered_map<std::wstring, UINT64> sizes;
  std::wstring lastOid;
  std::vector<BYTE> lastBlob;

  void receive(void* destination, size_t size);
  std::string line();
  UINT64 request(const std::wstring& oid, const char* type, bool contents);
  std::vector<BYTE> object(const std::wstring& oid, const char* type, size_t limit);
};
}  // namespace overlay
