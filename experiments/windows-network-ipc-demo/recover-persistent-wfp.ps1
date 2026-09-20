<#
.SYNOPSIS
Recovers from an interrupted CodeAtelier persistent WFP feasibility run.

.DESCRIPTION
This standalone script does not depend on the demo executable. It opens BFE
through fwpuclnt.dll, enumerates a filter snapshot, selects only filters owned
by the probe's fixed provider GUID, deletes those filters, then deletes the fixed
sublayer and provider. It also removes only disposable users matching CAPersist
plus eight hex characters and persistent-run plus a 32-hex ID under this
repository's ignored build directory. Supports -WhatIf for preview.

The script never searches for or removes arbitrary WFP providers, firewall
rules, local users, or directories. Run it from an elevated PowerShell when
performing recovery.
#>

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
param()

$ErrorActionPreference = "Stop"
$providerId = [Guid]"9e201d5a-9dc9-4ae1-89e5-4365df7f2201"
$sublayerId = [Guid]"2d283465-f136-45ac-a8ba-df3aaa3b2202"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$buildRoot = Join-Path $repoRoot ".local\windows-network-ipc-demo"

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "恢复 persistent WFP policy 必须在提升的 PowerShell 中执行。"
    }
}

function Assert-PathContained {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Root
    )

    $normalizedPath = [IO.Path]::GetFullPath($Path)
    $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $normalizedPath.StartsWith($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝清理验证根之外的路径：$normalizedPath"
    }
}

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CodeAtelierWfpRecovery
{
    private const uint RpcAuthnWinnt = 10;
    private const uint FilterNotFound = 0x80320003;
    private const uint ProviderNotFound = 0x80320005;
    private const uint SublayerNotFound = 0x80320007;

    [StructLayout(LayoutKind.Sequential)]
    private struct DisplayData
    {
        public IntPtr Name;
        public IntPtr Description;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FilterHeader
    {
        public Guid FilterKey;
        public DisplayData DisplayData;
        public uint Flags;
        public IntPtr ProviderKey;
    }

    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode)]
    private static extern uint FwpmEngineOpen0(
        string serverName,
        uint authnService,
        IntPtr authIdentity,
        IntPtr session,
        out IntPtr engine);

    [DllImport("fwpuclnt.dll")]
    private static extern uint FwpmEngineClose0(IntPtr engine);

    [DllImport("fwpuclnt.dll")]
    private static extern uint FwpmFilterCreateEnumHandle0(
        IntPtr engine,
        IntPtr enumTemplate,
        out IntPtr enumHandle);

    [DllImport("fwpuclnt.dll")]
    private static extern uint FwpmFilterEnum0(
        IntPtr engine,
        IntPtr enumHandle,
        uint requested,
        out IntPtr entries,
        out uint returned);

    [DllImport("fwpuclnt.dll")]
    private static extern uint FwpmFilterDestroyEnumHandle0(
        IntPtr engine,
        IntPtr enumHandle);

    [DllImport("fwpuclnt.dll")]
    private static extern uint FwpmFilterDeleteByKey0(
        IntPtr engine,
        ref Guid filterKey);

    [DllImport("fwpuclnt.dll")]
    private static extern uint FwpmSubLayerDeleteByKey0(
        IntPtr engine,
        ref Guid sublayerKey);

    [DllImport("fwpuclnt.dll")]
    private static extern uint FwpmProviderDeleteByKey0(
        IntPtr engine,
        ref Guid providerKey);

    [DllImport("fwpuclnt.dll")]
    private static extern void FwpmFreeMemory0(ref IntPtr memory);

    private static void RequireSuccess(uint result, string operation)
    {
        if (result != 0)
        {
            throw new InvalidOperationException(
                operation + " failed with 0x" + result.ToString("X8"));
        }
    }

    public static int Remove(Guid providerKey, Guid sublayerKey)
    {
        IntPtr engine = IntPtr.Zero;
        IntPtr enumHandle = IntPtr.Zero;
        IntPtr entries = IntPtr.Zero;
        List<Guid> filterKeys = new List<Guid>();
        try
        {
            RequireSuccess(
                FwpmEngineOpen0(null, RpcAuthnWinnt, IntPtr.Zero, IntPtr.Zero, out engine),
                "FwpmEngineOpen0");
            RequireSuccess(
                FwpmFilterCreateEnumHandle0(engine, IntPtr.Zero, out enumHandle),
                "FwpmFilterCreateEnumHandle0");
            while (true)
            {
                uint returned;
                RequireSuccess(
                    FwpmFilterEnum0(engine, enumHandle, 256, out entries, out returned),
                    "FwpmFilterEnum0");
                try
                {
                    for (uint index = 0; index < returned; index++)
                    {
                        IntPtr filterPointer = Marshal.ReadIntPtr(
                            entries, checked((int)index * IntPtr.Size));
                        FilterHeader filter = Marshal.PtrToStructure<FilterHeader>(filterPointer);
                        if (filter.ProviderKey != IntPtr.Zero &&
                            Marshal.PtrToStructure<Guid>(filter.ProviderKey) == providerKey)
                        {
                            filterKeys.Add(filter.FilterKey);
                        }
                    }
                }
                finally
                {
                    if (entries != IntPtr.Zero)
                    {
                        FwpmFreeMemory0(ref entries);
                    }
                }
                if (returned == 0)
                {
                    break;
                }
            }

            RequireSuccess(FwpmFilterDestroyEnumHandle0(engine, enumHandle),
                           "FwpmFilterDestroyEnumHandle0");
            enumHandle = IntPtr.Zero;
            foreach (Guid key in filterKeys)
            {
                Guid filterKey = key;
                uint filterResult = FwpmFilterDeleteByKey0(engine, ref filterKey);
                if (filterResult != 0 && filterResult != FilterNotFound)
                {
                    RequireSuccess(filterResult, "FwpmFilterDeleteByKey0");
                }
            }

            uint sublayerResult = FwpmSubLayerDeleteByKey0(engine, ref sublayerKey);
            if (sublayerResult != 0 && sublayerResult != SublayerNotFound)
            {
                RequireSuccess(sublayerResult, "FwpmSubLayerDeleteByKey0");
            }
            uint providerResult = FwpmProviderDeleteByKey0(engine, ref providerKey);
            if (providerResult != 0 && providerResult != ProviderNotFound)
            {
                RequireSuccess(providerResult, "FwpmProviderDeleteByKey0");
            }
            return filterKeys.Count;
        }
        finally
        {
            if (entries != IntPtr.Zero)
            {
                FwpmFreeMemory0(ref entries);
            }
            if (enumHandle != IntPtr.Zero && engine != IntPtr.Zero)
            {
                FwpmFilterDestroyEnumHandle0(engine, enumHandle);
            }
            if (engine != IntPtr.Zero)
            {
                FwpmEngineClose0(engine);
            }
        }
    }
}
'@

