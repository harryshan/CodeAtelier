/**
 * 用真实 Supervisor 状态解析器验证安装器写入的版本 4 状态格式。
 * native build 单独编译并运行本文件；它包含产品源以调用相同的解析函数，
 * 不创建账户、ACL 或 WFP 对象，也不运行产品的 Supervisor 入口。
 *
 * 1. 写入包含两个非默认 relay 端口的安装状态夹具。
 * 2. 调用 ReadInstallationState，核对端口与版本，并拒绝无效端口。
 * 3. 删除临时夹具，以退出码报告回归结果。
 */

#define CODEATELIER_INSTALLATION_STATE_TEST
#include "../../native/windows-sandbox/restricted-runner.cpp"

namespace {

bool WriteFixture(const std::filesystem::path& path, uint16_t port_v4,
                  bool include_port_v4 = true) {
  std::wofstream output(path);
  if (!output) {
    return false;
  }
  const std::wstring digest(64, L'a');
  output << L"version=4\n"
         << L"accountName=CodeAtelierSandbox\n"
         << L"accountSid=S-1-5-21-1\n"
         << L"generationId=test-generation\n"
         << L"protectedPassword=test-password\n"
         << L"installedBySid=S-1-5-21-2\n";
  if (include_port_v4) {
    output << L"relayPortV4=" << port_v4 << L"\n";
  }
  output << L"relayPortV6=42872\n"
         << L"runtimeNodeSha256=" << digest << L"\n"
         << L"runtimeEntrySha256=" << digest << L"\n"
         << L"runtimeWorkerSha256=" << digest << L"\n"
         << L"runtimeReadWorkerSha256=" << digest << L"\n"
         << L"runtimeSubagentWorkerSha256=" << digest << L"\n";
  return output.good();
}

}  // namespace

int wmain() {
  std::filesystem::path fixture = std::filesystem::temp_directory_path() /
                                  (L"codeatelier-state-parser-" +
                                   std::to_wstring(GetCurrentProcessId()) +
                                   L".txt");
  InstallationState state;
  bool valid = WriteFixture(fixture, 42871) &&
               ReadInstallationState(fixture.wstring(), &state) &&
               state.version == 4 && state.relay_port_v4 == 42871 &&
               state.relay_port_v6 == 42872;
  valid = valid && WriteFixture(fixture, 0) &&
          !ReadInstallationState(fixture.wstring(), &state);
  valid = valid && WriteFixture(fixture, 42871, false) &&
          !ReadInstallationState(fixture.wstring(), &state);
  std::error_code remove_error;
  std::filesystem::remove(fixture, remove_error);
  if (!valid || remove_error) {
    std::wcerr << L"SANDBOX_NATIVE_STATE_PARSE FAIL\n";
    return 1;
  }
  std::wcout << L"SANDBOX_NATIVE_STATE_PARSE PASS\n";
  return 0;
}
