/**
 * 用真实 Supervisor 代码验证安装状态解析和 LSA 账户读 ACL 构造。
 * native build 单独编译并运行本文件；它包含产品源以调用相同的解析函数，
 * 只创建进程内测试 ACL；不修改机器账户、LSA 对象或 WFP 规则，也不运行产品的 Supervisor 入口。
 *
 * 1. 写入包含两个非默认 relay 端口的安装状态夹具。
 * 2. 调用 ReadInstallationState，核对端口与版本，并拒绝无效端口。
 * 3. 在进程内 ACL 上验证新增的安装者读取 ACE 不丢弃既有 ACE，也不授予写入。
 * 4. 删除临时夹具，以退出码报告回归结果。
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

bool TestInstallerAccountAcl() {
  BYTE installer_buffer[SECURITY_MAX_SID_SIZE]{};
  DWORD installer_size = sizeof(installer_buffer);
  BYTE system_buffer[SECURITY_MAX_SID_SIZE]{};
  DWORD system_size = sizeof(system_buffer);
  if (!CreateWellKnownSid(WinBuiltinUsersSid, nullptr, installer_buffer,
                          &installer_size) ||
      !CreateWellKnownSid(WinLocalSystemSid, nullptr, system_buffer,
                          &system_size)) {
    return false;
  }

  EXPLICIT_ACCESSW existing{};
  existing.grfAccessPermissions = READ_CONTROL | WRITE_DAC;
  existing.grfAccessMode = GRANT_ACCESS;
  existing.grfInheritance = NO_INHERITANCE;
  existing.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  existing.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  existing.Trustee.ptstrName =
      reinterpret_cast<LPWSTR>(system_buffer);
  PACL old_acl = nullptr;
  if (SetEntriesInAclW(1, &existing, nullptr, &old_acl) != ERROR_SUCCESS) {
    return false;
  }
  LocalPointer owned_old_acl(old_acl);

  PACL new_acl = nullptr;
  if (!CreateInstallerReadAcl(old_acl, installer_buffer, &new_acl)) {
    return false;
  }
  LocalPointer owned_new_acl(new_acl);
  TRUSTEEW installer{};
  installer.TrusteeForm = TRUSTEE_IS_SID;
  installer.ptstrName = reinterpret_cast<LPWSTR>(installer_buffer);
  ACCESS_MASK installer_access = 0;
  TRUSTEEW system{};
  system.TrusteeForm = TRUSTEE_IS_SID;
  system.ptstrName = reinterpret_cast<LPWSTR>(system_buffer);
  ACCESS_MASK system_access = 0;
  return GetEffectiveRightsFromAclW(new_acl, &installer,
                                    &installer_access) == ERROR_SUCCESS &&
         GetEffectiveRightsFromAclW(new_acl, &system,
                                    &system_access) == ERROR_SUCCESS &&
         (installer_access & kLsaAccountView) != 0 &&
         (installer_access & (WRITE_DAC | WRITE_OWNER | DELETE)) == 0 &&
         (system_access & (READ_CONTROL | WRITE_DAC)) ==
             (READ_CONTROL | WRITE_DAC);
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
  valid = valid && TestInstallerAccountAcl();
  std::error_code remove_error;
  std::filesystem::remove(fixture, remove_error);
  if (!valid || remove_error) {
    std::wcerr << L"SANDBOX_NATIVE_REGRESSION FAIL\n";
    return 1;
  }
  std::wcout << L"SANDBOX_NATIVE_REGRESSION PASS\n";
  return 0;
}
