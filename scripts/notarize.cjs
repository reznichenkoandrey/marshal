const path = require("node:path");
const { notarize } = require("@electron/notarize");

module.exports = async function notarizeMarshal(context) {
  if (process.platform !== "darwin") return;

  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  const appBundleId = packager.appInfo.id;
  const appName = `${packager.appInfo.productFilename}.app`;
  const appPath = path.join(appOutDir, appName);

  if (!appleId || !appleIdPassword || !teamId) {
    console.warn("[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set; skipping notarization.");
    return;
  }

  console.log(`[notarize] submitting ${appPath} (${appBundleId})`);
  await notarize({
    appBundleId,
    appPath,
    appleId,
    appleIdPassword,
    teamId
  });
  console.log("[notarize] notarization complete");
};
