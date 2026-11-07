import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { arch, release, version } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { probe, run, type ContainerRequest } from '@microsoft/mxc-sdk/v1';
import { expect, it } from 'vitest';
import { buildWindowsMxcRequest, quoteWindowsArgv } from './windows-mxc';

if (process.env.TRACEMIND_REQUIRE_WINDOWS === '1' && process.platform !== 'win32') {
  throw new Error('TRACEMIND_REQUIRE_WINDOWS=1 requires a Windows runner');
}

interface WindowsFixture {
  root: string;
  approvedDirectory: string;
  temporaryDirectory: string;
  outsidePath: string;
  systemRoot: string;
}

interface Captured<T> {
  value: T | null;
  error: { name: string; message: string; code: string | null } | null;
}

interface DirectExecution {
  executable: string;
  args: string[];
  pid: number;
  processStarted: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: { message: string; code: string | null } | null;
}

interface SessionContext {
  sessionId: number | null;
  windowStationName: string | null;
  windowStationVisible: boolean | null;
  threadDesktopName: string | null;
  userInteractive: boolean | null;
  tokenSessionId: number | null;
  tokenType: number | null;
  tokenElevationType: number | null;
  tokenElevated: boolean | null;
  tokenIntegrityRid: number | null;
  tokenIsAppContainer: boolean | null;
  wtsConnectState: number | null;
  interactiveSession: boolean | null;
  metadataError: string | null;
  error: string | null;
}

interface NativeCliExecution {
  executable: string;
  helperPid: number | null;
  helperStarted: boolean;
  helperExitCode: number | null;
  helperExitHex: string | null;
  helperSignal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  targetPid: number | null;
  targetPidEvidence: string | null;
  targetExitCode: number | null;
  targetExitHex: string | null;
  targetExitCodeEvidence: string | null;
  captureDenialsPointer: CaptureDenialsPointer | null;
  /** Non-enumerable so an absolute host path cannot leak through serialized diagnostics. */
  rawCaptureDenialsPointer?: CaptureDenialsPointer | null;
  stdout: string;
  stderr: string;
  error: { message: string; code: string | null } | null;
  logPath: string;
  logPresent: boolean;
  logSha256: string | null;
  runtimeLifecycleLines: string[];
  mxcAuditEvents: SanitizedMxcAuditEvent[];
  effectiveConfig: EffectiveNativeConfigSummary | null;
}

interface CaptureDenialsPointer {
  outputPath: string;
  exitCode: number | null;
  totalDenials: number | null;
  deniedResourcesTruncated: boolean | null;
  etlPath: string | null;
}

interface SanitizedMxcAuditEvent {
  event: string;
  backend?: string;
  policy_hash?: string;
  config_schema_version?: string;
  identity?: string;
  tier?: string;
  enforcement_mode?: string;
  default_policy?: string;
  proxy_port?: number;
  firewall_rules_created?: number;
  firewall_applied?: boolean;
  status?: string;
  pid?: number;
  exit_code?: number;
  firewall_rules_removed?: number;
  firewall_removal_ok?: boolean;
  container_released?: boolean;
}

interface EffectiveNativeConfigSummary {
  uiDisable: boolean | null;
  captureDenials: {
    mode: string | null;
    outputPath: string | null;
    retainEtl: boolean | null;
  } | null;
}

type PrepareContainerRequest = (
  request: ContainerRequest,
  telemetry: { enabled: false }
) => unknown;

const require = createRequire(import.meta.url);

function errorDetails(error: unknown): Captured<never>['error'] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: 'code' in error && typeof error.code === 'string' ? error.code : null,
    };
  }
  return { name: 'UnknownError', message: String(error), code: null };
}

function processErrorCode(error: Error | undefined): string | null {
  return error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCaptureDenialsPointer(text: string): CaptureDenialsPointer | null {
  for (const line of text.split(/\r?\n/u)) {
    const jsonStart = line.indexOf('{');
    if (jsonStart < 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(jsonStart));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== 'captureDenials') continue;
    return {
      outputPath: typeof parsed.outputPath === 'string' ? parsed.outputPath : '',
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
      totalDenials: typeof parsed.totalDenials === 'number' ? parsed.totalDenials : null,
      deniedResourcesTruncated:
        typeof parsed.deniedResourcesTruncated === 'boolean'
          ? parsed.deniedResourcesTruncated
          : null,
      etlPath: typeof parsed.etlPath === 'string' ? parsed.etlPath : null,
    };
  }
  return null;
}

function parseMxcAuditEvents(contents: string): SanitizedMxcAuditEvent[] {
  const allowedFields = [
    'backend',
    'policy_hash',
    'config_schema_version',
    'identity',
    'tier',
    'enforcement_mode',
    'default_policy',
    'proxy_port',
    'firewall_rules_created',
    'firewall_applied',
    'status',
    'pid',
    'exit_code',
    'firewall_rules_removed',
    'firewall_removal_ok',
    'container_released',
  ] as const;
  const events: SanitizedMxcAuditEvent[] = [];
  for (const line of contents.split(/\r?\n/u)) {
    const jsonStart = line.indexOf('{');
    if (jsonStart < 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(jsonStart));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.event !== 'string' || !parsed.event.startsWith('mxc.'))
      continue;
    const event: SanitizedMxcAuditEvent = { event: parsed.event };
    for (const field of allowedFields) {
      const value = parsed[field];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        if (field === 'identity') {
          event.identity = value === 'redacted' ? value : '<MXC_IDENTITY_REDACTED>';
        } else {
          Object.assign(event, { [field]: value });
        }
      }
    }
    events.push(event);
  }
  return events;
}

function parseJsonObjectAt(text: string, start: number): Record<string, unknown> | null {
  const objectStart = text.indexOf('{', start);
  if (objectStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(text.slice(objectStart, index + 1));
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function nativeConfigSummary(
  stdout: string,
  fixture: WindowsFixture
): EffectiveNativeConfigSummary | null {
  const marker = 'SECTION: JSON Config (redacted)';
  const markerIndex = stdout.indexOf(marker);
  if (markerIndex < 0) return null;
  const config = parseJsonObjectAt(stdout, markerIndex + marker.length);
  if (!config) return null;
  const ui = isRecord(config.ui) ? config.ui : null;
  const processContainer = isRecord(config.process_container)
    ? config.process_container
    : isRecord(config.processContainer)
      ? config.processContainer
      : null;
  const capture = processContainer
    ? isRecord(processContainer.capture_denials)
      ? processContainer.capture_denials
      : isRecord(processContainer.captureDenials)
        ? processContainer.captureDenials
        : null
    : null;
  return {
    uiDisable: ui && typeof ui.disable === 'boolean' ? ui.disable : null,
    captureDenials: capture
      ? {
          mode: typeof capture.mode === 'string' ? capture.mode : null,
          outputPath:
            typeof capture.output_path === 'string'
              ? redactFixturePaths(capture.output_path, fixture)
              : typeof capture.outputPath === 'string'
                ? redactFixturePaths(capture.outputPath, fixture)
                : null,
          retainEtl:
            typeof capture.retain_etl === 'boolean'
              ? capture.retain_etl
              : typeof capture.retainEtl === 'boolean'
                ? capture.retainEtl
                : null,
        }
      : null,
  };
}

function isWithinPath(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function packageRoot(): string {
  let directory = dirname(require.resolve('@microsoft/mxc-sdk/v1'));
  while (directory !== dirname(directory)) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (parsed.name === '@microsoft/mxc-sdk') return directory;
    }
    directory = dirname(directory);
  }
  throw new Error('Installed @microsoft/mxc-sdk package root not found');
}

function peMachine(path: string): string | null {
  try {
    const bytes = readFileSync(path);
    if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') return null;
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset + 6 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0')
      return null;
    const machine = bytes.readUInt16LE(peOffset + 4);
    return machine === 0xaa64
      ? 'ARM64'
      : machine === 0x8664
        ? 'AMD64'
        : `0x${machine.toString(16)}`;
  } catch {
    return null;
  }
}

function windowsUpdateRevision(systemRoot: string): number | null {
  const registry = join(systemRoot, 'System32', 'reg.exe');
  const result = spawnSync(
    registry,
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'UBR'],
    { encoding: 'utf8', timeout: 2_000, windowsHide: true }
  );
  const match = /\bUBR\s+REG_DWORD\s+0x([0-9a-f]+)/iu.exec(result.stdout ?? '');
  return match ? Number.parseInt(match[1], 16) : null;
}