$policyTarget = "WFP provider $providerId and sublayer $sublayerId"
if ($PSCmdlet.ShouldProcess($policyTarget, "Remove exact persistent probe objects")) {
    Assert-Administrator
    Add-Type -TypeDefinition $nativeSource -Language CSharp
    $deletedFilters = [CodeAtelierWfpRecovery]::Remove($providerId, $sublayerId)
    Write-Host "RECOVERY WFP PASS deletedFilters=$deletedFilters"
}

$accounts = @(
    Get-LocalUser -ErrorAction Stop |
        Where-Object Name -Match '^CAPersist[0-9A-Fa-f]{8}$'
)
foreach ($account in $accounts) {
    if ($PSCmdlet.ShouldProcess("local user $($account.Name)", "Remove disposable probe account")) {
        Assert-Administrator
        Remove-LocalUser -Name $account.Name
        Write-Host "RECOVERY ACCOUNT removed=$($account.Name)"
    }
}

if (Test-Path -LiteralPath $buildRoot -PathType Container) {
    $runDirectories = @(
        Get-ChildItem -LiteralPath $buildRoot -Directory -Filter "persistent-run-*" |
            Where-Object Name -Match '^persistent-run-[0-9A-Fa-f]{32}$'
    )
    foreach ($directory in $runDirectories) {
        Assert-PathContained -Path $directory.FullName -Root $buildRoot
        if ($PSCmdlet.ShouldProcess($directory.FullName, "Remove disposable probe directory")) {
            Remove-Item -LiteralPath $directory.FullName -Recurse -Force
            Write-Host "RECOVERY DIRECTORY removed=$($directory.FullName)"
        }
    }
}

Write-Host "RECOVERY COMPLETE provider=$providerId sublayer=$sublayerId accounts=$($accounts.Count)"
