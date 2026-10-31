// Desktop exports use a native save dialog; browser downloads keep working.
if (window.__TAURI__?.core?.invoke) {
  window.invoiceDesktop = {
    nativeDrops: true,
    async onFilesDropped(onFiles, onHover, onError) {
      return window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(async event => {
        const { type, paths } = event.payload;
        onHover(type === 'enter' || type === 'over');
        if (type !== 'drop') return;
        try {
          const files = [];
          for (const path of paths) {
            const imported = await window.__TAURI__.core.invoke('read_import_file', { path });
            const bytes = Uint8Array.from(atob(imported.dataBase64), character => character.charCodeAt(0));
            files.push(new File([bytes], imported.name));
          }
          await onFiles(files);
        } catch (error) { onError(error); }
      });
    },
    async save(blob, name) {
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      const result = await window.__TAURI__.core.invoke('save_export', { name, dataBase64 });
      return result !== null;
    }
  };
}
