import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fault} from '../extension/protocol.js';
import {readConfig, setArtifactsDir} from './local.mjs';
import {describeLibraryRoot} from './platform.mjs';
import {boundRun, listRuns, runPattern} from './exploration-storage.mjs';
import {startLibraryServer} from './exploration-library.mjs';

const execFileAsync = promisify(execFile);
const short = (value, n = 160) => String(value || '').slice(0, n);

async function existingDir(dir) {
  if (!dir) return null;
  try {
    if ((await fs.stat(dir)).isDirectory()) return dir;
  } catch {}
  const parent = path.dirname(dir);
  if (parent && parent !== dir) {
    try {
      if ((await fs.stat(parent)).isDirectory()) return parent;
    } catch {}
  }
  return null;
}

const WIN_PICKER_CS = `
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class LatchFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialogRCW {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwndParent);
    [PreserveSig] int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    [PreserveSig] int SetFileTypeIndex(uint iFileType);
    [PreserveSig] int GetFileTypeIndex(out uint piFileType);
    [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
    [PreserveSig] int Unadvise(uint dwCookie);
    [PreserveSig] int SetOptions(uint fos);
    [PreserveSig] int GetOptions(out uint pfos);
    [PreserveSig] int SetDefaultFolder(IShellItem psi);
    [PreserveSig] int SetFolder(IShellItem psi);
    [PreserveSig] int GetFolder(out IShellItem ppsi);
    [PreserveSig] int GetCurrentSelection(out IShellItem ppsi);
    [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    [PreserveSig] int GetResult(out IShellItem ppsi);
    [PreserveSig] int AddPlace(IShellItem psi, int alignment);
    [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    [PreserveSig] int Close(int hr);
    [PreserveSig] int SetClientGuid(ref Guid guid);
    [PreserveSig] int ClearClientData();
    [PreserveSig] int SetFilter(IntPtr pFilter);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetParent(out IShellItem ppsi);
    [PreserveSig] int GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  private static extern int SHCreateItemFromParsingName(
    string pszPath,
    IntPtr pbc,
    ref Guid riid,
    [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv
  );

  private static IFileDialog CreateConfigured(string initialDir, out IShellItem initFolder) {
    initFolder = null;
    IFileDialog dialog = (IFileDialog)new FileOpenDialogRCW();
    uint existing = 0;
    Marshal.ThrowExceptionForHR(dialog.GetOptions(out existing));
    // FOS_NOCHANGEDIR (0x8) | FOS_PICKFOLDERS (0x20) | FOS_FORCEFILESYSTEM (0x40) | FOS_PATHMUSTEXIST (0x800)
    Marshal.ThrowExceptionForHR(dialog.SetOptions(existing | 0x8u | 0x20u | 0x40u | 0x800u));
    Marshal.ThrowExceptionForHR(dialog.SetTitle("Select Latch artifacts folder"));
    if (!string.IsNullOrEmpty(initialDir)) {
      Guid iidShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
      if (SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref iidShellItem, out initFolder) == 0 && initFolder != null) {
        dialog.SetFolder(initFolder);
      }
    }
    return dialog;
  }

  public static string Pick(string initialDir) {
    IFileDialog dialog = null;
    IShellItem initFolder = null;
    IShellItem resultItem = null;
    Form owner = null;
    try {
      dialog = CreateConfigured(initialDir, out initFolder);
      owner = new Form { TopMost = true };
      IntPtr hwnd = owner.Handle;
      int hr = dialog.Show(hwnd);
      if (hr == unchecked((int)0x800704C7)) return null;
      Marshal.ThrowExceptionForHR(hr);
      Marshal.ThrowExceptionForHR(dialog.GetResult(out resultItem));
      string selected = null;
      Marshal.ThrowExceptionForHR(resultItem.GetDisplayName(0x80058000u, out selected));
      return selected;
    } finally {
      if (owner != null) owner.Dispose();
      if (resultItem != null) Marshal.ReleaseComObject(resultItem);
      if (initFolder != null) Marshal.ReleaseComObject(initFolder);
      if (dialog != null) Marshal.ReleaseComObject(dialog);
    }
  }
}
`;

