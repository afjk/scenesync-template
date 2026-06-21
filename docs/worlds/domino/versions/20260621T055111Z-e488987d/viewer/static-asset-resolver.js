export function createStaticAssetResolver() {
  return {
    resolveAsset(asset) {
      if (!asset) return null;
      return asset.path || asset.url || null;
    },
  };
}
