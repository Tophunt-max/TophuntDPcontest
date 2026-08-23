
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          // The preset enables @babel/plugin-proposal-decorators itself, but as
          // part of the *preset*, which Babel runs AFTER plugins — so we cannot
          // get `transform-class-properties` to run after it. We therefore turn
          // the preset's copy off and order both transforms ourselves below.
          decorators: false,
        },
      ],
    ],
    plugins: [
      // ---------------------------------------------------------------------
      // WatermelonDB model decorators (src/database/models/*).
      //
      // These two MUST stay in this order. Legacy decorators emit an
      // `_applyDecoratedDescriptor` call plus a per-instance initializer, and
      // `transform-class-properties` in LOOSE mode is what turns that
      // initializer into a no-op `_initializerDefineProperty`. Without loose
      // class properties running after the decorators transform, Babel emits
      // `_initializerWarningHelper`, which throws
      //   "Decorating class property failed..."
      // the first time any model is instantiated. src/database is imported from
      // app/_layout.tsx, so that would break app start on every platform.
      //
      // Keep in sync with "experimentalDecorators" in tsconfig.json.
      ['@babel/plugin-proposal-decorators', { legacy: true }],
      ['@babel/plugin-transform-class-properties', { loose: true }],
      [
        'module-resolver',
        {
          root: ['./'],
          alias: {
            '@': './',
          },
        },
      ],
    ],
  };
};
