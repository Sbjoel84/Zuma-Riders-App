// Expo's default Metro config detects the pnpm workspace and watches packages/*.
// ZUMA_WEB_PREVIEW=1 builds a browser preview with native-only modules replaced by stand-ins.
if (process.env.ZUMA_WEB_PREVIEW) module.exports = require("../../web-preview/shims/metro.preview.js")(__dirname);
else {
  const { getDefaultConfig } = require("expo/metro-config");
  module.exports = getDefaultConfig(__dirname);
}
