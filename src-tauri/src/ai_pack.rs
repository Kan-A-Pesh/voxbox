//! In-app update of the « VoxBox - Voix IA » pack (Réglages → Voix IA, the voice-models.com
//! explorer, and an offer at launch).
//!
//! A newer pack is found and authenticated by `voxbox_aipack` (its manifest is signed with the
//! updater key of tauri.conf.json). Installing downloads the installer into the app cache and
//! checks it against the manifest, then hands over to a hidden PowerShell ([`HANDOFF`]):
//! 0. VoxBox creates the named mutex [`INSTALL_MUTEX`] before starting it, and exits only once
//!    the script has opened it too (it prints READY): the mutex exists without a gap from before
//!    VoxBox closes until the installer is done, and a VoxBox started by hand meanwhile exits
//!    at once ([`install_running`], checked before anything else) instead of loading the
//!    pack's runtime, which the installer is replacing;
//! 1. it waits for VoxBox to exit (the pack's ONNX Runtime DLLs are loaded by the running app),
//!    and gives up without installing nor restarting if VoxBox is still there after 60 s;
//! 2. it opens the installer without sharing write or delete access, so it cannot be replaced
//!    any more, checks its SHA-256 against the manifest's again through that handle, and reads
//!    the pack installed at that moment (never a reinstall or a downgrade);
//! 3. it runs that file elevated and silently into VoxBox's folder (handle still held);
//! 4. it releases the mutex and starts VoxBox again, whatever happened in 2 and 3
//!    (authorization refused included).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::blocking;
use crate::state::{AppError, AppResult, AppState, Resources};

/// GitHub repository publishing the `ai-pack-<N>` releases.
const PACK_REPO: &str = "Kan-A-Pesh/voxbox";

/// Converter hardening a downloaded checkpoint needs (see `CONVERTER_API` in convert_rvc.py).
pub const ONLINE_CONVERTER_API: u32 = 3;

/// One install at a time: the second click of an impatient user is refused. Stays set once the
/// installer is handed over (VoxBox is closing).
static INSTALLING: AtomicBool = AtomicBool::new(false);
/// The installers' cache: held by an install from its download to the handover, and by a check
/// while it removes earlier installers, so a check never removes the one being installed.
static CACHE: parking_lot::Mutex<()> = parking_lot::const_mutex(());

/// Held by the handoff script from before VoxBox closes until the installer is done.
#[cfg_attr(not(windows), allow(dead_code))]
const INSTALL_MUTEX: &str = "Local\\VoxBoxAiPackInstall";

/// A pack install handed over by an earlier VoxBox is running: this VoxBox must not load the
/// pack (its DLLs would block the installer). The handoff starts VoxBox again once done.
#[cfg(windows)]
pub fn install_running() -> bool {
    named_mutex_exists(INSTALL_MUTEX)
}

#[cfg(not(windows))]
pub fn install_running() -> bool {
    false
}

#[cfg(windows)]
fn named_mutex_exists(name: &str) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string alive for the call; the handle returned
    // (when not null) is closed right away.
    let handle = unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, wide.as_ptr()) };
    if handle.is_null() {
        return false;
    }
    // SAFETY: a valid handle just opened by this function, closed once.
    unsafe { CloseHandle(handle) };
    true
}

/// The installed pack, in the snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPackInfo {
    /// The converter or the AI assets are there.
    pub installed: bool,
    /// From `resources/ai-pack.json`; None for a pack published before that file existed.
    pub version: Option<u32>,
    /// Its converter can import downloaded models (voice-models.com).
    pub online_ready: bool,
}

/// A newer published pack.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPackUpdate {
    pub version: u32,
    /// Installer size in bytes.
    pub size: u64,
}

pub fn info(resources: &Resources) -> AiPackInfo {
    let converter = resources.python_exe.exists();
    AiPackInfo {
        installed: converter || resources.ai_assets.exists(),
        version: voxbox_aipack::installed_version(&resources.pack_manifest),
        online_ready: converter
            && voxbox_rvc::converter_api(&resources.converter_script) >= ONLINE_CONVERTER_API,
    }
}

/// A published pack is offered when it is newer than the installed one; a pack of unknown
/// version (published before ai-pack.json) or no pack at all is older than any.
fn is_newer(published: u32, installed: Option<u32>) -> bool {
    installed.is_none_or(|installed| published > installed)
}