async function pickFolder(initialDir, {timeoutMs = 120000} = {}) {
  const safeInitial = await existingDir(initialDir);
  try {
    if (process.platform === 'win32') {
      const codeLiteral = `@'\n${WIN_PICKER_CS.trim()}\n'@`;
      const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        `$code = ${codeLiteral}`,
        'Add-Type -TypeDefinition $code -ReferencedAssemblies System.Windows.Forms',
        '$selected = [LatchFolderPicker]::Pick($env:LATCH_PICK_INITIAL)',
        'if ($selected) { [Console]::Out.Write($selected) }',
      ].join('\n');
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const {stdout} = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
        {
          timeout: timeoutMs,
          windowsHide: true,
          env: {...process.env, LATCH_PICK_INITIAL: safeInitial || ''},
        },
      );
      return stdout.trim() || null;
    }
    if (process.platform === 'darwin') {
      const appleScript = [
        'on run argv',
        '  set initPath to item 1 of argv',
        '  activate',
        '  try',
        '    if initPath is not "" then',
        '      set chosen to choose folder with prompt "Select Latch artifacts folder" default location (POSIX file initPath)',
        '    else',
        '      set chosen to choose folder with prompt "Select Latch artifacts folder"',
        '    end if',
        '    return POSIX path of chosen',
        '  on error number -128',
        '    return ""',
        '  end try',
        'end run',
      ].join('\n');
      const {stdout} = await execFileAsync('osascript', ['-e', appleScript, safeInitial || ''], {timeout: timeoutMs});
      return stdout.trim() || null;
    }
    if (process.platform === 'linux') {
      try {
        const args = [
          '--file-selection',
          '--directory',
          '--title=Select Latch artifacts folder',
          ...(safeInitial ? [`--filename=${safeInitial.replace(/\/+$/, '')}/`] : []),
        ];
        const {stdout} = await execFileAsync('zenity', args, {timeout: timeoutMs});
        return stdout.trim() || null;
      } catch (e) {
        if (e.code === 1) return null;
        if (e.code !== 'ENOENT') throw e;
      }
      try {
        const {stdout} = await execFileAsync(
          'kdialog',
          ['--getexistingdirectory', safeInitial || os.homedir(), '--title', 'Select Latch artifacts folder'],
          {timeout: timeoutMs},
        );
        return stdout.trim() || null;
      } catch (e) {
        if (e.code === 1) return null;
        throw e;
      }
    }
    throw fault('UNSUPPORTED_PLATFORM', 'Folder selection is supported on Windows, macOS, and Linux.');
  } catch (e) {
    if (e?.code === 'UNSUPPORTED_PLATFORM' || e?.code === 'PICK_FOLDER_FAILED') throw e;
    const message = e?.killed ? 'Folder selection timed out.' : `Could not open folder picker: ${e?.message || e}`;
    throw fault('PICK_FOLDER_FAILED', message);
  }
}

export class NativeUI {
  constructor(identity, sessions, browser, {pickDirectory = pickFolder} = {}) {
    Object.assign(this, {identity, sessions, browser, pickDirectory});
    this.stopped = false;
    this.pickingFolder = false;
    this.libraryServer = null;
    this.libraryStarting = null;
  }

  stop() {
    this.stopped = true;
    if (this.libraryServer) {
      const server = this.libraryServer;
      this.libraryServer = null;
      void server.close().catch(() => {});
    }
  }

  async status() {
    if (this.stopped) throw fault('BRIDGE_DISCONNECTED', 'Local bridge is stopping.');
    const config = await readConfig();
    const aliases = Object.entries(config.profiles || {})
      .filter(([, v]) => v.instanceId === this.identity.instanceId)
      .map(([k]) => short(k, 60))
      .slice(0, 8);
    await this.browser('status', {instanceId: this.identity.instanceId, epoch: this.identity.epoch});
    const tabs = await this.browser('tabs', {instanceId: this.identity.instanceId, epoch: this.identity.epoch});
    const rows = [];
    let truncated = false;
    const libraryInfo = describeLibraryRoot();
    const runCount = (await listRuns().catch(() => [])).length;

    for (const [key, entry] of this.sessions.sessions) {
      if (rows.length >= 32) {
        truncated = true;
        break;
      }
      const status = entry.relay.status();
      const owned = tabs.filter(t => t.owner === key);
      let runId = null;
      if (entry.workspace && entry.session) {
        const profileCandidates = aliases.length ? aliases : ['work'];
        for (const alias of profileCandidates) {
          const bound = await boundRun({workspace: entry.workspace, session: entry.session, profile: alias}).catch(() => null);
          if (bound?.id) {
            runId = bound.id;
            break;
          }
        }
      }
      rows.push({
        key,
        session: short(entry.session || key.slice(0, 12), 60),
        workspace: short(entry.workspace ? path.basename(entry.workspace) : '', 80),
        transport: 'native',
        state: !status.stopped ? 'attached' : 'interrupted',
        leaseId: entry.leaseId,
        revision: entry.leaseId,
        hostGeneration: this.identity.hostGeneration,
        revocable: !status.stopped,
        runId,
        tabCount: owned.length,
        tabs: owned.slice(0, 16).map(t => ({
          tabId: t.tabId,
          title: short(t.title),
          origin: (() => {
            try {
              return short(new URL(t.url).origin);
            } catch {
              return '';
            }
          })(),
        })),
      });
    }

    const result = {
      profile: {paired: !!aliases.length, aliases},
      nativeAvailable: !!this.identity.capabilities?.nativeTransport,
      release: this.identity.releaseVersion,
      extensionVersion: this.identity.extensionVersion,
      uiControl: 1,
      library: {
        runCount,
        path: libraryInfo.path,
        defaultPath: libraryInfo.defaultPath,
        configuredPath: libraryInfo.configuredPath,
        source: libraryInfo.source,
        envOverride: libraryInfo.envOverride,
        serverUrl: this.libraryServer?.url || null,
      },
      sessions: rows,
      truncated,
    };
    while (Buffer.byteLength(JSON.stringify(result)) > 49152) {
      const withTabs = rows.findLast(r => r.tabs.length);
      if (withTabs) withTabs.tabs.pop();
      else rows.pop();
      result.truncated = true;
    }
    return result;
  }