/** Reads session, desktop, and non-identifying token facts without changing the caller context. */
function windowsSessionContext(systemRoot: string): SessionContext {
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = String.raw`$ErrorActionPreference = 'Stop'
$null = Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class TraceMindWindowStationProbe {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", SetLastError = true)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, IntPtr info, uint length, out uint needed);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length, out int needed);
  [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool WTSQuerySessionInformation(IntPtr server, uint sessionId, int informationClass, out IntPtr buffer, out uint bytesReturned);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr memory);
  private static int TokenInt(IntPtr token, int informationClass) {
    IntPtr buffer = Marshal.AllocHGlobal(sizeof(int));
    try { int needed; if (!GetTokenInformation(token, informationClass, buffer, sizeof(int), out needed)) { int error = Marshal.GetLastWin32Error(); throw new Win32Exception(error, "GetTokenInformation class " + informationClass); } return Marshal.ReadInt32(buffer); }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  private static int IntegrityRid(IntPtr token) {
    IntPtr buffer = Marshal.AllocHGlobal(4096);
    try {
      int needed; if (!GetTokenInformation(token, 25, buffer, 4096, out needed)) { int error = Marshal.GetLastWin32Error(); throw new Win32Exception(error, "GetTokenInformation class 25"); }
      IntPtr sid = Marshal.ReadIntPtr(buffer); IntPtr countPointer = GetSidSubAuthorityCount(sid);
      if (countPointer == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      byte count = Marshal.ReadByte(countPointer); if (count == 0) throw new InvalidOperationException("Integrity SID has no subauthorities");
      IntPtr rid = GetSidSubAuthority(sid, (uint)(count - 1)); if (rid == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      return Marshal.ReadInt32(rid);
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  private static string ObjectName(IntPtr handle) {
    uint length; GetUserObjectInformation(handle, 2, IntPtr.Zero, 0, out length);
    if (length < 2) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr buffer = Marshal.AllocHGlobal((int)length);
    try { if (!GetUserObjectInformation(handle, 2, buffer, length, out length)) throw new Win32Exception(Marshal.GetLastWin32Error()); return Marshal.PtrToStringUni(buffer) ?? ""; }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  public static string ReadCurrent() {
    try {
      uint sessionId; if (!ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out sessionId)) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr station = GetProcessWindowStation(); if (station == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr desktop = GetThreadDesktop(GetCurrentThreadId()); if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      string stationName = ObjectName(station); string desktopName = ObjectName(desktop);
      IntPtr flags = Marshal.AllocHGlobal(12); uint needed; int visible;
      try { if (!GetUserObjectInformation(station, 1, flags, 12, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error()); visible = (Marshal.ReadInt32(flags, 8) & 1) != 0 ? 1 : 0; }
      finally { Marshal.FreeHGlobal(flags); }
      string tokenSession = "", tokenType = "", elevationType = "", elevated = "", integrity = "", appContainer = "", state = "", metadataError = "";
      IntPtr token;
      if (OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) {
        try { tokenSession = TokenInt(token, 12).ToString(); tokenType = TokenInt(token, 8).ToString(); elevationType = TokenInt(token, 18).ToString(); elevated = TokenInt(token, 20) != 0 ? "1" : "0"; integrity = IntegrityRid(token).ToString(); appContainer = TokenInt(token, 29) != 0 ? "1" : "0"; }
        catch (Exception error) { metadataError = error.GetType().FullName + ":" + error.Message; }
        finally { CloseHandle(token); }
      } else { metadataError = "OpenProcessToken:" + new Win32Exception(Marshal.GetLastWin32Error()).Message; }
      IntPtr wts; uint bytes;
      if (WTSQuerySessionInformation(IntPtr.Zero, sessionId, 8, out wts, out bytes)) { try { if (bytes >= 4) state = Marshal.ReadInt32(wts).ToString(); } finally { WTSFreeMemory(wts); } }
      else if (metadataError.Length == 0) { metadataError = "WTSQuerySessionInformation:" + new Win32Exception(Marshal.GetLastWin32Error()).Message; }
      int userInteractive = Environment.UserInteractive ? 1 : 0;
      return "OK\t" + sessionId + "\t" + stationName + "\t" + visible + "\t" + desktopName + "\t" + userInteractive + "\t" + tokenSession + "\t" + tokenType + "\t" + elevationType + "\t" + elevated + "\t" + integrity + "\t" + appContainer + "\t" + state + "\t" + metadataError;
    } catch (Exception error) { return "ERROR\t" + error.GetType().FullName + ":" + error.Message.Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' '); }
  }
}
'@
[TraceMindWindowStationProbe]::ReadCurrent()`;
  const result = spawnSync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 3_000, windowsHide: true }
  );
  const empty = {
    sessionId: null,
    windowStationName: null,
    windowStationVisible: null,
    threadDesktopName: null,
    userInteractive: null,
    tokenSessionId: null,
    tokenType: null,
    tokenElevationType: null,
    tokenElevated: null,
    tokenIntegrityRid: null,
    tokenIsAppContainer: null,
    wtsConnectState: null,
    interactiveSession: null,
    metadataError: null,
  } satisfies Omit<SessionContext, 'error'>;
  if (result.error)
    return {
      ...empty,
      error: `${processErrorCode(result.error) ?? 'SPAWN_ERROR'}: ${result.error.message}`,
    };
  if (result.status !== 0)
    return { ...empty, error: `PowerShell exited ${result.status}: ${result.stderr.trim()}` };
  const fields = result.stdout.trim().split('\t');
  if (fields[0] === 'ERROR')
    return {
      ...empty,
      error: fields.slice(1).join('\t') || 'Windows caller context probe failed without details',
    };
  const numberOrNull = (value: string | undefined): number | null => {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const booleanOrNull = (value: string | undefined): boolean | null =>
    value === '1' ? true : value === '0' ? false : null;
  const sessionId = numberOrNull(fields[1]);
  const windowStationVisible = booleanOrNull(fields[3]);
  const userInteractive = booleanOrNull(fields[5]);
  const wtsConnectState = numberOrNull(fields[12]);
  if (
    fields[0] !== 'OK' ||
    sessionId === null ||
    sessionId < 0 ||
    !fields[2] ||
    windowStationVisible === null
  )
    return {
      ...empty,
      error: `Malformed Windows caller context output: ${JSON.stringify(result.stdout)}`,
    };
  const interactiveSession =
    wtsConnectState === null || userInteractive === null || windowStationVisible === null
      ? null
      : wtsConnectState === 0 &&
        userInteractive &&
        fields[2] === 'WinSta0' &&
        windowStationVisible &&
        fields[4] === 'Default';
  return {
    sessionId,
    windowStationName: fields[2],
    windowStationVisible,
    threadDesktopName: fields[4] || null,
    userInteractive,
    tokenSessionId: numberOrNull(fields[6]),
    tokenType: numberOrNull(fields[7]),
    tokenElevationType: numberOrNull(fields[8]),
    tokenElevated: booleanOrNull(fields[9]),
    tokenIntegrityRid: numberOrNull(fields[10]),
    tokenIsAppContainer: booleanOrNull(fields[11]),
    wtsConnectState,
    interactiveSession,
    metadataError: fields[13] || null,
    error: null,
  };
}

function runDirect(executable: string, args: readonly string[]): DirectExecution {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  return {
    executable,
    args: [...args],
    pid: result.pid,
    processStarted: result.pid > 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error
      ? { message: result.error.message, code: processErrorCode(result.error) }
      : null,
  };
}

function hostDiagnostics(systemRoot: string) {
  const root = packageRoot();
  const sdk = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const sdkArch =
    process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  const executor = join(root, 'bin', sdkArch, 'wxc-exec.exe');
  const ffi = join(root, 'bin', sdkArch, 'mxc_ffi.dll');
  const diagnosticConsole = join(root, 'bin', sdkArch, 'mxc-diagnostic-console.exe');
  const sdkDiagnosticSource = readFileSync(join(root, 'dist', 'diagnostic.js'), 'utf8');
  const sdkRunSource = readFileSync(join(root, 'dist', 'v1', 'container.js'), 'utf8');
  const sdkOptions = readFileSync(join(root, 'dist', 'v1', 'operation-options.d.ts'), 'utf8');
  const nativeHelperSource = readFileSync(join(root, 'dist', 'helper.js'), 'utf8');
  const executorBytes = existsSync(executor) ? readFileSync(executor) : null;
  const ffiBytes = existsSync(ffi) ? readFileSync(ffi) : null;
  const diagnosticConsoleBytes = existsSync(diagnosticConsole)
    ? readFileSync(diagnosticConsole)
    : null;
  return {
    platform: process.platform,
    processId: process.pid,
    processArch: process.arch,
    osArch: arch(),
    osRelease: release(),
    osVersion: version(),
    windowsUpdateRevision: process.platform === 'win32' ? windowsUpdateRevision(systemRoot) : null,
    sessionName: process.env.SESSIONNAME ?? '',
    sessionContext: process.platform === 'win32' ? windowsSessionContext(systemRoot) : null,
    sdkVersion: sdk.version,
    sdkArch,
    executorPath: `<MXC_SDK_PACKAGE>/bin/${sdkArch}/wxc-exec.exe`,
    executorPresent: executorBytes !== null,
    executorPeMachine: peMachine(executor),
    executorSha256: executorBytes ? createHash('sha256').update(executorBytes).digest('hex') : null,
    ffiPath: `<MXC_SDK_PACKAGE>/bin/${sdkArch}/mxc_ffi.dll`,
    ffiPresent: ffiBytes !== null,
    ffiPeMachine: peMachine(ffi),
    ffiSha256: ffiBytes ? createHash('sha256').update(ffiBytes).digest('hex') : null,
    diagnosticConsolePath: `<MXC_SDK_PACKAGE>/bin/${sdkArch}/mxc-diagnostic-console.exe`,
    diagnosticConsolePresent: diagnosticConsoleBytes !== null,
    diagnosticConsolePeMachine: peMachine(diagnosticConsole),
    diagnosticConsoleSha256: diagnosticConsoleBytes
      ? createHash('sha256').update(diagnosticConsoleBytes).digest('hex')
      : null,
    sdkDiagnosticPipeReadsToken: sdkDiagnosticSource.includes('MXC_DIAG_PIPE_TOKEN'),
    sdkDiagnosticPipeUsesSidLookup: sdkDiagnosticSource.includes('whoami /user /fo csv /nh'),
    sdkRunUsesInProcessBinding: sdkRunSource.includes('runOneShotJsonAsync('),
    sdkRunOptionsExposeDebug: /\bdebug\??\s*:/u.test(sdkOptions),
    sdkHelperSupportsDebugFlag: nativeHelperSource.includes("args.push('--debug')"),
    sdkHelperSupportsLogFile: nativeHelperSource.includes("args.push('--log-file'"),
  };
}