/// The updater's public key: the pack manifest is signed with the same key as the app.
fn updater_pubkey(app: &AppHandle) -> AppResult<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .map(str::to_owned)
        .ok_or_else(|| AppError::Other("clé de vérification des mises à jour absente".into()))
}

fn cache_dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Other(format!("dossier de cache introuvable : {e}")))?
        .join("ai-pack"))
}

/// Removes the cache's files except the installers `keep` accepts (by pack version). Partial
/// downloads (temporary names) always go: callers hold CACHE with no download running.
fn clear_cache(dir: &Path, keep: impl Fn(u32) -> bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if voxbox_aipack::cached_installer_version(&name.to_string_lossy()).is_some_and(&keep) {
            continue;
        }
        if let Err(e) = std::fs::remove_file(entry.path()) {
            tracing::warn!(
                "installateur du pack non supprimé ({}) : {e}",
                entry.path().display()
            );
        }
    }
}

fn latest(app: &AppHandle) -> AppResult<Option<voxbox_aipack::PackRelease>> {
    let pubkey = updater_pubkey(app)?;
    Ok(voxbox_aipack::Client::new(PACK_REPO).latest(&pubkey)?)
}

/// The newest published pack, when it is newer than the installed one.
#[tauri::command]
pub async fn ai_pack_check(app: AppHandle) -> AppResult<Option<AiPackUpdate>> {
    blocking(move || {
        let installed = info(&app.state::<AppState>().resources).version;
        // Skipped while an install of this process holds the cache, or once it has handed an
        // installer over. An installer handed over by a previous VoxBox (this one may be its
        // relaunch while the installer is starting) is newer than the installed pack until
        // installed: it is kept, only installers of packs already installed go.
        if let Some(_cache) = CACHE.try_lock() {
            if !INSTALLING.load(Ordering::Acquire) {
                if let Ok(dir) = cache_dir(&app) {
                    clear_cache(&dir, |version| is_newer(version, installed));
                }
            }
        }
        Ok(latest(&app)?
            .filter(|release| is_newer(release.version, installed))
            .map(|release| AiPackUpdate {
                version: release.version,
                size: release.size,
            }))
    })
    .await
}

/// Downloads pack `version` (emitting "ai-pack-progress" { progress: 0..1 }), then closes
/// VoxBox while it is installed (see the module doc). Returns only on failure.
#[tauri::command]
pub async fn ai_pack_install(app: AppHandle, version: u32) -> AppResult<()> {
    if !cfg!(windows) {
        return Err(AppError::Other(
            "la mise à jour du pack n'est possible que sous Windows".into(),
        ));
    }
    if INSTALLING.swap(true, Ordering::AcqRel) {
        return Err(AppError::Other(
            "le pack est déjà en cours de mise à jour".into(),
        ));
    }
    let result = blocking({
        let app = app.clone();
        move || download_and_launch(&app, version)
    })
    .await;
    match result {
        Ok(()) => {
            // The installer waits for this exit before replacing the pack's files.
            app.exit(0);
            Ok(())
        }
        Err(e) => {
            INSTALLING.store(false, Ordering::Release);
            Err(e)
        }
    }
}

fn download_and_launch(app: &AppHandle, version: u32) -> AppResult<()> {
    let _cache = CACHE.lock();
    let release = latest(app)?
        .filter(|release| release.version == version)
        .ok_or_else(|| {
            AppError::Other(format!(
            "le pack {version} n'est plus le dernier publié : recherche à nouveau une mise à jour"
        ))
        })?;
    // From the files on disk now, not from the offer: never reinstall or downgrade a pack.
    let installed = info(&app.state::<AppState>().resources).version;
    if !is_newer(release.version, installed) {
        return Err(AppError::Other(format!(
            "le pack installé ({}) est déjà à jour",
            installed.unwrap_or(release.version)
        )));
    }
    let dir = cache_dir(app)?;
    // This install replaces any earlier installer (its own handover is the only one to come).
    clear_cache(&dir, |_| false);
    let installer =
        voxbox_aipack::Client::new(PACK_REPO).download(&release, &dir, &mut |done, total| {
            let progress = if total == 0 {
                1.0
            } else {
                done as f64 / total as f64
            };
            let _ = app.emit(
                "ai-pack-progress",
                serde_json::json!({ "progress": progress }),
            );
        })?;
    let resources = &app.state::<AppState>().resources;
    let install_dir = resources
        .dir
        .parent()
        .ok_or_else(|| AppError::Other("dossier d'installation de VoxBox introuvable".into()))?;
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Other(format!("emplacement de VoxBox introuvable : {e}")))?;
    tracing::info!(
        "pack Voix IA {version} téléchargé ({}), installation dans {}",
        installer.display(),
        install_dir.display()
    );
    launch_installer(&Handoff {
        installer: &installer,
        sha256: &release.sha256,
        version: release.version,
        marker: &resources.pack_manifest,
        install_dir,
        exe: &exe,
        pid: std::process::id(),
        wait_ms: 60_000,
        elevate: true,
        mutex: INSTALL_MUTEX,
    })
}

