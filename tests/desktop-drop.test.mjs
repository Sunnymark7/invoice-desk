import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('native window drops become local File objects and cancelled drags import nothing', async () => {
  let handleDrop;
  const invoked = [];
  const context = vm.createContext({ File, Uint8Array, atob,
    window: { __TAURI__: {
      core: { invoke: async (command, args) => { invoked.push({ command, args }); return { name: args.path.split('/').at(-1), dataBase64: btoa('%PDF-test') }; } },
      webview: { getCurrentWebview: () => ({ onDragDropEvent: async handler => { handleDrop = handler; return () => {}; } }) }
    } }
  });
  vm.runInContext(fs.readFileSync(new URL('../dist/desktop.js', import.meta.url), 'utf8'), context);
  const batches = [], hovered = [];
  await context.window.invoiceDesktop.onFilesDropped(files => batches.push(files), active => hovered.push(active), error => { throw error; });
  await handleDrop({ payload: { type: 'enter', paths: ['/test/a.pdf'] } });
  await handleDrop({ payload: { type: 'leave' } });
  assert.equal(batches.length, 0);
  await handleDrop({ payload: { type: 'drop', paths: ['/test/a.pdf', '/test/b.pdf'] } });
  assert.equal(batches.length, 1);
  assert.deepEqual(Array.from(batches[0], file => file.name), ['a.pdf', 'b.pdf']);
  assert.equal(await batches[0][0].text(), '%PDF-test');
  assert.ok(invoked.every(call => call.command === 'read_import_file'));
  assert.deepEqual(hovered, [true, false, false]);
});