async function createWindowsFixture(): Promise<WindowsFixture> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error('Windows SystemRoot is unavailable');
  const root = await mkdtemp(join(tmpdir(), 'tracemind-windows-mxc-'));
  const approvedDirectory = join(root, 'approved');
  const temporaryDirectory = join(root, 'temporary');
  await mkdir(approvedDirectory);
  await mkdir(temporaryDirectory);
  return {
    root,
    approvedDirectory,
    temporaryDirectory,
    outsidePath: join(root, 'outside.txt'),
    systemRoot,
  };
}

function createRequest(
  fixture: WindowsFixture,
  args: string[],
  timeoutMs = 10_000
): ContainerRequest {
  return buildWindowsMxcRequest({
    nodeExecutable: process.execPath,
    args,
    approvedProjectRoot: fixture.approvedDirectory,
    workingDirectory: fixture.approvedDirectory,
    runtimeDirectory: dirname(process.execPath),
    systemRoot: fixture.systemRoot,
    temporaryDirectory: fixture.temporaryDirectory,
    timeoutMs,
    environment: {},
  });
}

function describeAttempt(
  stage: string,
  fixture: WindowsFixture,
  request: ContainerRequest,
  capability: Captured<ReturnType<typeof probe>>,
  execution: Captured<Awaited<ReturnType<typeof run>>>,
  host = hostDiagnostics(fixture.systemRoot)
): string {
  const isWhoami = /\bwhoami(?:\.exe)?\b/iu.test(request.command);
  const safeExecution =
    isWhoami && execution.value
      ? {
          ...execution,
          value: {
            ...execution.value,
            stdout: safeOutput('whoami', execution.value.stdout),
            stderr: safeOutput('whoami', execution.value.stderr),
          },
        }
      : execution;
  return serializeDiagnostic(
    {
      stage,
      host,
      request: {
        command: request.command,
        workingDirectory: request.workingDirectory,
        containment: request.containment,
        filesystem: request.filesystem,
        network: request.network,
        timeoutMs: request.timeoutMs,
        inheritDefaultEnvironment: request.inheritDefaultEnvironment,
      },
      capabilityProbe: capability,
      execution: {
        ...safeExecution,
        // MXC SDK v1 reports exitCode/timedOut, but exposes neither the native
        // signal nor a target-created flag. Avoid inferring either from a result.
        signal: 'not-exposed-by-mxc-sdk-v1',
        targetCreated: 'not-exposed-by-mxc-sdk-v1',
      },
    },
    fixture
  );
}

function assertWindowsSessionContext(context: SessionContext | null, diagnostic: string): void {
  expect(context?.error, diagnostic).toBeNull();
  expect(context?.sessionId, diagnostic).toEqual(expect.any(Number));
  expect(context?.windowStationName, diagnostic).not.toBe('');
  expect(typeof context?.windowStationVisible, diagnostic).toBe('boolean');
  expect(context?.tokenSessionId, diagnostic).toEqual(expect.any(Number));
  expect(context?.tokenSessionId, diagnostic).toBe(context?.sessionId);
  expect(context?.tokenType, diagnostic).toEqual(expect.any(Number));
  expect(context?.tokenElevationType, diagnostic).toEqual(expect.any(Number));
  expect(typeof context?.tokenElevated, diagnostic).toBe('boolean');
  expect(context?.tokenIntegrityRid, diagnostic).toEqual(expect.any(Number));
  expect(typeof context?.tokenIsAppContainer, diagnostic).toBe('boolean');
  expect(context?.wtsConnectState, diagnostic).toEqual(expect.any(Number));
  expect(typeof context?.userInteractive, diagnostic).toBe('boolean');
  expect(typeof context?.interactiveSession, diagnostic).toBe('boolean');
}

function captureProbe(request: ContainerRequest): Captured<ReturnType<typeof probe>> {
  try {
    return { value: probe(request), error: null };
  } catch (error) {
    return { value: null, error: errorDetails(error) };
  }
}

async function captureRun(
  request: ContainerRequest
): Promise<Captured<Awaited<ReturnType<typeof run>>>> {
  try {
    return { value: await run(request, { telemetry: { enabled: false } }), error: null };
  } catch (error) {
    return { value: null, error: errorDetails(error) };
  }
}

async function prepareNativeCliRequest(request: ContainerRequest): Promise<{
  wireRequest: unknown;
  wireRequestSha256: string;
}> {
  const root = packageRoot();
  const sdk = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  if (sdk.version !== '1.0.1') {
    throw new Error(
      `Native diagnostic comparison is pinned to MXC SDK 1.0.1; found ${sdk.version}`
    );
  }
  // This is the exact internal adapter called by the public v1 run() implementation in 1.0.1.
  // Pinning and checking the package version prevents a future internal API drift from silently
  // turning the CLI side into a guessed wire request.
  const module = (await import(pathToFileURL(join(root, 'dist', 'v1', 'container.js')).href)) as {
    prepareContainerRequest: PrepareContainerRequest;
  };
  const wireRequest = module.prepareContainerRequest(request, { enabled: false });
  const wireJson = JSON.stringify(wireRequest);
  return {
    wireRequest,
    wireRequestSha256: createHash('sha256').update(wireJson).digest('hex'),
  };
}

function redactFixturePaths(text: string, fixture: WindowsFixture): string {
  const replaceInsensitive = (value: string, replacement: string): void => {
    if (!value) return;
    for (const pathForm of [value, value.replaceAll('\\', '\\\\')]) {
      text = text.replace(
        new RegExp(pathForm.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu'),
        replacement
      );
    }
  };
  replaceInsensitive(process.execPath, '<NODE_ARM64_EXECUTABLE>');
  replaceInsensitive(dirname(process.execPath), '<NODE_RUNTIME_DIRECTORY>');
  replaceInsensitive(fixture.systemRoot, '<WINDOWS_SYSTEM_ROOT>');
  replaceInsensitive(fixture.root, '<RUN_FIXTURE_ROOT>');
  const slash = String.fromCharCode(92);
  const separator = `${slash}${slash}{1,2}`;
  const segment = `[^${slash}${slash}${slash}s"']+`;
  const fixtureRootPattern = new RegExp(
    `[A-Za-z]:${separator}Users${separator}${segment}${separator}AppData${separator}Local${separator}Temp${separator}tracemind-windows-mxc-${segment}`,
    'giu'
  );
  return text.replace(fixtureRootPattern, '<RUN_FIXTURE_ROOT>');
}

function sanitizeDiagnosticValue(value: unknown, fixture: WindowsFixture): unknown {
  if (typeof value === 'string') return redactFixturePaths(value, fixture);
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticValue(item, fixture));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeDiagnosticValue(item, fixture)])
    );
  }
  return value;
}

function serializeDiagnostic(value: unknown, fixture: WindowsFixture): string {
  return JSON.stringify(sanitizeDiagnosticValue(value, fixture));
}

function safeDirectExecution(
  label: string,
  direct: DirectExecution,
  fixture: WindowsFixture
): DirectExecution {
  return {
    ...direct,
    executable: redactFixturePaths(direct.executable, fixture),
    stdout: redactFixturePaths(safeOutput(label, direct.stdout), fixture),
    stderr: redactFixturePaths(safeOutput(label, direct.stderr), fixture),
    error: direct.error
      ? { ...direct.error, message: redactFixturePaths(direct.error.message, fixture) }
      : null,
  };
}