/// What the handoff script needs, passed through its environment.
#[cfg_attr(not(windows), allow(dead_code))]
struct Handoff<'a> {
    installer: &'a Path,
    sha256: &'a str,
    version: u32,
    /// `resources/ai-pack.json`, read again right before installing.
    marker: &'a Path,
    install_dir: &'a Path,
    exe: &'a Path,
    /// The process to wait for (VoxBox itself).
    pid: u32,
    wait_ms: u32,
    /// Always true for VoxBox (the pack installs into Program Files); false runs the installer
    /// as is, for the tests' harmless installer double.
    elevate: bool,
    /// [`INSTALL_MUTEX`] for VoxBox; a name of their own for the tests.
    mutex: &'a str,
}

#[cfg(windows)]
fn handoff_command(handoff: &Handoff<'_>) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let powershell =
        Path::new(&system_root).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let mut command = std::process::Command::new(powershell);
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            HANDOFF,
        ])
        .env("VOXBOX_PID", handoff.pid.to_string())
        .env("VOXBOX_WAIT_MS", handoff.wait_ms.to_string())
        .env("VOXBOX_PACK", handoff.installer)
        .env("VOXBOX_SHA256", handoff.sha256)
        .env("VOXBOX_VERSION", handoff.version.to_string())
        .env("VOXBOX_MARKER", handoff.marker)
        .env("VOXBOX_DIR", handoff.install_dir)
        .env("VOXBOX_EXE", handoff.exe)
        .env("VOXBOX_ELEVATE", if handoff.elevate { "1" } else { "0" })
        .env("VOXBOX_INSTALL_MUTEX", handoff.mutex)
        .creation_flags(CREATE_NO_WINDOW);
    command
}

/// How long the script may take to start and open the mutex before the install is given up.
#[cfg(windows)]
const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Starts the handoff, holding [`INSTALL_MUTEX`] until the script holds it too. The handle is
/// left open on purpose: it closes when VoxBox exits, once the script holds the mutex too. On
/// failure nothing is left running and VoxBox stays open.
#[cfg(windows)]
fn launch_installer(handoff: &Handoff<'_>) -> AppResult<()> {
    start_handoff(handoff).map(|_guard| ())
}

/// The handoff started and READY received; returns VoxBox's own handle on the mutex.
#[cfg(windows)]
fn start_handoff(handoff: &Handoff<'_>) -> AppResult<windows_sys::Win32::Foundation::HANDLE> {
    use std::io::BufRead;
    use windows_sys::Win32::Foundation::CloseHandle;
    let failed =
        |e: String| AppError::Other(format!("lancement de l'installation impossible : {e}"));
    let guard = create_named_mutex(handoff.mutex).map_err(failed)?;
    let child = handoff_command(handoff)
        .stdout(std::process::Stdio::piped())
        .spawn();
    let result = child.map_err(|e| e.to_string()).and_then(|mut child| {
        let stdout = child.stdout.take().ok_or("sortie du script absente")?;
        let (ready, wait) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let first = std::io::BufReader::new(stdout).lines().next();
            let _ = ready.send(matches!(first, Some(Ok(line)) if line.trim() == "READY"));
        });
        if wait.recv_timeout(READY_TIMEOUT).unwrap_or(false) {
            Ok(())
        } else {
            let _ = child.kill();
            let _ = child.wait();
            Err("le script d'installation n'a pas démarré".to_string())
        }
    });
    match result {
        Ok(()) => Ok(guard),
        Err(e) => {
            // SAFETY: the handle created above, closed once, on this failure path only.
            unsafe { CloseHandle(guard) };
            Err(failed(e))
        }
    }
}

