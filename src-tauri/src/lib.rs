mod virtual_camera;

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::{Manager, State};
use virtual_camera::{VirtualCameraManager, VirtualCameraStatus};

#[tauri::command]
fn get_virtual_camera_status(
    manager: State<'_, VirtualCameraManager>,
) -> VirtualCameraStatus {
    manager.status()
}

#[tauri::command]
fn start_virtual_camera(
    width: u32,
    height: u32,
    fps: f64,
    manager: State<'_, VirtualCameraManager>,
) -> Result<VirtualCameraStatus, String> {
    manager.start(width, height, fps)
}

#[tauri::command]
fn stop_virtual_camera(
    manager: State<'_, VirtualCameraManager>,
) -> Result<VirtualCameraStatus, String> {
    manager.stop()
}

#[tauri::command]
fn push_virtual_camera_frame(
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    manager: State<'_, VirtualCameraManager>,
) -> Result<(), String> {
    manager.push_frame(rgba, width, height)
}

fn install_status_path() -> PathBuf {
    std::env::temp_dir().join("dallr_vcam_install_status.txt")
}

/// Returns current virtual camera installation progress/status written by the installer.
#[tauri::command]
fn get_virtual_camera_install_progress() -> String {
    let path = install_status_path();
    fs::read_to_string(path).unwrap_or_default().trim().to_string()
}

/// Installs/registers the bundled "Dallr Cam" DirectShow virtual camera device (Windows).
/// Requests administrator elevation (UAC) once, runs registration, and writes progress to a status file
/// so the app UI can display progress without requiring an external console window.
#[tauri::command]
fn install_virtual_camera(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Err("Virtual camera installation is supported on Windows only.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        fn normalize_win_path(p: &std::path::Path) -> String {
            let s = p.to_string_lossy().to_string();
            s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
        }

        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to resolve resource directory: {e}"))?;

        // Bundled as resources/virtual-camera/* -> <resource_dir>/virtual-camera/
        let vc_dir = resource_dir.join("virtual-camera");
        let dll32 = vc_dir.join("UnityCaptureFilter32.dll");
        let dll64 = vc_dir.join("UnityCaptureFilter64.dll");

        if !dll32.exists() || !dll64.exists() {
            return Err(format!(
                "Virtual camera driver files not found. Expected at: {}",
                vc_dir.display()
            ));
        }

        let dll32s = normalize_win_path(&dll32).replace('\'', "''");
        let dll64s = normalize_win_path(&dll64).replace('\'', "''");
        let status_file = normalize_win_path(&install_status_path()).replace('\'', "''");

        // Initialize status (app polls this file for in-app progress).
        // Runs registration directly (no UAC prompt). If the app is not running as administrator,
        // registration may fail and the error will be reported in the status file.
        let _ = fs::write(install_status_path(), "starting");

        let ps_command = format!(
            "$ErrorActionPreference='Stop'; \
             $status='{status_file}'; $d32='{dll32s}'; $d64='{dll64s}'; \
             try {{ \
               Set-Content -Path $status -Value 'registering_32' -Encoding UTF8; \
               $p = Start-Process -FilePath 'regsvr32.exe' -ArgumentList @('/s', $d32, '/i:UnityCaptureName=Dallr Cam') -Wait -PassThru; \
               if ($p.ExitCode -ne 0) {{ throw ('32-bit registration failed (code ' + $p.ExitCode + '). Run the app as Administrator.') }}; \
               Set-Content -Path $status -Value 'registering_64' -Encoding UTF8; \
               $p = Start-Process -FilePath 'regsvr32.exe' -ArgumentList @('/s', $d64, '/i:UnityCaptureName=Dallr Cam') -Wait -PassThru; \
               if ($p.ExitCode -ne 0) {{ throw ('64-bit registration failed (code ' + $p.ExitCode + '). Run the app as Administrator.') }}; \
               Set-Content -Path $status -Value 'completed' -Encoding UTF8; \
             }} catch {{ \
               Set-Content -Path $status -Value ('error:' + $_.Exception.Message) -Encoding UTF8; \
               exit 1; \
             }}"
        );

        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &ps_command,
            ])
            .spawn()
            .map_err(|e| format!("Failed to launch virtual camera installer: {e}"))?;

        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(VirtualCameraManager::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_virtual_camera_status,
            start_virtual_camera,
            stop_virtual_camera,
            push_virtual_camera_frame,
            install_virtual_camera,
            get_virtual_camera_install_progress,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
