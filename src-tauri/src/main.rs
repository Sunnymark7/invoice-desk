#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportFile {
    name: String,
    data_base64: String,
}

#[tauri::command]
async fn read_import_file(path: String) -> Result<ImportFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&path);
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(extension.as_str(), "pdf" | "ofd" | "jpg" | "jpeg" | "png" | "webp") {
            return Err("请选择 PDF、OFD 或图片文件".into());
        }
        let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() > 256 * 1024 * 1024 {
            return Err("请选择不超过 256 MB 的票据文件".into());
        }
        let name = path.file_name().and_then(|value| value.to_str()).ok_or("文件名无法读取")?.to_owned();
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        Ok(ImportFile { name, data_base64: base64::engine::general_purpose::STANDARD.encode(bytes) })
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_export(app: tauri::AppHandle, name: String, data_base64: String) -> Result<Option<String>, String> {
    let extension = std::path::Path::new(&name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "pdf" | "csv") {
        return Err("不支持的导出格式".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|error| error.to_string())?;
        let selected = app.dialog().file()
            .set_title("保存导出文件")
            .set_file_name(&name)
            .add_filter(if extension == "pdf" { "PDF 文档" } else { "CSV 明细" }, &[&extension])
            .blocking_save_file();
        let Some(selected) = selected else { return Ok(None); };
        let mut target = selected.into_path().map_err(|error| error.to_string())?;
        if target.extension().is_none() { target.set_extension(&extension); }
        if target.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase).as_deref() != Some(extension.as_str()) {
            return Err("文件扩展名与导出格式不一致".into());
        }
        std::fs::write(&target, bytes).map_err(|error| format!("文件保存失败：{error}"))?;
        Ok(Some(target.to_string_lossy().into_owned()))
    }).await.map_err(|error| error.to_string())?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_export, read_import_file])
        .run(tauri::generate_context!())
        .expect("无法启动票据台");
}
