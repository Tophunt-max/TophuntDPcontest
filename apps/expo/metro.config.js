const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

// Font-free SVG icon shim (see src/lib/icons.tsx). We alias @expo/vector-icons
// to it so every icon in the app renders as SVG (works on web/Android/iOS with
// no icon-font loading) without touching any of the ~35 files that import it.
const ICON_SHIM = path.resolve(__dirname, "src/lib/icons.tsx");

module.exports = (() => {
  const config = getDefaultConfig(__dirname);

  const { transformer, resolver } = config;

  config.transformer = {
    ...transformer,
    babelTransformerPath: require.resolve("react-native-svg-transformer"),
  };

  const baseResolveRequest = resolver.resolveRequest;
  config.resolver = {
    ...resolver,
    assetExts: resolver.assetExts.filter((ext) => ext !== "svg"),
    sourceExts: [...resolver.sourceExts, "svg"],
    resolveRequest: (context, moduleName, platform) => {
      // Redirect @expo/vector-icons (and its per-family subpaths) to our SVG shim.
      if (moduleName === "@expo/vector-icons" || moduleName.startsWith("@expo/vector-icons/")) {
        return { type: "sourceFile", filePath: ICON_SHIM };
      }
      return (baseResolveRequest || context.resolveRequest)(context, moduleName, platform);
    },
  };

  return config;
})();
