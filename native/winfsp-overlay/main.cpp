// Windows 原生 overlay helper 入口，由工作区管理器通过固定参数和私有 stdin/stdout 启动。
// 1. probe 检查 WinFsp driver；create/restore 打开独占 Store，创建稳定 serial 的本机 UNC 卷。
// 2. ready 收据只含协议版本/状态；路径由调用方决定，不输出文件内容或安全描述符。
// 3. stdin EOF/stop 停止 dispatcher、删除卷，再标记干净退出；数据和 worktree 登记保留。
// 4. 显式 create-git/restore-git PoC 参数固定 Git/tree；metrics 不包含路径/OID/内容。
// 5. create-local/restore-local 选择无 Git 视图并回执策略；metrics 证明创建期 lower 访问成本。
// 不安装驱动、不创建分区、不托管网络服务；UNC 由 WinFsp 本机 MUP provider 提供。
#include <iostream>

#include "git-lower.hpp"
#include "store.hpp"

int wmain(int argc, wchar_t** argv) {
  using namespace overlay;
  try {
    checked(FspLoad(nullptr));
    if (argc == 2 && std::wstring(argv[1]) == L"probe") {
      auto result =
          FspFileSystemPreflight(const_cast<PWSTR>(L"" FSP_FSCTL_NET_DEVICE_NAME), nullptr);
      std::cout << "{\"version\":1,\"available\":" << (NT_SUCCESS(result) ? "true" : "false")
                << "}\n";
      return 0;
    }
    bool gitMode = argc == 8 && (std::wstring(argv[1]) == L"create-git" ||
                                 std::wstring(argv[1]) == L"restore-git");
    bool localMode = argc == 5 && (std::wstring(argv[1]) == L"create-local" ||
                                   std::wstring(argv[1]) == L"restore-local");
    if (!gitMode && !localMode && (argc != 5 ||
                     (std::wstring(argv[1]) != L"create" && std::wstring(argv[1]) != L"restore"))) {
      return 2;
    }
    std::wstring prefix = argv[4];
    if (prefix.rfind(L"\\CodeAtelier\\", 0) != 0 || prefix.size() > 100 ||
        prefix.find(L'\\', 13) != std::wstring::npos) {
      return 2;
    }
    Store store(argv[2], argv[3], L"\\" + prefix + L"\\",
                std::wstring(argv[1]).rfind(L"create", 0) == 0, gitMode ? argv[5] : L"",
                gitMode ? argv[6] : L"", gitMode ? argv[7] : L"", localMode);
    FSP_FSCTL_VOLUME_PARAMS params{};
    params.SectorSize = 4096;
    params.SectorsPerAllocationUnit = 1;
    params.VolumeCreationTime = store.node(1)->info.CreationTime;
    params.VolumeSerialNumber = store.serial;
    params.CasePreservedNames = 1;
    params.UnicodeOnDisk = 1;
    params.PersistentAcls = 1;
    params.ReparsePoints = 1;
    params.ReparsePointsAccessCheck = 1;
    params.FileInfoTimeout = 0;
    params.UmFileContextIsUserContext2 = 1;
    params.FlushAndPurgeOnCleanup = 1;
    params.SupportsPosixUnlinkRename = 1;
    wcscpy_s(params.Prefix, prefix.c_str());
    wcscpy_s(params.FileSystemName, L"CodeAtelier");
    FSP_FILE_SYSTEM* filesystem = nullptr;
    checked(FspFileSystemCreate(const_cast<PWSTR>(L"" FSP_FSCTL_NET_DEVICE_NAME), &params,
                                &callbacks(), &filesystem));
    filesystem->UserContext = &store;
    auto result = FspFileSystemStartDispatcher(filesystem, 0);
    if (!NT_SUCCESS(result)) {
      FspFileSystemDelete(filesystem);
      checked(result);
    }
    std::cout << "{\"version\":1,\"state\":\"ready\""
              << (localMode ? ",\"mode\":\"local\"" : "") << "}\n" << std::flush;
    std::string command;
    while (std::getline(std::cin, command)) {
      if (command != "metrics" || (!store.git && !store.localMode)) {
        break;
      }
      std::lock_guard lock(store.mutex);
      auto metrics = store.git ? store.git->metrics : GitMetrics{};
      std::cout << "{\"version\":1,\"state\":\"metrics\",\"treeReads\":" << metrics.treeReads
                << ",\"infoReads\":" << metrics.infoReads << ",\"blobReads\":" << metrics.blobReads
                << ",\"blobBytes\":" << metrics.blobBytes << ",\"lowerOpens\":" << store.lowerOpens
                << ",\"lowerEnumerations\":" << store.lowerEnumerations
                << ",\"objectMicros\":" << metrics.objectMicros
                << ",\"sqlPrepareMicros\":" << queryMetrics.prepareMicros
                << ",\"sqlReadMicros\":" << queryMetrics.readMicros
                << ",\"sqlWriteMicros\":" << queryMetrics.writeMicros
                << ",\"sqlExecMicros\":" << queryMetrics.execMicros
                << ",\"sqlReads\":" << queryMetrics.reads
                << ",\"sqlWrites\":" << queryMetrics.writes
                << ",\"accessCleanups\":" << queryMetrics.accessCleanups << "}\n"
                << std::flush;
    }
    FspFileSystemStopDispatcher(filesystem);
    FspFileSystemDelete(filesystem);
    store.finish();
    std::cout << "{\"version\":1,\"state\":\"stopped\"}\n" << std::flush;
    return 0;
  } catch (const Error& error) {
    std::cout << "{\"version\":1,\"error\":\"native\",\"status\":"
              << static_cast<UINT32>(error.status) << "}\n";
  } catch (...) {
    std::cout << "{\"version\":1,\"error\":\"filesystem\"}\n";
  }
  return 1;
}
