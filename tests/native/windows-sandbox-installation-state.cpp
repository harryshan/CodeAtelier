/**
 * 用真实 Supervisor 代码验证安装状态解析和 LSA 账户读 ACL 构造。
 * native build 单独编译并运行本文件；它包含产品源以调用相同的解析函数。
 * 默认只创建进程内测试 ACL；显式 OS 探针会创建并关闭会话内 station/desktop。
 * 两种模式都不修改机器账户、LSA 对象或 WFP 规则，也不运行产品的 Supervisor 入口。
 *
 * 1. 写入包含两个非默认 relay 端口的安装状态夹具。
 * 2. 调用 ReadInstallationState，核对端口与版本，并拒绝无效端口。
 * 3. 用真实二进制 journal 帧验证恢复入口接受已安装授权的合法标志，普通撤销入口仍拒绝这些标志。
 * 4. 在进程内 ACL 上验证新增的安装者读取 ACE 不丢弃既有 ACE，也不授予写入。
 * 5. 核对 bootstrap pipe 不授予实例 SID，Agent Runtime 专属 pipe 才授予本实例 restricting SID，避免 WRITE_RESTRICTED 客户端无法连接；真实受限 token 连接仍由安装后产品验收证明。
 * 6. 显式 --window-station-probe 在真实 Windows 会话中用不同账户替身 SID 创建并关闭两个非交互式 station/desktop 句柄，验证已有 station 补装第二个账户 ACE、实例授权、原 station 恢复，以及带完整 station/desktop 名称的 USER32 子进程启动；默认 native build 不运行此 OS 探针。
 * 7. 删除临时夹具，以退出码报告回归结果。
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

bool TestRuntimePipeSecurity() {
  auto fail = [](const wchar_t* stage) {
    std::wcerr << L"PIPE_SECURITY_PROBE stage=" << stage << L" win32="
               << GetLastError() << L"\n";
    return false;
  };
  PSID raw_account = nullptr;
  std::wstring current_sid = CurrentUserSidString();
  if (!ConvertStringSidToSidW(current_sid.c_str(), &raw_account)) {
    return fail(L"account");
  }
  LocalPointer account(raw_account);
  SidPointer execution = CreateCapabilitySid();
  if (!account || !execution) {
    return fail(L"sid");
  }
  SECURITY_ATTRIBUTES bootstrap_attributes{};
  LocalPointer bootstrap_descriptor;
  SECURITY_ATTRIBUTES runtime_attributes{};
  LocalPointer runtime_descriptor;
  if (!BuildPipeSecurity(account.get(), nullptr, &bootstrap_attributes,
                         &bootstrap_descriptor) ||
      !BuildPipeSecurity(account.get(), execution.get(), &runtime_attributes,
                         &runtime_descriptor)) {
    return fail(L"build");
  }
  BOOL bootstrap_present = FALSE;
  BOOL bootstrap_defaulted = FALSE;
  PACL bootstrap_acl = nullptr;
  BOOL runtime_present = FALSE;
  BOOL runtime_defaulted = FALSE;
  PACL runtime_acl = nullptr;
  if (!GetSecurityDescriptorDacl(bootstrap_descriptor.get(),
                                 &bootstrap_present, &bootstrap_acl,
                                 &bootstrap_defaulted) ||
      !GetSecurityDescriptorDacl(runtime_descriptor.get(), &runtime_present,
                                 &runtime_acl, &runtime_defaulted)) {
    return fail(L"dacl");
  }
  if (!bootstrap_present || !runtime_present || !bootstrap_acl ||
      !runtime_acl ||
      !AclHasExplicitGrantForSid(bootstrap_acl, account.get()) ||
      AclHasExplicitGrantForSid(bootstrap_acl, execution.get()) ||
      !AclHasExplicitGrantForSid(runtime_acl, account.get()) ||
      !AclHasExplicitGrantForSid(runtime_acl, execution.get())) {
    return fail(L"shape");
  }
  return true;
}

bool ReadRevokeFixture(const std::filesystem::path& path, bool journal_mode) {
  UniqueHandle input(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ,
                                 nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                                 nullptr));
  std::vector<ProductRoot> roots;
  return static_cast<bool>(input) &&
         ReadRevokeRoots(input.get(), &roots, journal_mode) &&
         roots.size() == 1;
}

bool TestGrantJournalFlags(const std::filesystem::path& path, uint32_t flags,
                           bool expected_journal, bool expected_revoke) {
  UniqueHandle output(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                                  CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                                  nullptr));
  uint32_t count = 1;
  if (!output || !WriteExact(output.get(), &kRequestMagic,
                             sizeof(kRequestMagic)) ||
      !WriteExact(output.get(), &kRequestVersion,
                  sizeof(kRequestVersion)) ||
      !WriteExact(output.get(), &count, sizeof(count)) ||
      !WriteExact(output.get(), &flags, sizeof(flags)) ||
      !WriteFramedString(output.get(), L"C:\\fixture") ||
      !WriteFramedString(output.get(), L"1") ||
      !WriteFramedString(output.get(), L"2") ||
      !WriteFramedString(output.get(), std::wstring(64, L'a'))) {
    return false;
  }
  output.reset();
  return ReadRevokeFixture(path, true) == expected_journal &&
         ReadRevokeFixture(path, false) == expected_revoke;
}

bool TestPrivateDesktopStation() {
  // Use a SID distinct from the caller: the production account is not the
  // interactive user, and its ACE can be absent on an existing station.
  SidPointer account_a = CreateCapabilitySid();
  SidPointer account_b = CreateCapabilitySid();
  if (!account_a || !account_b) {
    return false;
  }
  SidPointer execution_a = CreateCapabilitySid();
  SidPointer capability_a = CreateCapabilitySid();
  SidPointer execution_b = CreateCapabilitySid();
  SidPointer capability_b = CreateCapabilitySid();
  if (!execution_a || !capability_a || !execution_b || !capability_b) {
    return false;
  }
  HWINSTA previous_station = GetProcessWindowStation();
  UniqueWindowStation station_a;
  UniqueWindowStation station_b;
  UniqueDesktop desktop_a;
  UniqueDesktop desktop_b;
  std::wstring name_a;
  std::wstring name_b;
  if (!CreatePrivateDesktop(account_a.get(), execution_a.get(),
                            capability_a.get(), &name_a, &station_a,
                            &desktop_a)) {
    std::wcerr << L"WINDOW_STATION_PROBE_STAGE first win32=" << GetLastError()
               << L"\n";
    return false;
  }
  if (!CreatePrivateDesktop(account_b.get(), execution_b.get(),
                            capability_b.get(), &name_b, &station_b,
                            &desktop_b)) {
    std::wcerr << L"WINDOW_STATION_PROBE_STAGE second win32=" << GetLastError()
               << L"\n";
    return false;
  }
  wchar_t station_name[256]{};
  DWORD needed = 0;
  if (!GetUserObjectInformationW(station_a.get(), UOI_NAME, station_name,
                                 sizeof(station_name), &needed)) {
    std::wcerr << L"WINDOW_STATION_PROBE_STAGE name win32=" << GetLastError()
               << L"\n";
    return false;
  }
  std::wstring prefix = std::wstring(station_name) + L"\\";
  if (prefix == L"WinSta0\\" || name_a.rfind(prefix, 0) != 0 ||
      name_b.rfind(prefix, 0) != 0 || name_a == name_b ||
      GetProcessWindowStation() != previous_station) {
    std::wcerr << L"WINDOW_STATION_PROBE_STAGE path\n";
    return false;
  }
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD result = GetSecurityInfo(station_b.get(), SE_WINDOW_OBJECT,
                                 DACL_SECURITY_INFORMATION, nullptr, nullptr,
                                 &acl, nullptr, &descriptor);
  LocalPointer owned_descriptor(descriptor);
  bool valid = result == ERROR_SUCCESS &&
               AclHasExplicitGrantForSid(acl, account_a.get()) &&
               AclHasExplicitGrantForSid(acl, account_b.get()) &&
               AclHasExplicitGrantForSid(acl, execution_a.get()) &&
               AclHasExplicitGrantForSid(acl, capability_a.get()) &&
               AclHasExplicitGrantForSid(acl, execution_b.get()) &&
               AclHasExplicitGrantForSid(acl, capability_b.get());
  if (!valid) {
    std::wcerr << L"WINDOW_STATION_PROBE_STAGE acl win32=" << result << L"\n";
  }
  if (!valid) {
    return false;
  }
  PACL desktop_acl = nullptr;
  PSECURITY_DESCRIPTOR desktop_descriptor = nullptr;
  result = GetSecurityInfo(desktop_a.get(), SE_WINDOW_OBJECT,
                           DACL_SECURITY_INFORMATION, nullptr, nullptr,
                           &desktop_acl, nullptr, &desktop_descriptor);
  LocalPointer owned_desktop_descriptor(desktop_descriptor);
  if (result != ERROR_SUCCESS ||
      !AclHasExplicitGrantForSid(desktop_acl, account_a.get()) ||
      AclHasExplicitGrantForSid(desktop_acl, account_b.get()) ||
      !AclHasExplicitGrantForSid(desktop_acl, execution_a.get()) ||
      !AclHasExplicitGrantForSid(desktop_acl, capability_a.get()) ||
      AclHasExplicitGrantForSid(desktop_acl, execution_b.get()) ||
      AclHasExplicitGrantForSid(desktop_acl, capability_b.get())) {
    std::wcerr << L"WINDOW_STATION_PROBE_STAGE desktop_acl win32=" << result
               << L"\n";
    return false;
  }
  std::wstring executable = CurrentExecutablePath();
  std::wstring command =
      BuildCommandLine(executable, {L"--window-station-child"});
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.lpDesktop = name_a.data();
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(executable.c_str(), mutable_command.data(), nullptr,
                      nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr,
                      &startup, &child)) {
    std::wcerr << L"WINDOW_STATION_PROBE_STAGE child_create win32="
               << GetLastError() << L"\n";
    return false;
  }
  UniqueHandle child_process(child.hProcess);
  UniqueHandle child_thread(child.hThread);
  if (WaitForSingleObject(child_process.get(), 5000) != WAIT_OBJECT_0) {
    TerminateProcess(child_process.get(), 1);
    WaitForSingleObject(child_process.get(), 5000);
    std::wcerr << L"WINDOW_STATION_PROBE_STAGE child_timeout\n";
    return false;
  }
  DWORD exit_code = 1;
  return GetExitCodeProcess(child_process.get(), &exit_code) && exit_code == 0;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc == 2 && std::wstring(argv[1]) == L"--window-station-child") {
    return 0;
  }
  if (argc == 2 && std::wstring(argv[1]) == L"--window-station-probe") {
    if (!TestPrivateDesktopStation()) {
      std::wcerr << L"SANDBOX_WINDOW_STATION_PROBE FAIL\n";
      return 1;
    }
    std::wcout << L"SANDBOX_WINDOW_STATION_PROBE PASS\n";
    return 0;
  }
  if (argc != 1) {
    return 2;
  }
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
  valid = valid && TestGrantJournalFlags(fixture, 4, true, false) &&
          TestGrantJournalFlags(fixture, 5, true, false) &&
          TestGrantJournalFlags(fixture, 6, true, false) &&
          TestGrantJournalFlags(fixture, 7, false, false) &&
          TestGrantJournalFlags(fixture, 2, false, true);
  valid = valid && TestInstallerAccountAcl() && TestRuntimePipeSecurity();
  std::error_code remove_error;
  std::filesystem::remove(fixture, remove_error);
  if (!valid || remove_error) {
    std::wcerr << L"SANDBOX_NATIVE_REGRESSION FAIL\n";
    return 1;
  }
  std::wcout << L"SANDBOX_NATIVE_REGRESSION PASS\n";
  return 0;
}
