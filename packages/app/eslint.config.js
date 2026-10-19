module.exports = {
  root: true,
  env: { browser: true, es2022: true, jest: true },
  extends: [
    'expo',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'plugin:prettier/recommended',
    'prettier'
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
    project: ['./tsconfig.json']
  },
  plugins: ['@typescript-eslint', 'react-hooks', 'prettier'],
  settings: {
    react: { version: '18.2' }
  },
  rules: {
    'prettier/prettier': 'error',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    'react/react-in-jsx-scope': 'off'
  },
  ignorePatterns: ['node_modules/', 'dist/', '.expo/', '*.config.*', 'expo-env.d.ts']
};