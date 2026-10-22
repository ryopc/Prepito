/**
 * ESLint Flat Config
 *
 * ESLint v8.57 以降の flat config モード / ESLint v9 互換。
 * 旧形式 (eslintrc) の拡張は FlatCompat で読み込む。
 *
 * 個別パッケージに eslint.config.js を置かないこと。
 * （旧形式ファイルが flat config として読み込まれ `root` キーで起動時エラーになる）
 */

const { FlatCompat } = require('@eslint/eslintrc');
const js = require('@eslint/js');

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

const TS_FILES = ['**/*.ts', '**/*.tsx'];

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/eslint.config.js',
      '**/*.config.js',
      '**/jest.setup.*',
      '**/expo-env.d.ts',
    ],
  },

  // 基本ルール（JS / TS 共通）
  ...compat.extends('eslint:recommended'),

  // Prettier 連携（整形差分を Lint エラーとして扱う）
  ...compat.extends('plugin:prettier/recommended'),

  // TypeScript
  ...compat.extends('plugin:@typescript-eslint/recommended'),

  // Expo / React（アプリ側の TS / TSX のみ）
  ...compat.extends('eslint-config-expo').map((config) => ({ ...config, files: TS_FILES })),

  {
    files: TS_FILES,
    languageOptions: {
      parser: require('@typescript-eslint/parser'),
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': require('@typescript-eslint/eslint-plugin'),
    },
    rules: {
      'prettier/prettier': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'react-hooks/exhaustive-deps': 'warn',
      'react/react-in-jsx-scope': 'off',
      // TypeScript では型で Props を検証するため propTypes 不要
      'react/prop-types': 'off',
      // モジュール解決・named export の検証は tsc が担保する（パスエイリアス誤検出防止）
      'import/no-unresolved': 'off',
      'import/named': 'off',
      'import/namespace': 'off',
    },
  },

  // Expo config plugin（Node が require で読み込むため CommonJS 前提）
  {
    files: ['**/plugins/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        // config plugin は Node 上で実行されるため環境変数を参照する
        // （署名設定の読み取りなど）
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Node スクリプト（暗号相互運用テスト・実サーバ疎通確認など。React Native ランタイム外で実行する）
  {
    files: ['**/scripts/**/*.{js,cjs,mjs}'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        // Node 18 以降のグローバル（実サーバとの疎通確認で使用する）
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },
];