  async openLibrary(payload = {}) {
    if (this.stopped) throw fault('BRIDGE_DISCONNECTED', 'Local bridge is stopping.');
    const runId = payload.runId ? String(payload.runId) : null;
    if (runId && !runPattern.test(runId)) {
      throw fault('INVALID_RUN', 'Invalid exploration run ID.');
    }
    if (!this.libraryServer) {
      if (!this.libraryStarting) {
        this.libraryStarting = startLibraryServer({port: 0}).finally(() => {
          this.libraryStarting = null;
        });
      }
      const started = await this.libraryStarting;
      if (this.stopped) {
        void started.close().catch(() => {});
        throw fault('BRIDGE_DISCONNECTED', 'Local bridge is stopping.');
      }
      this.libraryServer = started;
    }
    const baseUrl = this.libraryServer.url;
    return {
      url: runId ? `${baseUrl}/run/${runId}` : baseUrl,
      baseUrl,
      ...(runId ? {runId} : {}),
    };
  }

  async chooseFolder() {
    if (this.stopped) throw fault('BRIDGE_DISCONNECTED', 'Local bridge is stopping.');
    const current = describeLibraryRoot();
    if (current.envOverride) {
      throw fault('CONFIG_LOCKED', 'Artifacts folder is overridden by LATCH_ARTIFACT_ROOT environment variable.');
    }
    if (this.pickingFolder) {
      throw fault('UI_BUSY', 'A folder picker is already open.');
    }
    this.pickingFolder = true;
    try {
      const selected = await this.pickDirectory(current.path);
      if (!selected || !String(selected).trim()) {
        return {cancelled: true, updated: false};
      }
      const updated = await setArtifactsDir(String(selected).trim(), {requireAbsolute: true});
      const runCount = (await listRuns().catch(() => [])).length;
      return {
        cancelled: false,
        ...updated,
        library: {
          runCount,
          path: updated.path,
          defaultPath: updated.defaultPath,
          configuredPath: updated.configuredPath,
          source: updated.source,
          envOverride: updated.envOverride,
          serverUrl: this.libraryServer?.url || null,
        },
      };
    } finally {
      this.pickingFolder = false;
    }
  }

  async setConfig(payload = {}) {
    if (this.stopped) throw fault('BRIDGE_DISCONNECTED', 'Local bridge is stopping.');
    const key = payload.key;
    if (key !== 'artifactsDir' && key !== 'artifacts-dir') {
      throw fault('INVALID_ARGUMENT', 'Unsupported config key. Expected artifactsDir.');
    }
    const reset = payload.reset === true || payload.value === null || payload.value === undefined || payload.value === '';
    const updated = reset
      ? await setArtifactsDir(null)
      : await setArtifactsDir(payload.value, {requireAbsolute: true});
    const runCount = (await listRuns().catch(() => [])).length;
    return {
      ...updated,
      library: {
        runCount,
        path: updated.path,
        defaultPath: updated.defaultPath,
        configuredPath: updated.configuredPath,
        source: updated.source,
        envOverride: updated.envOverride,
        serverUrl: this.libraryServer?.url || null,
      },
    };
  }

  async revoke(p) {
    if (!this.identity.capabilities?.nativeTransport) {
      throw fault('UI_UNSUPPORTED', 'This host has no native debugger transport.');
    }
    if (!/^[a-f0-9]{64}$/.test(p.key || '')) throw fault('INVALID_SESSION', 'Invalid task key.');
    const entry = this.sessions.sessions.get(p.key);
    if (
      !entry ||
      entry.leaseId !== p.leaseId ||
      p.hostGeneration !== this.identity.hostGeneration
    ) {
      throw fault('AUTHORITY_STALE', 'This task changed. Refresh before stopping it.');
    }
    if (this.sessions.busy.has(p.key)) {
      throw fault('SESSION_BUSY', 'This task is busy. No access was stopped; refresh and try again.');
    }
    try {
      await this.sessions.handle('session-disconnect', {
        instanceId: this.identity.instanceId,
        epoch: this.identity.epoch,
        hostGeneration: this.identity.hostGeneration,
        sessionKey: p.key,
        leaseId: p.leaseId,
      });
      return {accessRevoked: true, cleanup: 'confirmed', outcome: null, leaseId: p.leaseId};
    } catch (e) {
      const live = this.sessions.sessions.get(p.key);
      if (!live || live.relay.status().stopped) {
        return {
          accessRevoked: true,
          cleanup: 'unconfirmed',
          outcome: 'unknown',
          code: e.code || 'CLEANUP_FAILED',
          leaseId: p.leaseId,
        };
      }
      throw e;
    }
  }
}
