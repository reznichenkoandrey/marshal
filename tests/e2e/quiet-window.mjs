// Keeps an e2e run out of the owner's way: no Dock icon, no focus taken, and every test
// window fully transparent and click-through. The page still renders and gets animation
// frames, and capturePage still sees it. MARSHAL_E2E_VISIBLE=1 shows the windows as before.

const visible = process.env.MARSHAL_E2E_VISIBLE === "1";

/** Call before app.whenReady(). */
export function quietApp(app) {
  if (visible) return;
  // A window under other windows would otherwise lose its frames like a hidden one.
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.whenReady().then(() => app.dock?.hide());
}

/** Show a test window created with `show: false`, without stealing focus. */
export function showQuietly(win) {
  if (visible) {
    win.show();
    return;
  }
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.showInactive();
}