function safeOutput(label: string, output: string): string {
  if (label !== 'whoami' || !output.trim()) return output;
  const value = output.trim();
  return `<redacted whoami output; bytes=${Buffer.byteLength(value)}>`;
}

function safeStream(
  label: string,
  stream: string,
  directOutput: string,
  fixture: WindowsFixture
): string {
  if (label === 'whoami' && stream) {
    return safeOutput(label, stream);
  }
  const safe = safeOutput(label, directOutput);
  const trimmed = directOutput.trim();
  const sanitized = label === 'whoami' && trimmed ? stream.replace(trimmed, safe) : stream;
  return redactFixturePaths(sanitized, fixture);
}

it('redacts Windows temp aliases in raw and JSON-escaped diagnostics', () => {
  const fixture: WindowsFixture = {
    root: String.raw`C:\Users\runneradmin\AppData\Local\Temp\tracemind-windows-mxc-known`,
    approvedDirectory: '',
    temporaryDirectory: '',
    outsidePath: '',
    systemRoot: String.raw`C:\Windows`,
  };
  const requestPath = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\tracemind-windows-mxc-random\approved`;
  const nodePath = process.execPath;
  const encoded = JSON.stringify({ requestPath, systemRoot: fixture.systemRoot, nodePath });
  const sanitized = redactFixturePaths(encoded, fixture);
  const decoded = JSON.parse(sanitized) as Record<string, string>;

  expect(decoded.requestPath).toBe(String.raw`<RUN_FIXTURE_ROOT>\approved`);
  expect(decoded.systemRoot).toBe('<WINDOWS_SYSTEM_ROOT>');
  expect(decoded.nodePath).toBe('<NODE_ARM64_EXECUTABLE>');
  expect(sanitized).not.toMatch(/RUNNER~1|tracemind-windows-mxc-random/iu);
});

it('serializes the deny-mode diagnostic with UI disabled in the SDK request', async () => {
  const prepared = await prepareNativeCliRequest({
    command: String.raw`"C:\TraceMind\runtime\node.exe" -e "process.exit(0)"`,
    containment: { type: 'processcontainer' },
    ui: { disable: true, clipboard: 'none', allowInputInjection: false },
  });

  expect(isRecord(prepared.wireRequest)).toBe(true);
  expect((prepared.wireRequest as Record<string, unknown>).ui).toEqual({
    disable: true,
    clipboard: 'none',
    injection: false,
  });
});

async function runNativeCli(
  fixture: WindowsFixture,
  label: string,
  wireRequest: unknown
): Promise<NativeCliExecution> {
  const root = packageRoot();
  const sdkArch = process.arch === 'arm64' ? 'arm64' : process.arch;
  const executable = join(root, 'bin', sdkArch, 'wxc-exec.exe');
  const logDirectory = join(fixture.root, 'native-diagnostics');
  await mkdir(logDirectory, { recursive: true });
  const logPath = join(logDirectory, `${label}.log`);
  const encodedRequest = Buffer.from(JSON.stringify(wireRequest), 'utf8').toString('base64');
  const childEnvironment = { ...process.env };
  delete childEnvironment.MXC_DIAG_CONSOLE;
  delete childEnvironment.MXC_DIAG_PIPE_TOKEN;
  const startedAt = Date.now();
  const result = spawnSync(
    executable,
    ['--config-base64', encodedRequest, '--debug', '--log-file', logPath],
    {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: childEnvironment,
    }
  );
  const durationMs = Date.now() - startedAt;
  const logPresent = existsSync(logPath);
  const logContents = logPresent ? readFileSync(logPath, 'utf8') : '';
  const normalizedLog = logContents.replace(/\[\d{10}\]/gu, '');
  const diagnosticText = `${result.stdout ?? ''}\n${normalizedLog}`;
  const captureDenialsPointer = parseCaptureDenialsPointer(
    `${result.stderr ?? ''}\n${result.stdout ?? ''}`
  );
  const pidMatch = /process created\s+\(PID:\s*(\d+)\)/iu.exec(diagnosticText);
  const targetExitMatch = /Exit code:\s*(-?\d+)\s+\(0x([0-9a-f]+)\)/iu.exec(diagnosticText);
  const runtimeLifecycleLines = normalizedLog
    .split(/\r?\n/u)
    .filter((line) =>
      /(?:SECTION:|process created\s+\(PID:|Exit code:|Runner completed|launching:|identity:|mxc\.|WARNING:|Error:)/iu.test(
        line
      )
    )
    .slice(0, 80)
    .map((line) => redactFixturePaths(line, fixture));
  const execution: NativeCliExecution = {
    executable: `<MXC_SDK_PACKAGE>/bin/${sdkArch}/wxc-exec.exe`,
    helperPid: result.pid ?? null,
    helperStarted: typeof result.pid === 'number' && result.pid > 0,
    helperExitCode: result.status,
    helperExitHex:
      result.status === null || result.status === undefined
        ? null
        : `0x${(result.status >>> 0).toString(16).padStart(8, '0')}`,
    helperSignal: result.signal,
    timedOut: processErrorCode(result.error ?? undefined) === 'ETIMEDOUT',
    durationMs,
    targetPid: pidMatch ? Number(pidMatch[1]) : null,
    targetPidEvidence: pidMatch ? pidMatch[0] : null,
    targetExitCode: targetExitMatch ? Number(targetExitMatch[1]) : null,
    targetExitHex: targetExitMatch ? `0x${targetExitMatch[2].padStart(8, '0')}` : null,
    targetExitCodeEvidence: targetExitMatch ? targetExitMatch[0] : null,
    captureDenialsPointer: captureDenialsPointer
      ? {
          ...captureDenialsPointer,
          outputPath: redactFixturePaths(captureDenialsPointer.outputPath, fixture),
          etlPath: captureDenialsPointer.etlPath
            ? redactFixturePaths(captureDenialsPointer.etlPath, fixture)
            : null,
        }
      : null,
    stdout: redactFixturePaths(result.stdout ?? '', fixture),
    stderr: redactFixturePaths(result.stderr ?? '', fixture),
    error: result.error
      ? {
          message: redactFixturePaths(result.error.message, fixture),
          code: processErrorCode(result.error),
        }
      : null,
    logPath: redactFixturePaths(logPath, fixture),
    logPresent,
    logSha256: logPresent ? createHash('sha256').update(logContents).digest('hex') : null,
    runtimeLifecycleLines,
    mxcAuditEvents: parseMxcAuditEvents(logContents),
    effectiveConfig: nativeConfigSummary(result.stdout ?? '', fixture),
  };
  Object.defineProperty(execution, 'rawCaptureDenialsPointer', {
    value: captureDenialsPointer,
    enumerable: false,
  });
  return execution;
}

interface FileEvidence {
  exists: boolean;
  sizeBytes: number | null;
  sha256: string | null;
}

async function fingerprintFile(path: string | null): Promise<FileEvidence> {
  if (!path) return { exists: false, sizeBytes: null, sha256: null };
  try {
    const metadata = await stat(path);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return { exists: true, sizeBytes: metadata.size, sha256: hash.digest('hex') };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return { exists: false, sizeBytes: null, sha256: null };
    throw error;
  }
}

async function readJsonFile(path: string | null): Promise<unknown | null> {
  if (!path || !existsSync(path)) return null;
  const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/u, '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function analyzeCapturedDenials(
  actionableValue: unknown,
  verboseValue: unknown,
  targetPid: number | null
) {
  const actionable = isRecord(actionableValue) ? actionableValue : null;
  const denials = actionable && Array.isArray(actionable.denials) ? actionable.denials : [];
  const verbose = isRecord(verboseValue) ? verboseValue : null;
  const signatures = verbose && Array.isArray(verbose.signatures) ? verbose.signatures : [];
  const counts: Record<'file' | 'ui' | 'network' | 'capability' | 'other' | 'unknown', number> = {
    file: 0,
    ui: 0,
    network: 0,
    capability: 0,
    other: 0,
    unknown: 0,
  };
  let targetPidActionableDenials = 0;
  for (const denial of denials) {
    if (!isRecord(denial)) {
      counts.unknown++;
      continue;
    }
    const resourceType = denial.resourceType;
    if (
      typeof resourceType === 'string' &&
      Object.prototype.hasOwnProperty.call(counts, resourceType)
    ) {
      counts[resourceType as keyof typeof counts]++;
    } else {
      counts.unknown++;
    }
    if (targetPid !== null && denial.pid === targetPid) targetPidActionableDenials++;
  }
  let targetPidVerboseSignatures = 0;
  let verboseDiagnosticOutcomes = 0;
  for (const item of signatures) {
    if (!isRecord(item) || !isRecord(item.signature)) continue;
    if (targetPid !== null && item.signature.pid === targetPid) targetPidVerboseSignatures++;
    if (item.signature.reason !== 'actionable') verboseDiagnosticOutcomes++;
  }
  const inspectedText = JSON.stringify({ denials, signatures }).toLowerCase();
  const summary = actionable && isRecord(actionable.summary) ? actionable.summary : null;
  return {
    actionableDenialCount: denials.length,
    actionableSummary: summary
      ? {
          exitCode: typeof summary.exitCode === 'number' ? summary.exitCode : null,
          totalDenials: typeof summary.totalDenials === 'number' ? summary.totalDenials : null,
          deniedResourcesTruncated:
            typeof summary.deniedResourcesTruncated === 'boolean'
              ? summary.deniedResourcesTruncated
              : null,
        }
      : null,
    resourceTypeCounts: counts,
    targetPidActionableDenials,
    verboseSignatureCount: signatures.length,
    targetPidVerboseSignatures,
    verboseDiagnosticOutcomes,
    operationIndicators: {
      win32kSystemCallName: /win32k|ntuser[a-z]/u.test(inspectedText),
      windowStationOrDesktop: /window.?station|winsta0|desktop/u.test(inspectedText),
      user32Initialization: /user32/u.test(inspectedText),
      processTokenOrSecurityEnvironment:
        /process.?token|security.?environment|token.?restriction/u.test(inspectedText),
      filesystemResource: denials.some(
        (denial) => isRecord(denial) && denial.resourceType === 'file'
      ),
      otherKernelAccessCheck: verboseDiagnosticOutcomes > 0 || counts.other > 0 || counts.ui > 0,
    },
  };
}

async function copyEvidenceIfPresent(source: string | null, directory: string, name: string) {
  if (!source || !existsSync(source)) return false;
  await copyFile(source, join(directory, name));
  return true;
}

function requestPolicySummary(wireRequest: unknown, fixture: WindowsFixture) {
  if (!isRecord(wireRequest)) return null;
  return sanitizeDiagnosticValue(wireRequest, fixture);
}

interface LaunchComparisonCase {
  label: 'cmd' | 'where' | 'whoami' | 'node-version';
  executable: string;
  args: string[];
  directArgs: string[];
  expectedText: string;
}

function createLaunchComparisonCases(fixture: WindowsFixture): LaunchComparisonCase[] {
  return [
    {
      label: 'cmd',
      executable: join(fixture.systemRoot, 'System32', 'cmd.exe'),
      args: [],
      directArgs: ['/d', '/c', 'echo', 'MXC_OK'],
      expectedText: 'MXC_OK',
    },
    {
      label: 'where',
      executable: join(fixture.systemRoot, 'System32', 'where.exe'),
      args: ['cmd.exe'],
      directArgs: ['cmd.exe'],
      expectedText: 'cmd.exe',
    },
    {
      label: 'whoami',
      executable: join(fixture.systemRoot, 'System32', 'whoami.exe'),
      args: [],
      directArgs: [],
      expectedText: '',
    },
    {
      label: 'node-version',
      executable: process.execPath,
      args: ['--version'],
      directArgs: ['--version'],
      expectedText: process.version,
    },
  ];
}

for (const comparisonCase of createLaunchComparisonCases({
  root: '',
  approvedDirectory: '',
  temporaryDirectory: '',
  outsidePath: '',
  systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
})) {
  it.skipIf(process.platform !== 'win32')(
    `compares exact MXC SDK 1.0.1 run() and native wxc-exec diagnostics for ${comparisonCase.label}`,
    async () => {
      const fixture = await createWindowsFixture();
      try {
        const request = createRequest(fixture, comparisonCase.args);
        request.containerName = randomBytes(16).toString('hex');
        if (comparisonCase.label === 'cmd') {
          request.command = `"${comparisonCase.executable}" /d /c echo MXC_OK`;
        } else {
          request.command = quoteWindowsArgv([comparisonCase.executable, ...comparisonCase.args]);
        }
        const telemetry = { enabled: false } as const;
        const prepared = await prepareNativeCliRequest(request);
        const capability = captureProbe(request);
        const sdkExecution = await captureRun(request);
        const nativeExecution = await runNativeCli(
          fixture,
          comparisonCase.label,
          prepared.wireRequest
        );
        const direct = runDirect(comparisonCase.executable, comparisonCase.directArgs);
        const host = hostDiagnostics(fixture.systemRoot);
        const sdkResult = sdkExecution.value;
        const targetOutputStart = nativeExecution.stdout.search(
          /process created\s+\(PID:\s*\d+\)/iu
        );
        const runnerCompletedAt = nativeExecution.stdout.indexOf(
          'Runner completed',
          targetOutputStart
        );
        const nativeTargetOutput =
          targetOutputStart >= 0 && runnerCompletedAt > targetOutputStart
            ? nativeExecution.stdout
                .slice(
                  nativeExecution.stdout.indexOf('\n', targetOutputStart) + 1,
                  runnerCompletedAt
                )
                .split(/\r?\n/u)
                .filter(
                  (line) =>
                    line.trim() &&
                    !/^\s*(?:Error:|▶|\[network_proxy:|selected isolation tier:|working directory:|STDIO mode:|launching:|identity:|process security environment|mxc\.)/iu.test(
                      line
                    )
                )
                .join('\n')
            : '';
        const comparison = {
          expectedTextPresentInDirectHost: comparisonCase.expectedText
            ? direct.stdout.includes(comparisonCase.expectedText)
            : direct.stdout.trim().length > 0,
          sdkExitCode: sdkResult?.exitCode ?? null,
          sdkExitCodeUnsigned:
            typeof sdkResult?.exitCode === 'number' ? sdkResult.exitCode >>> 0 : null,
          sdkTimedOut: sdkResult?.timedOut ?? null,
          nativeHelperExitCode: nativeExecution.helperExitCode,
          nativeHelperExitCodeUnsigned:
            typeof nativeExecution.helperExitCode === 'number'
              ? nativeExecution.helperExitCode >>> 0
              : null,
          nativeHelperExitHex: nativeExecution.helperExitHex,
          sdkAndNativeExitCodesMatch:
            typeof sdkResult?.exitCode === 'number' &&
            typeof nativeExecution.helperExitCode === 'number' &&
            sdkResult.exitCode >>> 0 === nativeExecution.helperExitCode >>> 0,
          targetPidObserved: nativeExecution.targetPid !== null,
          targetExitCode: nativeExecution.targetExitCode,
          targetExitHex: nativeExecution.targetExitHex,
          targetOutputPresentInSdk:
            comparisonCase.label === 'whoami'
              ? Boolean(sdkResult?.stdout.trim())
              : (sdkResult?.stdout.includes(comparisonCase.expectedText) ?? false),
          targetOutputPresentInNativeCli:
            nativeExecution.targetPid !== null &&
            (comparisonCase.label === 'whoami'
              ? Boolean(nativeTargetOutput.trim())
              : nativeTargetOutput.includes(comparisonCase.expectedText)),
          nativeTargetOutputBytes: Buffer.byteLength(nativeTargetOutput),
          nativeTargetOutputSha256:
            comparisonCase.label !== 'whoami' && nativeTargetOutput
              ? createHash('sha256').update(nativeTargetOutput).digest('hex')
              : null,
          directTargetOutputSha256:
            comparisonCase.label !== 'whoami' && direct.stdout.trim()
              ? createHash('sha256').update(direct.stdout.trim()).digest('hex')
              : null,
        };
        const wireRequestSanitized = sanitizeDiagnosticValue(prepared.wireRequest, fixture);
        console.info(
          `TRACEMIND_WINDOWS_NATIVE_COMPARISON=${serializeDiagnostic(
            {
              label: comparisonCase.label,
              sdkVersion: host.sdkVersion,
              executionPaths: {
                typescriptSdk: 'public v1 run(); in-process mxc_ffi.dll; no wxc-exec child process',
                nativeCli:
                  'version-matched bin/<arch>/wxc-exec.exe --config-base64 --debug --log-file',
              },
              host: {
                ...host,
                executorPath: redactFixturePaths(host.executorPath, fixture),
                ffiPath: redactFixturePaths(host.ffiPath, fixture),
                diagnosticConsolePath: redactFixturePaths(host.diagnosticConsolePath, fixture),
              },
              capabilityProbe: capability,
              highLevelRequest: sanitizeDiagnosticValue(request, fixture),
              wireRequest: wireRequestSanitized,
              wireRequestSha256: prepared.wireRequestSha256,
              telemetryOptions: telemetry,
              sdkExecution: {
                ...sdkExecution,
                value: sdkResult
                  ? {
                      ...sdkResult,
                      stdout: safeStream(
                        comparisonCase.label,
                        sdkResult.stdout,
                        direct.stdout,
                        fixture
                      ),
                      stderr: safeStream(
                        comparisonCase.label,
                        sdkResult.stderr,
                        direct.stdout,
                        fixture
                      ),
                    }
                  : null,
                // SDK v1 run() uses in-process FFI and exposes no target PID or signal.
                nativeHelperStarted: false,
                targetPid: 'not-exposed-by-sdk-v1-run',
                signal: 'not-exposed-by-sdk-v1-run',
              },
              nativeCliExecution: {
                ...nativeExecution,
                stdout: safeStream(
                  comparisonCase.label,
                  nativeExecution.stdout,
                  direct.stdout,
                  fixture
                ),
                stderr: safeStream(
                  comparisonCase.label,
                  nativeExecution.stderr,
                  direct.stdout,
                  fixture
                ),
              },
              directHostControl: {
                ...safeDirectExecution(comparisonCase.label, direct, fixture),
              },
              comparison,
              diagnosticInterface: {
                sdkRunUsesInProcessBinding: host.sdkRunUsesInProcessBinding,
                sdkRunOptionsExposeDebug: host.sdkRunOptionsExposeDebug,
                sdkDiagnosticPipeReadsToken: host.sdkDiagnosticPipeReadsToken,
                sdkDiagnosticPipeUsesSidLookup: host.sdkDiagnosticPipeUsesSidLookup,
                nativeHelperSupportsDebugFlag: host.sdkHelperSupportsDebugFlag,
                nativeHelperSupportsLogFile: host.sdkHelperSupportsLogFile,
                diagnosticConsolePresent: host.diagnosticConsolePresent,
                diagnosticConsolePeMachine: host.diagnosticConsolePeMachine,
                callerTokenElevated: host.sessionContext?.tokenElevated ?? null,
                etwCapture:
                  'not started in the controlled equivalence pair; console ETW requires elevation',
              },
            },
            fixture
          )}`
        );

        expect(prepared.wireRequestSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(host.sdkVersion).toBe('1.0.1');
        expect(host.executorPresent).toBe(true);
        expect(host.executorPeMachine).toBe(process.arch === 'arm64' ? 'ARM64' : 'AMD64');
        expect(host.diagnosticConsolePresent).toBe(true);
        expect(host.diagnosticConsolePeMachine).toBe(process.arch === 'arm64' ? 'ARM64' : 'AMD64');
        expect(host.sdkRunUsesInProcessBinding).toBe(true);
        expect(host.sdkRunOptionsExposeDebug).toBe(false);
        expect(host.sdkDiagnosticPipeReadsToken).toBe(false);
        expect(host.sdkDiagnosticPipeUsesSidLookup).toBe(true);
        expect(host.sdkHelperSupportsDebugFlag).toBe(true);
        expect(host.sdkHelperSupportsLogFile).toBe(true);
        expect(nativeExecution.helperStarted).toBe(true);
        expect(nativeExecution.error).toBeNull();
        expect(nativeExecution.timedOut).toBe(false);
        expect(nativeExecution.helperExitCode).toBe(0);
        expect(nativeExecution.logPresent).toBe(true);
        expect(sdkExecution.error).toBeNull();
        expect(sdkResult?.timedOut).toBe(false);
        expect(sdkResult?.exitCode).toBe(0);
        expect(direct.processStarted).toBe(true);
        expect(direct.status).toBe(0);
        expect(comparison.targetOutputPresentInNativeCli).toBe(true);
        assertWindowsSessionContext(
          host.sessionContext,
          JSON.stringify({ label: comparisonCase.label, host })
        );
        expect(nativeExecution.targetPid).not.toBeNull();
        expect(nativeExecution.targetExitCode).not.toBeNull();
        if (comparisonCase.label === 'whoami') {
          expect(direct.stdout.trim()).not.toBe('');
          expect(sdkResult?.stdout.trim()).not.toBe('');
          expect(nativeTargetOutput.trim()).not.toBe('');
        } else {
          expect(direct.stdout).toContain(comparisonCase.expectedText);
          expect(sdkResult?.stdout).toContain(comparisonCase.expectedText);
          expect(nativeTargetOutput).toContain(comparisonCase.expectedText);
        }
        expect(host.sessionContext?.tokenSessionId).toBe(host.sessionContext?.sessionId);
        expect(host.sessionContext?.interactiveSession).not.toBeNull();
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    60_000
  );
}

it.skipIf(process.platform !== 'win32')(
  'reports Windows build, MXC native helper architecture, version, and ProcessContainer capabilities',
  async () => {
    const fixture = await createWindowsFixture();
    try {
      const request = createRequest(fixture, ['-e', 'process.exit(0)']);
      const capability = captureProbe(request);
      const host = hostDiagnostics(fixture.systemRoot);
      const diagnostic = serializeDiagnostic(
        { host, capabilityProbe: capability, request },
        fixture
      );
      console.info(`TRACEMIND_WINDOWS_RUNTIME=${diagnostic}`);
      expect(capability.error, diagnostic).toBeNull();
      expect(capability.value, diagnostic).not.toBeNull();
      expect(host.executorPresent, diagnostic).toBe(true);
      expect(host.ffiPresent, diagnostic).toBe(true);
      expect(host.executorPeMachine, diagnostic).toBe(process.arch === 'arm64' ? 'ARM64' : 'AMD64');
      expect(host.ffiPeMachine, diagnostic).toBe(process.arch === 'arm64' ? 'ARM64' : 'AMD64');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'win32')(
  'launches a known System32 executable through MXC ProcessContainer',
  async () => {
    const fixture = await createWindowsFixture();
    try {
      const executable = join(fixture.systemRoot, 'System32', 'where.exe');
      const request = createRequest(fixture, []);
      request.command = quoteWindowsArgv([executable, 'cmd.exe']);
      const direct = runDirect(executable, ['cmd.exe']);
      const capability = captureProbe(request);
      const execution = await captureRun(request);
      const host = hostDiagnostics(fixture.systemRoot);
      const diagnostic = describeAttempt(
        'system-executable-launch',
        fixture,
        request,
        capability,
        execution,
        host
      );
      console.info(
        `TRACEMIND_WINDOWS_DIAGNOSTIC=${serializeDiagnostic(
          {
            ...JSON.parse(diagnostic),
            directHostControl: safeDirectExecution('where', direct, fixture),
          },
          fixture
        )}`
      );
      assertWindowsSessionContext(host.sessionContext, diagnostic);
      expect(direct.error, diagnostic).toBeNull();
      expect(direct.processStarted, diagnostic).toBe(true);
      expect(direct.status, diagnostic).toBe(0);
      expect(direct.stdout.toLowerCase(), diagnostic).toContain('cmd.exe');
      expect(execution.error, diagnostic).toBeNull();
      expect(execution.value?.timedOut, diagnostic).toBe(false);
      expect(execution.value?.exitCode, diagnostic).toBe(0);
      expect(execution.value?.stdout.toLowerCase(), diagnostic).toContain('cmd.exe');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'win32')(
  'launches the non-USER32 cmd.exe control through MXC ProcessContainer',
  async () => {
    const fixture = await createWindowsFixture();
    try {
      const executable = join(fixture.systemRoot, 'System32', 'cmd.exe');
      const request = createRequest(fixture, []);
      // cmd.exe parses the raw text after /c itself; argv-style quoting would
      // pass a literal quote into the command string and confound the probe.
      request.command = `"${executable}" /d /c echo MXC_OK`;
      const direct = runDirect(executable, ['/d', '/c', 'echo', 'MXC_OK']);
      const capability = captureProbe(request);
      const execution = await captureRun(request);
      const host = hostDiagnostics(fixture.systemRoot);
      const diagnostic = serializeDiagnostic(
        {
          ...JSON.parse(
            describeAttempt('cmd-executable-launch', fixture, request, capability, execution, host)
          ),
          directHostControl: safeDirectExecution('cmd', direct, fixture),
        },
        fixture
      );
      console.info(`TRACEMIND_WINDOWS_DIAGNOSTIC=${diagnostic}`);
      assertWindowsSessionContext(host.sessionContext, diagnostic);
      expect(direct.processStarted, diagnostic).toBe(true);
      expect(direct.status, diagnostic).toBe(0);
      expect(direct.stdout, diagnostic).toContain('MXC_OK');
      expect(execution.error, diagnostic).toBeNull();
      expect(execution.value?.timedOut, diagnostic).toBe(false);
      expect(execution.value?.exitCode, diagnostic).toBe(0);
      expect(execution.value?.stdout, diagnostic).toContain('MXC_OK');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'win32')(
  'compares direct and ProcessContainer whoami startup in the recorded Windows session',
  async () => {
    const fixture = await createWindowsFixture();
    try {
      const executable = join(fixture.systemRoot, 'System32', 'whoami.exe');
      const direct = runDirect(executable, []);
      const request = createRequest(fixture, []);
      request.command = quoteWindowsArgv([executable]);
      const capability = captureProbe(request);
      const execution = await captureRun(request);
      const host = hostDiagnostics(fixture.systemRoot);
      const diagnostic = serializeDiagnostic(
        {
          ...JSON.parse(
            describeAttempt(
              'whoami-user32-session-control',
              fixture,
              request,
              capability,
              execution,
              host
            )
          ),
          directHostControl: safeDirectExecution('whoami', direct, fixture),
        },
        fixture
      );
      console.info(`TRACEMIND_WINDOWS_DIAGNOSTIC=${diagnostic}`);
      assertWindowsSessionContext(host.sessionContext, diagnostic);
      expect(direct.error, diagnostic).toBeNull();
      expect(direct.processStarted, diagnostic).toBe(true);
      expect(direct.status, diagnostic).toBe(0);
      expect(direct.stdout.trim(), diagnostic).not.toBe('');
      expect(execution.error, diagnostic).toBeNull();
      expect(execution.value?.timedOut, diagnostic).toBe(false);
      expect(execution.value?.exitCode, diagnostic).toBe(0);
      expect(execution.value?.stdout.trim(), diagnostic).not.toBe('');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'win32')(
  'compares direct and ProcessContainer execution of actual ARM64 Node --version',
  async () => {
    const fixture = await createWindowsFixture();
    try {
      const direct = runDirect(process.execPath, ['--version']);
      const request = createRequest(fixture, ['--version']);
      const capability = captureProbe(request);
      const execution = await captureRun(request);
      const host = hostDiagnostics(fixture.systemRoot);
      const diagnostic = serializeDiagnostic(
        {
          ...JSON.parse(
            describeAttempt(
              'node-version-session-control',
              fixture,
              request,
              capability,
              execution,
              host
            )
          ),
          directHostControl: safeDirectExecution('node-version', direct, fixture),
        },
        fixture
      );
      console.info(`TRACEMIND_WINDOWS_DIAGNOSTIC=${diagnostic}`);
      assertWindowsSessionContext(host.sessionContext, diagnostic);
      expect(process.arch, diagnostic).toBe('arm64');
      expect(direct.error, diagnostic).toBeNull();
      expect(direct.processStarted, diagnostic).toBe(true);
      expect(direct.status, diagnostic).toBe(0);
      expect(direct.stdout.trim(), diagnostic).toMatch(/^v\d/);
      expect(execution.error, diagnostic).toBeNull();
      expect(execution.value?.timedOut, diagnostic).toBe(false);
      expect(execution.value?.exitCode, diagnostic).toBe(0);
      expect(execution.value?.stdout.trim(), diagnostic).toBe(direct.stdout.trim());
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'win32')(
  'launches ARM64 Node through MXC and captures target output and nonzero exit status',
  async () => {
    const fixture = await createWindowsFixture();
    try {
      const request = createRequest(fixture, [
        '-e',
        "process.stdout.write(process.arch + ':stdout');process.stderr.write(':stderr');process.exit(23)",
      ]);
      const capability = captureProbe(request);
      const execution = await captureRun(request);
      const diagnostic = describeAttempt(
        'node-status-output',
        fixture,
        request,
        capability,
        execution
      );
      expect(execution.error, diagnostic).toBeNull();
      expect(execution.value?.timedOut, diagnostic).toBe(false);
      expect(execution.value?.exitCode, diagnostic).toBe(23);
      expect(execution.value?.stdout, diagnostic).toBe('arm64:stdout');
      expect(execution.value?.stderr, diagnostic).toBe(':stderr');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'win32')(
  'allows a target write inside the approved project directory',
  async () => {
    const fixture = await createWindowsFixture();
    try {
      const request = createRequest(fixture, [
        '-e',
        "require('node:fs').writeFileSync('allowed.txt','allowed');process.stdout.write('write-complete')",
      ]);
      const capability = captureProbe(request);
      const execution = await captureRun(request);
      const diagnostic = describeAttempt(
        'approved-project-write',
        fixture,
        request,
        capability,
        execution
      );
      expect(execution.error, diagnostic).toBeNull();
      expect(execution.value?.exitCode, diagnostic).toBe(0);
      expect(execution.value?.stdout).toBe('write-complete');
      expect(
        await readFile(join(fixture.approvedDirectory, 'allowed.txt'), 'utf8'),
        diagnostic
      ).toBe('allowed');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'win32')(
  'denies a target write outside the approved project and run temporary directory',
  async () => {
    const fixture = await createWindowsFixture();
    try {
      const request = createRequest(fixture, [
        '-e',
        `let denied=false;try{require('node:fs').writeFileSync(${JSON.stringify(fixture.outsidePath)},'escaped')}catch(e){denied=['EACCES','EPERM'].includes(e.code)};process.stdout.write(JSON.stringify({denied}))`,
      ]);
      const capability = captureProbe(request);
      const execution = await captureRun(request);
      const diagnostic = describeAttempt(
        'outside-project-write',
        fixture,
        request,
        capability,
        execution
      );
      expect(execution.error, diagnostic).toBeNull();
      expect(execution.value?.exitCode, diagnostic).toBe(0);
      expect(execution.value?.stdout, diagnostic).toBe('{"denied":true}');
      await expect(readFile(fixture.outsidePath, 'utf8'), diagnostic).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'win32')(
  'denies target connections to a host-loopback listener',
  async () => {
    const fixture = await createWindowsFixture();
    const server = createServer((socket) => {
      socket.end('host-loopback-reached');
    });
    let hostConnections = 0;
    server.on('connection', () => hostConnections++);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Loopback fixture unavailable');
      const program = [
        "const net=require('node:net');let finished=false;",
        'const finish=(connected)=>{if(finished)return;finished=true;console.log(JSON.stringify({connected}));socket.destroy()};',
        `const socket=net.connect({host:'127.0.0.1',port:${address.port}});`,
        "socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));",
        'setTimeout(()=>finish(false),1500).unref();',
      ].join('');
      const request = createRequest(fixture, ['-e', program]);
      const capability = captureProbe(request);
      const execution = await captureRun(request);
      const diagnostic = serializeDiagnostic(
        {
          ...JSON.parse(
            describeAttempt('host-loopback-denial', fixture, request, capability, execution)
          ),
          hostConnections,
        },
        fixture
      );
      expect(execution.error, diagnostic).toBeNull();
      expect(execution.value?.exitCode, diagnostic).toBe(0);
      expect(execution.value?.stdout.trim(), diagnostic).toBe('{"connected":false}');
      expect(hostConnections, diagnostic).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'win32')(
  'reports timeout separately from target completion',
  async () => {
    const fixture = await createWindowsFixture();
    try {
      const request = createRequest(fixture, ['-e', 'setInterval(() => {}, 1000)'], 300);
      const capability = captureProbe(request);
      const execution = await captureRun(request);
      const diagnostic = describeAttempt('target-timeout', fixture, request, capability, execution);
      expect(execution.error, diagnostic).toBeNull();
      expect(execution.value?.timedOut, diagnostic).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
  15_000
);

it.skipIf(process.platform !== 'win32')(
  'captures one failing where.exe target with deny-mode OS trace',
  async () => {
    const fixture = await createWindowsFixture();
    try {
      const diagnosticDirectory = join(fixture.root, 'native-diagnostics');
      await mkdir(diagnosticDirectory, { recursive: true });
      const outputPath = join(
        diagnosticDirectory,
        `where-denials-${randomBytes(12).toString('hex')}.json`
      );
      expect(isAbsolute(outputPath)).toBe(true);
      expect(isWithinPath(fixture.approvedDirectory, outputPath)).toBe(false);
      expect(isWithinPath(fixture.temporaryDirectory, outputPath)).toBe(false);

      const executable = join(fixture.systemRoot, 'System32', 'where.exe');
      const request = createRequest(fixture, []);
      request.command = quoteWindowsArgv([executable, 'cmd.exe']);
      request.ui = { disable: true, clipboard: 'none', allowInputInjection: false };
      const baselinePrepared = await prepareNativeCliRequest(request);
      request.containment = {
        type: 'processcontainer',
        config: {
          captureDenials: {
            mode: 'block',
            outputPath,
            retainEtl: true,
          },
        },
      };
      request.containerName = randomBytes(16).toString('hex');
      const prepared = await prepareNativeCliRequest(request);
      const wireRequest = prepared.wireRequest;
      const wireRecord = isRecord(wireRequest) ? wireRequest : null;
      const processContainer =
        wireRecord && isRecord(wireRecord.processContainer) ? wireRecord.processContainer : null;
      const captureConfig =
        processContainer && isRecord(processContainer.captureDenials)
          ? processContainer.captureDenials
          : null;

      // The version-matched SDK adapter constructs every wire field; this diagnostic only adds
      // the supported 1.0.0 captureDenials field to the existing ProcessContainer request.
      expect(captureConfig).toEqual({ mode: 'block', outputPath, retainEtl: true });
      expect(wireRecord?.filesystem).toEqual(
        isRecord(baselinePrepared.wireRequest) ? baselinePrepared.wireRequest.filesystem : null
      );
      expect(wireRecord?.network).toEqual(
        isRecord(baselinePrepared.wireRequest) ? baselinePrepared.wireRequest.network : null
      );
      expect(wireRecord?.process).toEqual(
        isRecord(baselinePrepared.wireRequest) ? baselinePrepared.wireRequest.process : null
      );
      expect(wireRecord?.ui).toEqual(
        isRecord(baselinePrepared.wireRequest) ? baselinePrepared.wireRequest.ui : null
      );
      expect(wireRecord?.ui).toEqual({ disable: true, clipboard: 'none', injection: false });
      expect(wireRecord?.telemetry).toEqual({ enabled: false });

      // Exactly one target invocation: wxc-exec.exe receives the SDK 1.0.1 adapter output.
      const nativeExecution = await runNativeCli(fixture, 'where-deny-mode', wireRequest);
      const pointer = nativeExecution.rawCaptureDenialsPointer ?? null;
      const actionablePath = pointer?.outputPath || null;
      const verbosePath = actionablePath?.replace(/\.json$/iu, '.verbose.json') ?? null;
      const etlPath = pointer?.etlPath ?? null;
      const actionableEvidence = await fingerprintFile(actionablePath);
      const verboseEvidence = await fingerprintFile(verbosePath);
      const etlEvidence = await fingerprintFile(etlPath);
      const actionableJson = await readJsonFile(actionablePath);
      const verboseJson = await readJsonFile(verbosePath);
      const denialAnalysis = analyzeCapturedDenials(
        actionableJson,
        verboseJson,
        nativeExecution.targetPid
      );
      const host = hostDiagnostics(fixture.systemRoot);
      const policyHashEvent =
        nativeExecution.mxcAuditEvents.find((event) => event.event === 'mxc.PolicyHash') ?? null;
      const networkPolicyEvent =
        nativeExecution.mxcAuditEvents.find(
          (event) => event.event === 'mxc.NetworkPolicyApplied'
        ) ?? null;
      const teardownEvent =
        nativeExecution.mxcAuditEvents.find((event) => event.event === 'mxc.SandboxTornDown') ??
        null;
      const report = {
        stage: 'single-where-exe-deny-mode-capture',
        host: {
          platform: host.platform,
          processArch: host.processArch,
          osArch: host.osArch,
          osRelease: host.osRelease,
          osVersion: host.osVersion,
          windowsUpdateRevision: host.windowsUpdateRevision,
          sdkVersion: host.sdkVersion,
          executorPeMachine: host.executorPeMachine,
          sessionContext: host.sessionContext,
        },
        capabilityProbe: sanitizeDiagnosticValue(captureProbe(request), fixture),
        request: {
          wireRequestSha256: prepared.wireRequestSha256,
          exactNativeArguments: [
            '--config-base64',
            '<SDK_1.0.1_WIRE_REQUEST>',
            '--debug',
            '--log-file',
            '<RUN_FIXTURE_ROOT>\\native-diagnostics\\where-deny-mode.log',
          ],
          policy: requestPolicySummary(wireRequest, fixture),
          outputDirectoryOutsideTargetWritableRoots:
            !isWithinPath(fixture.approvedDirectory, diagnosticDirectory) &&
            !isWithinPath(fixture.temporaryDirectory, diagnosticDirectory),
          uiDisableAsReceivedByMxC: nativeExecution.effectiveConfig?.uiDisable ?? null,
          captureDenialsAsReceivedByMxC: nativeExecution.effectiveConfig?.captureDenials ?? null,
          auditFlagUsed: false,
          requestedCapture: {
            mode: 'block',
            retainEtl: true,
            outputPath: redactFixturePaths(outputPath, fixture),
          },
        },
        native: {
          helperPid: nativeExecution.helperPid,
          helperStarted: nativeExecution.helperStarted,
          helperExitCode: nativeExecution.helperExitCode,
          helperExitHex: nativeExecution.helperExitHex,
          helperSignal: nativeExecution.helperSignal,
          timedOut: nativeExecution.timedOut,
          targetPid: nativeExecution.targetPid,
          targetExitCode: nativeExecution.targetExitCode,
          targetExitHex: nativeExecution.targetExitHex,
          nativeError: nativeExecution.error,
          runtimeLifecycleLines: nativeExecution.runtimeLifecycleLines,
          sandboxIdentityEvidence:
            nativeExecution.runtimeLifecycleLines.find((line) => /identity:/iu.test(line)) ?? null,
          policyHash: policyHashEvent?.policy_hash ?? null,
          policyHashEvent,
          networkPolicyEvent,
          teardownEvent,
        },
        capture: {
          pointer: nativeExecution.captureDenialsPointer,
          actionableJson: {
            path: actionablePath ? redactFixturePaths(actionablePath, fixture) : null,
            ...actionableEvidence,
          },
          verboseJson: {
            path: verbosePath ? redactFixturePaths(verbosePath, fixture) : null,
            ...verboseEvidence,
          },
          retainedEtl: {
            path: etlPath ? redactFixturePaths(etlPath, fixture) : null,
            ...etlEvidence,
          },
          analysis: denialAnalysis,
        },
        interpretation: {
          captureScope:
            'MXC 1.0.1 Learning Mode capture reports its supported access/network denial event classes; it is not a general Win32k syscall or call-stack trace.',
          networkPolicy:
            networkPolicyEvent?.enforcement_mode === 'capabilities'
              ? 'BaseContainer capability policy is carried in the sandbox spec and OS-enforced; zero firewall rules and firewall_applied=false are expected for this mode. This where.exe target does not independently exercise networking.'
              : 'No BaseContainer capability-mode network event was observed in the native log.',
        },
      };

      const artifactDirectoryValue = process.env.TRACEMIND_CAPTURE_ARTIFACT_DIR;
      if (artifactDirectoryValue) {
        const artifactDirectory = resolve(artifactDirectoryValue);
        expect(isWithinPath(fixture.root, artifactDirectory)).toBe(false);
        await mkdir(artifactDirectory, { recursive: true });
        await copyEvidenceIfPresent(actionablePath, artifactDirectory, 'denials.json');
        await copyEvidenceIfPresent(verbosePath, artifactDirectory, 'denials.verbose.json');
        await copyEvidenceIfPresent(etlPath, artifactDirectory, 'trace.etl');
        await writeFile(
          join(artifactDirectory, 'mxc-lifecycle.txt'),
          nativeExecution.runtimeLifecycleLines.join('\n') + '\n',
          'utf8'
        );
        await writeFile(
          join(artifactDirectory, 'capture-report.json'),
          JSON.stringify(report, null, 2) + '\n',
          'utf8'
        );
      }

      console.info(`TRACEMIND_WINDOWS_DENY_CAPTURE=${JSON.stringify(report)}`);
      assertWindowsSessionContext(host.sessionContext, JSON.stringify(report));
      expect(nativeExecution.helperStarted, JSON.stringify(report)).toBe(true);
      expect(nativeExecution.timedOut, JSON.stringify(report)).toBe(false);
      expect(nativeExecution.targetPid, JSON.stringify(report)).not.toBeNull();
      expect(nativeExecution.targetExitCode, JSON.stringify(report)).not.toBeNull();
      expect(nativeExecution.effectiveConfig?.uiDisable, JSON.stringify(report)).toBe(true);
      expect(nativeExecution.effectiveConfig?.captureDenials, JSON.stringify(report)).toEqual({
        mode: 'block',
        outputPath: redactFixturePaths(outputPath, fixture),
        retainEtl: true,
      });
      expect(nativeExecution.captureDenialsPointer, JSON.stringify(report)).not.toBeNull();
      expect(pointer?.outputPath, JSON.stringify(report)).not.toBe('');
      expect(pointer?.etlPath, JSON.stringify(report)).not.toBeNull();
      expect(pointer?.totalDenials, JSON.stringify(report)).toEqual(expect.any(Number));
      expect(pointer?.deniedResourcesTruncated, JSON.stringify(report)).toEqual(
        expect.any(Boolean)
      );
      expect(actionableEvidence.exists, JSON.stringify(report)).toBe(true);
      expect(verboseEvidence.exists, JSON.stringify(report)).toBe(true);
      expect(etlEvidence.exists, JSON.stringify(report)).toBe(true);
      expect(actionableJson, JSON.stringify(report)).not.toBeNull();
      expect(verboseJson, JSON.stringify(report)).not.toBeNull();
      expect(teardownEvent?.status, JSON.stringify(report)).toBe('success');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
  60_000
);
