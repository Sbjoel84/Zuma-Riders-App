// Metro config for the browser preview only: swaps native-only modules for the shims in this folder.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
module.exports = (appDir) => {
  const config = getDefaultConfig(appDir);
  const shims = { "react-native-maps": "react-native-maps.tsx", "expo-secure-store": "expo-secure-store.ts", "expo-task-manager": "expo-task-manager.ts", "expo-location": "expo-location.ts", "expo-notifications": "expo-notifications.ts" };
  config.watchFolders = [...(config.watchFolders ?? []), __dirname];
  const prev = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (ctx, name, platform) => {
    if (platform === "web" && shims[name]) return { type: "sourceFile", filePath: path.join(__dirname, shims[name]) };
    return prev ? prev(ctx, name, platform) : ctx.resolveRequest(ctx, name, platform);
  };
  return config;
};