/// Creates (or opens) the named mutex `name`; the returned handle keeps it alive.
#[cfg(windows)]
fn create_named_mutex(name: &str) -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string alive for the call; no security
    // attributes (default), not initially owned.
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
    if handle.is_null() {
        Err(format!(
            "verrou {name} impossible : {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(handle)
    }
}

#[cfg(not(windows))]
fn launch_installer(_handoff: &Handoff<'_>) -> AppResult<()> {
    Err(AppError::Other(
        "la mise à jour du pack n'est possible que sous Windows".into(),
    ))
}

/// The hidden PowerShell taking over once VoxBox closes (steps in the module doc). Values pass
/// through the environment, never quoted into the script. NSIS takes everything after /D= as
/// the folder (spaces included), so the arguments are one string.
#[cfg_attr(not(windows), allow(dead_code))]
const HANDOFF: &str = r#"$ErrorActionPreference = 'Stop'
# 0. Until the installer is done, a VoxBox started meanwhile closes at once (install_running).
# VoxBox created it and waits for READY before it exits: the mutex never disappears meanwhile.
$installing = New-Object System.Threading.Mutex($false, $env:VOXBOX_INSTALL_MUTEX)
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
# 1. VoxBox must be gone: its runtime DLLs would block the installer. Still there: nothing to restart.
$app = Get-Process -Id ([int]$env:VOXBOX_PID) -ErrorAction SilentlyContinue
if ($app -and -not $app.WaitForExit([int]$env:VOXBOX_WAIT_MS)) { exit 1 }
# 2 and 3. Any failure here still restarts VoxBox (4).
try {
    $file = [IO.File]::Open($env:VOXBOX_PACK, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        $hash = [BitConverter]::ToString($sha.ComputeHash($file)).Replace('-', '').ToLowerInvariant()
        # The pack installed now (an unreadable marker is a pack of unknown version, the oldest).
        $installed = 0
        try {
            if (Test-Path -LiteralPath $env:VOXBOX_MARKER) {
                $installed = [int]((Get-Content -Raw -LiteralPath $env:VOXBOX_MARKER | ConvertFrom-Json).version)
            }
        } catch { $installed = 0 }
        if ($hash -eq $env:VOXBOX_SHA256 -and $installed -lt [int]$env:VOXBOX_VERSION) {
            # A refused authorization just skips it.
            $arguments = '/S /D=' + $env:VOXBOX_DIR
            try {
                if ($env:VOXBOX_ELEVATE -eq '0') {
                    Start-Process -FilePath $env:VOXBOX_PACK -ArgumentList $arguments -Wait
                } else {
                    Start-Process -FilePath $env:VOXBOX_PACK -ArgumentList $arguments -Verb RunAs -Wait
                }
            } catch { }
        }
    } finally {
        $file.Dispose()
    }
} catch { }
# 4. Released first: the VoxBox started here must not see an install still running.
$installing.Dispose()
Start-Process -FilePath $env:VOXBOX_EXE
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pack_is_offered_only_when_newer_or_of_unknown_version() {
        assert!(is_newer(14, None), "unknown or absent pack");
        assert!(is_newer(14, Some(13)));
        assert!(!is_newer(14, Some(14)));
        assert!(!is_newer(13, Some(14)), "never a downgrade");
    }

    #[test]
    fn the_handoff_holds_the_mutex_it_is_given_and_says_so() {
        let opened = HANDOFF
            .find("Mutex($false, $env:VOXBOX_INSTALL_MUTEX)")
            .expect("opens the mutex VoxBox created");
        let ready = HANDOFF.find("WriteLine('READY')").expect("tells VoxBox");
        let wait = HANDOFF.find("WaitForExit(").expect("then waits for VoxBox");
        assert!(opened < ready && ready < wait);
    }

    #[test]
    fn a_check_keeps_the_installer_of_a_pack_not_installed_yet() {
        let dir = tempfile::tempdir().unwrap();
        for version in [13, 14, 15] {
            let name = voxbox_aipack::cached_installer_name(version);
            std::fs::write(dir.path().join(name), b"").unwrap();
        }
        std::fs::write(dir.path().join(".tmpA1b2C3"), b"").unwrap();
        let installed = Some(14);
        clear_cache(dir.path(), |version| is_newer(version, installed));
        let left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            left,
            ["VoxBox-Voix-IA-setup-15.exe"],
            "handed over, not installed yet"
        );
        clear_cache(dir.path(), |_| false);
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "an install clears all"
        );
    }

    #[test]
    fn reads_the_installed_pack() {
        let dir = tempfile::tempdir().unwrap();
        let resources = Resources::from_dir(dir.path());
        assert_eq!(
            info(&resources),
            AiPackInfo {
                installed: false,
                version: None,
                online_ready: false
            }
        );
        let converter = dir.path().join("converter");
        std::fs::create_dir_all(&converter).unwrap();
        std::fs::write(converter.join("python.exe"), b"").unwrap();
        std::fs::write(converter.join("convert_rvc.py"), "CONVERTER_API = 2\n").unwrap();
        assert_eq!(
            info(&resources),
            AiPackInfo {
                installed: true,
                version: None,
                online_ready: false
            },
            "a pack older than ai-pack.json and the online import"
        );
        std::fs::write(converter.join("convert_rvc.py"), "CONVERTER_API = 3\n").unwrap();
        std::fs::write(dir.path().join("ai-pack.json"), "{\"version\":14}").unwrap();
        assert_eq!(
            info(&resources),
            AiPackInfo {
                installed: true,
                version: Some(14),
                online_ready: true
            }
        );
    }

    /// The handoff script with harmless doubles: `.bat` files stand in for the installer (it
    /// leaves `installed.txt` with its arguments) and for VoxBox (`relaunched.txt`), and the
    /// installer is not elevated (`elevate: false`). The elevated run itself is left to the
    /// manual Windows check.
    #[cfg(windows)]
    mod handoff {
        use super::super::{handoff_command, Handoff};
        use sha2::{Digest, Sha256};
        use std::path::Path;
        use std::time::{Duration, Instant};

        /// Records its arguments (it ran, and with what), takes a moment, then says it is done.
        const INSTALLER: &str = "@echo off\r\necho %*> \"%~dp0installed.txt\"\r\nping -n 3 127.0.0.1 >nul\r\necho done> \"%~dp0install-done.txt\"\r\n";
        /// Writes whether the installer had finished when VoxBox started again.
        const VOXBOX: &str = "@echo off\r\nif exist \"%~dp0install-done.txt\" (echo after> \"%~dp0relaunched.txt\") else (echo before> \"%~dp0relaunched.txt\")\r\n";
        const INSTALL_DIR: &str = "C:\\Program Files Test\\VoxBox";

        struct Run {
            dir: tempfile::TempDir,
            status: std::process::ExitStatus,
            mutex: String,
        }

        /// A mutex name of its own per run: tests run in parallel.
        fn unique_mutex() -> String {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            format!("Local\\VoxBoxTest-{}-{n}", std::process::id())
        }

        impl Run {
            fn relaunched(&self) -> bool {
                // Start-Process does not wait for VoxBox: give the double a moment.
                let deadline = Instant::now() + Duration::from_secs(10);
                while Instant::now() < deadline {
                    if self.dir.path().join("relaunched.txt").exists() {
                        return true;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                false
            }
            fn installed(&self) -> bool {
                self.dir.path().join("installed.txt").exists()
            }
        }

        fn exited_pid() -> u32 {
            let mut child = std::process::Command::new("cmd")
                .args(["/c", "exit"])
                .spawn()
                .unwrap();
            let pid = child.id();
            child.wait().unwrap();
            pid
        }

        fn run(sha256: Option<&str>, marker: Option<&str>, pid: u32, wait_ms: u32) -> Run {
            let dir = tempfile::tempdir().unwrap();
            let installer = dir.path().join("setup.bat");
            std::fs::write(&installer, INSTALLER).unwrap();
            let exe = dir.path().join("voxbox.bat");
            std::fs::write(&exe, VOXBOX).unwrap();
            let marker_path = dir.path().join("ai-pack.json");
            if let Some(marker) = marker {
                std::fs::write(&marker_path, marker).unwrap();
            }
            let actual = format!("{:x}", Sha256::digest(INSTALLER.as_bytes()));
            let mutex = unique_mutex();
            let status = handoff_command(&Handoff {
                installer: &installer,
                sha256: sha256.unwrap_or(&actual),
                version: 15,
                marker: &marker_path,
                install_dir: Path::new(INSTALL_DIR),
                exe: &exe,
                pid,
                wait_ms,
                elevate: false,
                mutex: &mutex,
            })
            .status()
            .unwrap();
            Run { dir, status, mutex }
        }

        #[test]
        fn a_verified_newer_installer_runs_silently_into_voxbox_then_voxbox_restarts() {
            let run = run(None, Some("{\"version\":14}"), exited_pid(), 60_000);
            assert!(run.status.success());
            assert!(run.relaunched());
            let args = std::fs::read_to_string(run.dir.path().join("installed.txt")).unwrap();
            // NSIS reads everything after /D= as the folder, spaces included.
            assert_eq!(args.trim(), format!("/S /D={INSTALL_DIR}"));
            // -Wait: VoxBox starts again only once the installer is done.
            let relaunch = std::fs::read_to_string(run.dir.path().join("relaunched.txt")).unwrap();
            assert_eq!(relaunch.trim(), "after");
            assert!(
                !super::super::named_mutex_exists(&run.mutex),
                "mutex released"
            );
        }

        #[test]
        fn a_named_mutex_is_seen_while_held() {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Threading::CreateMutexW;
            let name = format!("Local\\VoxBoxTest-{}", std::process::id());
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            assert!(!super::super::named_mutex_exists(&name));
            // SAFETY: NUL-terminated name alive for the call; the handle is closed below.
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
            assert!(!handle.is_null());
            assert!(super::super::named_mutex_exists(&name));
            // SAFETY: the handle created above, closed once.
            unsafe { CloseHandle(handle) };
            assert!(!super::super::named_mutex_exists(&name));
        }

        #[test]
        fn a_modified_installer_is_not_run_and_voxbox_restarts() {
            let run = run(Some(&"0".repeat(64)), None, exited_pid(), 60_000);
            assert!(run.status.success());
            assert!(run.relaunched());
            assert!(!run.installed());
        }

        #[test]
        fn a_pack_already_installed_at_that_moment_is_not_reinstalled() {
            for marker in ["{\"version\":15}", "{\"version\":16}"] {
                let run = run(None, Some(marker), exited_pid(), 60_000);
                assert!(run.relaunched(), "{marker}");
                assert!(!run.installed(), "{marker}");
            }
        }

        #[test]
        fn an_unreadable_installer_still_restarts_voxbox() {
            let dir = tempfile::tempdir().unwrap();
            let exe = dir.path().join("voxbox.bat");
            std::fs::write(&exe, VOXBOX).unwrap();
            let status = handoff_command(&Handoff {
                installer: &dir.path().join("missing.exe"),
                sha256: &"0".repeat(64),
                version: 15,
                marker: &dir.path().join("ai-pack.json"),
                install_dir: Path::new(INSTALL_DIR),
                exe: &exe,
                pid: exited_pid(),
                wait_ms: 60_000,
                elevate: false,
                mutex: &unique_mutex(),
            })
            .status()
            .unwrap();
            let run = Run {
                dir,
                status,
                mutex: String::new(),
            };
            assert!(run.relaunched());
        }

        #[test]
        fn launching_returns_once_the_script_holds_the_mutex_too() {
            use windows_sys::Win32::Foundation::CloseHandle;
            // VoxBox (here a ping) is still running: the script holds the mutex and waits.
            let mut alive = std::process::Command::new("ping")
                .args(["-n", "30", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let dir = tempfile::tempdir().unwrap();
            let exe = dir.path().join("voxbox.bat");
            std::fs::write(&exe, VOXBOX).unwrap();
            let mutex = unique_mutex();
            let guard = super::super::start_handoff(&Handoff {
                installer: &dir.path().join("missing.exe"),
                sha256: &"0".repeat(64),
                version: 15,
                marker: &dir.path().join("ai-pack.json"),
                install_dir: Path::new(INSTALL_DIR),
                exe: &exe,
                pid: alive.id(),
                wait_ms: 60_000,
                elevate: false,
                mutex: &mutex,
            })
            .expect("READY received");
            // VoxBox lets go of its own handle (as when it exits): the mutex is still there,
            // so the script already held it when start_handoff returned.
            // SAFETY: the handle start_handoff returned, closed once.
            unsafe { CloseHandle(guard) };
            assert!(super::super::named_mutex_exists(&mutex));
            let _ = alive.kill();
            let _ = alive.wait();
            let run = Run {
                dir,
                status: std::process::Command::new("cmd")
                    .args(["/c", "exit"])
                    .status()
                    .unwrap(),
                mutex,
            };
            assert!(run.relaunched());
        }

        #[test]
        fn voxbox_still_running_stops_the_handoff_without_installing_nor_restarting() {
            // A valid, newer installer: only VoxBox still being there may stop it.
            let mut alive = std::process::Command::new("ping")
                .args(["-n", "30", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let run = run(None, Some("{\"version\":14}"), alive.id(), 300);
            let _ = alive.kill();
            let _ = alive.wait();
            assert_eq!(run.status.code(), Some(1));
            assert!(!run.installed());
            std::thread::sleep(Duration::from_secs(1));
            assert!(!run.dir.path().join("relaunched.txt").exists());
        }
    }
}
