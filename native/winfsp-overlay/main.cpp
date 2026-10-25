// Windows 原生 overlay helper 入口，由工作区管理器通过固定参数和私有 stdin/stdout 启动。
// 1. probe 检查 WinFsp driver；create/restore 打开独占 Store，创建稳定 serial 的本机 UNC 卷。
// 2. ready 收据只含协议版本/状态；路径由调用方决定，不输出文件内容或安全描述符。
// 3. stdin EOF/stop 停止 dispatcher、删除卷，再标记干净退出；数据和 worktree 登记保留。
// 4. 显式 create-git/restore-git PoC 参数固定 Git/tree；metrics 不包含路径/OID/内容。
// 5. create-local/restore-local 选择无 Git 视图并回执策略；metrics 证明创建期 lower 访问成本。
// 6. freeze 销毁 Local dispatcher 后封存路径结果；helper 保留控制目录独占租约直到 stop。
//    check-reads 仅在冻结后复核读依赖并返回无正文收据，路径有效性保存在私有数据库。
//    acknowledge 以有界 hex 路径参数确认已发布选择；收据只含批次 ID/代次，下一轮重新挂载。
//    collect 显式回收无引用私有内容；只在冻结期执行，收据返回数量/逻辑字节，不包含对象名。
// 7. publish-replace/cleanup 保留供独立原生验证使用，保留权限并返回无正文确认；不启动挂载。
// 8. publish-session 串行执行全部来源写入并持执行排他；inspect-publication 仅持排他核对旧 generation。
// 不安装驱动、不创建分区、不托管网络服务；UNC 由 WinFsp 本机 MUP provider 提供。
#include <iostream>
#include <sstream>

#include "git-lower.hpp"
#include "publish.hpp"
#include "publication-lease.hpp"
#include "store.hpp"

static void acknowledge(overlay::Store& store, const std::string& command) {
  using namespace overlay;
  if (command.size() > 1024 * 1024) {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  std::istringstream input(command.substr(12));
  std::string id;
  std::string seal;
  sqlite3_int64 epoch = -1;
  if (!(input >> id >> epoch >> seal)) {
    throw Error{STATUS_INVALID_PARAMETER};
  }
  std::vector<std::wstring> paths;
  std::string encoded;
  while (input >> encoded) {
    if (paths.size() >= 100 || encoded.size() > 32768 || encoded.size() % 2 ||
        encoded.find_first_not_of("0123456789abcdef") != std::string::npos) {
      throw Error{STATUS_INVALID_PARAMETER};
    }
    std::string decoded;
    constexpr char digits[] = "0123456789abcdef";
    for (size_t index = 0; index < encoded.size(); index += 2) {
      auto digit = [&](char value) { return static_cast<int>(std::string(digits).find(value)); };
      decoded += static_cast<char>(digit(encoded[index]) * 16 + digit(encoded[index + 1]));
    }
    paths.push_back(wide(decoded));
  }
  auto next = store.acknowledge(wide(id), epoch, wide(seal), paths);
  std::cout << "{\"version\":1,\"state\":\"acknowledged\",\"mode\":\"local\",\"batchId\":\""
            << id << "\",\"seal\":\"" << seal << "\",\"epoch\":" << next << "}\n" << std::flush;
}

int wmain(int argc, wchar_t** argv) {
  using namespace overlay;
  try {
    checked(FspLoad(nullptr));
    if (argc == 5 && (std::wstring(argv[1]) == L"publish-session" || std::wstring(argv[1]) == L"inspect-publication")) {
      publicationSession(argv[2], argv[3], std::stoul(argv[4]), std::wstring(argv[1]) == L"inspect-publication");
      return 0;
    }
    if (argc == 6 && std::wstring(argv[1]) == L"publish-replace") {
      auto backup = publishReplace(argv[2], argv[3], argv[4], argv[5]);
      std::cout << "{\"version\":1,\"state\":\"published\",\"backupIdentity\":\""
                << utf8(backup) << "\"}\n";
      return 0;
    }
    if (argc == 5 && std::wstring(argv[1]) == L"publish-cleanup") {
      publishCleanup(argv[2], argv[3], argv[4]);
      std::cout << "{\"version\":1,\"state\":\"cleaned\"}\n";
      return 0;
    }
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
      if (command == "collect" && store.localMode && !filesystem) {
        auto collection = store.collect();
        std::cout << "{\"version\":1,\"state\":\"collected\",\"mode\":\"local\",\"nodes\":" << collection.nodes
                  << ",\"examined\":" << collection.examined << ",\"removed\":" << collection.removed
                  << ",\"bytes\":" << collection.bytes << ",\"retained\":" << collection.retained << "}\n" << std::flush;
        continue;
      }
      if (command.rfind("acknowledge ", 0) == 0 && store.localMode && !filesystem) {
        acknowledge(store, command);
        continue;
      }
      if ((command == "check-reads" || command.rfind("check-reads ", 0) == 0) &&
          store.localMode && !filesystem) {
        std::istringstream input(command.substr(11));
        std::vector<sqlite3_int64> epochs;
        sqlite3_int64 epoch = -1;
        while (input >> epoch) {
          if (epochs.size() >= 100) {
            throw Error{STATUS_INVALID_PARAMETER};
          }
          epochs.push_back(epoch);
        }
        if (!input.eof()) {
          throw Error{STATUS_INVALID_PARAMETER};
        }
        store.checkReads(epochs);
        std::cout << "{\"version\":1,\"state\":\"reads-checked\",\"mode\":\"local\"}\n"
                  << std::flush;
        continue;
      }
      if (command == "freeze" && store.localMode && filesystem) {
        FspFileSystemStopDispatcher(filesystem);
        FspFileSystemDelete(filesystem);
        filesystem = nullptr;
        store.sealChanges();
        std::cout << "{\"version\":1,\"state\":\"frozen\",\"mode\":\"local\"}\n" << std::flush;
        continue;
      }
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
    if (filesystem) {
      FspFileSystemStopDispatcher(filesystem);
      FspFileSystemDelete(filesystem);
    }
    store.finish();
    std::cout << "{\"version\":1,\"state\":\"stopped\"}\n" << std::flush;
    return 0;
  } catch (const Error& error) {
    std::cout << "{\"version\":1,\"error\":\"native\",\"status\":"
              << static_cast<UINT32>(error.status) << ",\"stage\":" << publishStage() << "}\n";
  } catch (...) {
    std::cout << "{\"version\":1,\"error\":\"filesystem\"}\n";
  }
  return 1;
}
