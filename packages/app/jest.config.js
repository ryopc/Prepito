/**
 * Jest Configuration
 *
 * Expo (React Native) 環境のテスト設定。
 * テストが未作成の段階でも CI が失敗しないよう passWithNoTests を有効化。
 */

const path = require('path');

const expoPreset = require('jest-expo/jest-preset');

/**
 * babel-preset-expo は expo パッケージの依存としてのみ存在するため、
 * expo から解決する (pnpm の厳格な node_modules レイアウト対策)。
 */
const babelPresetExpo = require.resolve('babel-preset-expo', {
  paths: [path.dirname(require.resolve('expo/package.json'))],
});

/**
 * transform してよい node_modules パッケージの allow list。
 *
 * pnpm の node_modules レイアウト
 *   node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/...
 * に対応するため、allow list の前段には任意の階層を許す。
 */
const TRANSFORMABLE_PACKAGES = [
  '(jest-)?react-native',
  '@react-native(-community)?',
  'expo(nent)?',
  'expo-[^/]+',
  '@expo(nent)?/[^/]+',
  '@expo-google-fonts/[^/]+',
  'react-navigation',
  '@react-navigation/[^/]+',
  '@unimodules/[^/]+',
  'unimodules',
  'sentry-expo',
  'native-base',
  'react-native-svg',
  // 純 TS 実装の暗号ライブラリ (ESM のみのため transform が必要)
  '@noble/[^/]+',
].join('|');

module.exports = {
  ...expoPreset,
  preset: 'jest-expo',
  passWithNoTests: true,
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
  transform: {
    '\\.[jt]sx?$': [
      'babel-jest',
      {
        presets: [babelPresetExpo],
        caller: { name: 'metro', bundler: 'metro', platform: 'ios' },
      },
    ],
  },
  transformIgnorePatterns: [
    `node_modules/(?!(.*/)?(${TRANSFORMABLE_PACKAGES})/)`,
    '/node_modules/react-native-reanimated/plugin/',
  ],
};
