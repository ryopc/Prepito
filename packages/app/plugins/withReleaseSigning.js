const path = require('path');
/**
 * 環境変数は `require('process')` から取得する。
 *
 * プラグイン（plugins ディレクトリ）向けの ESLint 設定では `process` が
 * グローバルとして宣言されていないため、`process.env` を直接参照すると
 * `no-undef` エラーになる。Node 標準モジュールを require することで
 * 同じ値を取得しつつ、Lint を通せるようにする。
 */
const { env } = require('process');
const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * 署名モードの識別子。
 *
 * - `unsigned`: すべての署名指定を除去し、未署名 APK（F-Droid 用）にする
 * - `release` : リリース keystore で署名する（GitHub Release 用）
 */
const MODE_UNSIGNED = 'unsigned';
const MODE_RELEASE = 'release';

/**
 * 環境変数名。
 *
 * これらの値は CI 側で設定する前提のため、リポジトリには含めない。
 */
const ENV_MODE = 'PREPITO_SIGNING_MODE';
const ENV_KEYSTORE_FILE = 'PREPITO_KEYSTORE_FILE';
const ENV_KEYSTORE_PASSWORD = 'PREPITO_KEYSTORE_PASSWORD';
const ENV_KEY_ALIAS = 'PREPITO_KEY_ALIAS';
const ENV_KEY_PASSWORD = 'PREPITO_KEY_PASSWORD';

/**
 * `signingConfig` プロパティへの代入行を判定する正規表現。
 *
 * `signingConfigs {`（ブロック定義行）は `signingConfig` の直後が `s` であり
 * 空白ではないためマッチしない。よって `signingConfigs` ブロックそのものと、
 * ブロック内の `storeFile` / `storePassword` / `keyAlias` / `keyPassword` は
 * 影響を受けない。
 *
 * F-Droid レシピの `sed -i -e '/signingConfig /d'` と同じ行を消すことになるが、
 * 本プラグインは対象を `buildTypes` ブロックに限定している（Groovy の
 * `signingConfigs` ブロックは署名情報の定義場所であり、除去してはいけない）。
 */
const SIGNING_CONFIG_ASSIGNMENT = /^\s*signingConfig\s+/;

/**
 * Groovy の文字列リテラルとコメントを空白にマスクした文字列を返す。
 *
 * 目的:
 *   1. 波括弧 `{` / `}` の対応を追跡する際に、コメントや文字列の中に
 *      含まれる波括弧を数えてはいけない
 *   2. `signingConfig` 行の判定でコメント中の文字列を誤検出しない
 *
 * マスク後の文字列は元と長さが同じで、改行位置も保たれるため、
 * 行単位の添字をそのまま利用できる。
 *
 * @param {string} contents
 * @returns {string}
 */
function maskNonCode(contents) {
  const chars = contents.split('');
  const length = contents.length;

  /**
   * [from, to) の範囲を空白にマスクする（改行は残す）。
   *
   * @param {number} from
   * @param {number} to
   */
  const maskRange = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (chars[i] !== '\n') {
        chars[i] = ' ';
      }
    }
  };

  let i = 0;
  while (i < length) {
    const char = contents[i];
    const next = contents[i + 1];
    const next2 = contents[i + 2];

    // 行コメント `//` ... 改行
    if (char === '/' && next === '/') {
      const lineEnd = contents.indexOf('\n', i);
      const stop = lineEnd === -1 ? length : lineEnd;
      maskRange(i, stop);
      i = stop;
      continue;
    }

    // ブロックコメント `/*` ... `*/`
    if (char === '/' && next === '*') {
      const commentEnd = contents.indexOf('*/', i + 2);
      const stop = commentEnd === -1 ? length : commentEnd + 2;
      maskRange(i, stop);
      i = stop;
      continue;
    }

    // トリプル引用文字列 `'''` / `"""`
    if (
      (char === "'" && next === "'" && next2 === "'") ||
      (char === '"' && next === '"' && next2 === '"')
    ) {
      const delimiter = char + next + next2;
      let j = i + 3;
      while (j < length) {
        if (contents[j] === '\\') {
          j += 2;
          continue;
        }
        if (contents.startsWith(delimiter, j)) {
          j += 3;
          break;
        }
        j += 1;
      }
      const stop = Math.min(j, length);
      maskRange(i, stop);
      i = stop;
      continue;
    }

    // 単一引用文字列 / 二重引用文字列
    if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < length) {
        if (contents[j] === '\\') {
          j += 2;
          continue;
        }
        if (contents[j] === char) {
          j += 1;
          break;
        }
        // 閉じ引用符のない文字列は改行で打ち切る（Groovy のエラー相当）
        if (contents[j] === '\n') {
          break;
        }
        j += 1;
      }
      const stop = Math.min(j, length);
      maskRange(i, stop);
      i = stop;
      continue;
    }

    i += 1;
  }

  return chars.join('');
}

/**
 * 正規表現メタ文字をエスケープする。
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 行の先頭のインデント（空白のみ）を返す。
 *
 * @param {string} line
 * @returns {string}
 */
function getIndent(line) {
  const matched = line.match(/^[ \t]*/);
  return matched ? matched[0] : '';
}

/**
 * 指定した行から始まるブロックの閉じ括弧の行番号を返す。
 *
 * 波括弧の深さはマスク済みテキストで数えるため、コメントや文字列中の
 * 波括弧は影響しない。ブロックが 1 行で閉じている場合は開始行を返す。
 *
 * @param {string[]} maskedLines
 * @param {number} startIndex
 * @returns {number} 閉じ括弧の行番号。見つからない場合は -1
 */
function findBlockEnd(maskedLines, startIndex) {
  let depth = 0;

  for (let i = startIndex; i < maskedLines.length; i += 1) {
    for (const char of maskedLines[i]) {
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      }
    }
    if (depth < 0) {
      return -1;
    }
    if (depth === 0) {
      return i;
    }
  }

  return -1;
}

/**
 * 指定した名前のブロックを探し、行番号の範囲を返す。
 *
 * ブロック定義行は行頭（インデントを除く）に `名前 {` と書くことを前提とする。
 * この条件により `signingConfigs {` と `signingConfigs.release {` のような
 * 区別が確実になり、名前が同一のブロックが複数ある場合はエラーとする
 * （対象を 1 つに特定できないため）。
 *
 * @param {string[]} maskedLines
 * @param {string} name
 * @param {{ from?: number, to?: number }} [range] 探索範囲（行番号・両端を含む）
 * @returns {{ start: number, end: number } | null}
 */
function findBlock(maskedLines, name, range) {
  const from = range && typeof range.from === 'number' ? range.from : 0;
  const to = range && typeof range.to === 'number' ? range.to : maskedLines.length - 1;
  const pattern = new RegExp(`^${escapeRegExp(name)}\\s*\\{`);

  const starts = [];
  for (let i = from; i <= to && i < maskedLines.length; i += 1) {
    if (pattern.test(maskedLines[i].trim())) {
      starts.push(i);
    }
  }

  if (starts.length === 0) {
    return null;
  }
  if (starts.length > 1) {
    throw new Error(
      `[withReleaseSigning] build.gradle 内に \`${name} {\` が ${starts.length} 箇所あります。対象を 1 つに特定できません。`
    );
  }

  const start = starts[0];
  const end = findBlockEnd(maskedLines, start);
  if (end < 0) {
    throw new Error(
      `[withReleaseSigning] build.gradle 内の \`${name} {\` ブロックの閉じ括弧が見つかりません。`
    );
  }

  return { start, end };
}

/**
 * ブロックの子の要素のインデントを推測する。
 *
 * ブロック内の最初の有効な行のインデントを返す。ブロックが空の場合は
 * ブロック定義行のインデント + 4 スペースをフォールバックとして使う
 * （Expo テンプレートのインデント幅が 4 スペースであることを前提にする）。
 *
 * @param {string[]} maskedLines
 * @param {{ start: number, end: number }} block
 * @param {string[]} lines
 * @returns {string}
 */
function detectChildIndent(maskedLines, block, lines) {
  for (let i = block.start + 1; i < block.end; i += 1) {
    if (maskedLines[i].trim() === '') {
      continue;
    }
    return getIndent(lines[i]);
  }
  return `${getIndent(lines[block.start])}    `;
}

/**
 * Groovy の単一引用文字列としてクォートする。
 *
 * パスワードやパスに `'` が含まれる場合、そのままクォートすると構文が壊れるため
 * Groovy のエスケープ規則（`\\` と `\'`）を適用する。
 *
 * @param {string} value
 * @returns {string}
 */
function groovySingleQuoted(value) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/**
 * `signingConfigs` ブロックに挿入する `release` エントリの行を組み立てる。
 *
 * @param {string} entryIndent `release {` のインデント
 * @param {string} innerIndent 署名の各プロパティのインデント
 * @param {{ keystoreFile: string, keystorePassword: string, keyAlias: string, keyPassword: string }} values
 * @returns {string[]}
 */
function buildReleaseSigningEntry(entryIndent, innerIndent, values) {
  return [
    `${entryIndent}release {`,
    `${innerIndent}storeFile file(${groovySingleQuoted(values.keystoreFile)})`,
    `${innerIndent}storePassword ${groovySingleQuoted(values.keystorePassword)}`,
    `${innerIndent}keyAlias ${groovySingleQuoted(values.keyAlias)}`,
    `${innerIndent}keyPassword ${groovySingleQuoted(values.keyPassword)}`,
    `${entryIndent}}`,
  ];
}

/**
 * `unsigned` モード: `buildTypes` 内の署名指定をすべて除去する。
 *
 * 対象は `buildTypes` ブロック内に限定し、`signingConfigs` ブロックは
 * そのまま残す（署名の定義そのものを消すと `signingConfigs.debug` を参照する
 * 箇所が壊れるため）。
 *
 * @param {string} contents
 * @returns {string}
 */
function removeSigningConfigFromBuildTypes(contents) {
  const lines = contents.split('\n');
  const maskedLines = maskNonCode(contents).split('\n');

  const buildTypes = findBlock(maskedLines, 'buildTypes');
  if (!buildTypes) {
    throw new Error(
      '[withReleaseSigning] build.gradle に `buildTypes {` ブロックが見つかりません。'
    );
  }

  const removed = [];
  for (let i = buildTypes.start + 1; i < buildTypes.end; i += 1) {
    if (SIGNING_CONFIG_ASSIGNMENT.test(maskedLines[i])) {
      removed.push(i);
    }
  }

  // 後ろから消すことで残りの行番号がずれないようにする
  for (const index of removed.slice().reverse()) {
    lines.splice(index, 1);
  }

  return lines.join('\n');
}

/**
 * `release` モード (1): `signingConfigs` ブロックに `release` エントリを追加する。
 *
 * すでに `release` エントリがある場合は置き換える（冪等性の担保）。
 *
 * @param {string} contents
 * @param {{ keystoreFile: string, keystorePassword: string, keyAlias: string, keyPassword: string }} values
 * @returns {string}
 */
function insertReleaseSigningConfig(contents, values) {
  const lines = contents.split('\n');
  const maskedLines = maskNonCode(contents).split('\n');

  const signingConfigs = findBlock(maskedLines, 'signingConfigs');
  if (!signingConfigs) {
    throw new Error(
      '[withReleaseSigning] build.gradle に `signingConfigs {` ブロックが見つかりません。'
    );
  }

  const entryIndent = detectChildIndent(maskedLines, signingConfigs, lines);
  const innerIndent = `${entryIndent}    `;
  const entryLines = buildReleaseSigningEntry(entryIndent, innerIndent, values);

  // `signingConfigs` ブロック内の `release` エントリ（同一名のブロック）を探す
  const existing = findBlock(maskedLines, 'release', {
    from: signingConfigs.start + 1,
    to: signingConfigs.end - 1,
  });

  if (existing) {
    lines.splice(existing.start, existing.end - existing.start + 1, ...entryLines);
  } else {
    // 閉じ括弧の直前に挿入する
    lines.splice(signingConfigs.end, 0, ...entryLines);
  }

  return lines.join('\n');
}

/**
 * `release` モード (2): `buildTypes` の `release` ブロックに署名指定を追加する。
 *
 * `debug` ブロックは debug 用の署名のまま残すため、対象は `buildTypes` 内の
 * `release` という名前のブロックだけに限る。Groovy には同名のブロックが
 * 存在しうるため、名前だけでなく波括弧の深さで特定する。
 *
 * @param {string} contents
 * @returns {string}
 */
function applyReleaseSigningConfigToBuildType(contents) {
  const lines = contents.split('\n');
  const maskedLines = maskNonCode(contents).split('\n');

  const buildTypes = findBlock(maskedLines, 'buildTypes');
  if (!buildTypes) {
    throw new Error(
      '[withReleaseSigning] build.gradle に `buildTypes {` ブロックが見つかりません。'
    );
  }

  const releaseBlock = findBlock(maskedLines, 'release', {
    from: buildTypes.start + 1,
    to: buildTypes.end - 1,
  });
  if (!releaseBlock) {
    throw new Error(
      '[withReleaseSigning] `buildTypes {` 内に `release {` ブロックが見つかりません。'
    );
  }

  // 既存の `signingConfig` 指定を探す（削除と差し戻し位置の決定に使う）
  const removed = [];
  for (let i = releaseBlock.start + 1; i < releaseBlock.end; i += 1) {
    if (SIGNING_CONFIG_ASSIGNMENT.test(maskedLines[i])) {
      removed.push(i);
    }
  }

  let insertIndex = releaseBlock.start + 1;
  let insertIndent = `${getIndent(lines[releaseBlock.start])}    `;
  if (removed.length > 0) {
    // 元の `signingConfig` 行の位置を保ちつつ中身だけ差し替える
    insertIndex = removed[0];
    insertIndent = getIndent(lines[removed[0]]);
  }

  for (const index of removed.slice().reverse()) {
    lines.splice(index, 1);
  }
  lines.splice(insertIndex, 0, `${insertIndent}signingConfig signingConfigs.release`);

  return lines.join('\n');
}

/**
 * 設定値として妥当な文字列かを確認する。
 *
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
function requireValue(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `[withReleaseSigning] ${name} が設定されていません。` +
        `署名モード \`release\` を使用するには keystore 関連の情報一式が必要です。`
    );
  }
  return value;
}

/**
 * 署名モードとキーストア情報を環境変数 / props から解決する。
 *
 * props が優先される（明示指定があれば環境変数より強い）。
 *
 * @param {{ mode?: string, keystoreFile?: string, keystorePassword?: string, keyAlias?: string, keyPassword?: string }} [props]
 * @returns {{ mode: string | undefined, values: object | null }}
 */
function resolveSigningConfig(props) {
  const options = props || {};
  const mode = options.mode !== undefined ? options.mode : env[ENV_MODE];

  if (mode === undefined || mode === null || mode === '') {
    // 未指定なら何もしない（prebuild 既定の debug 署名のまま）
    return { mode: undefined, values: null };
  }

  if (mode !== MODE_UNSIGNED && mode !== MODE_RELEASE) {
    throw new Error(
      `[withReleaseSigning] ${ENV_MODE} の値が不正です: "${mode}"。` +
        `使用できるのは "${MODE_UNSIGNED}" / "${MODE_RELEASE}" です。`
    );
  }

  if (mode === MODE_UNSIGNED) {
    return { mode, values: null };
  }

  const values = {
    keystoreFile: requireValue(
      ENV_KEYSTORE_FILE,
      options.keystoreFile !== undefined ? options.keystoreFile : env[ENV_KEYSTORE_FILE]
    ),
    keystorePassword: requireValue(
      ENV_KEYSTORE_PASSWORD,
      options.keystorePassword !== undefined ? options.keystorePassword : env[ENV_KEYSTORE_PASSWORD]
    ),
    keyAlias: requireValue(
      ENV_KEY_ALIAS,
      options.keyAlias !== undefined ? options.keyAlias : env[ENV_KEY_ALIAS]
    ),
    keyPassword: requireValue(
      ENV_KEY_PASSWORD,
      options.keyPassword !== undefined ? options.keyPassword : env[ENV_KEY_PASSWORD]
    ),
  };

  if (!path.isAbsolute(values.keystoreFile)) {
    throw new Error(
      `[withReleaseSigning] ${ENV_KEYSTORE_FILE} は絶対パスである必要があります: "${values.keystoreFile}"`
    );
  }

  return { mode, values };
}

/**
 * `android/app/build.gradle` にリリース署名設定を適用する config plugin。
 *
 * 2 つのモードを持つ:
 *   - `unsigned` : `buildTypes` 内の署名指定をすべて除去し、未署名 APK にする
 *                  （F-Droid は自前で署名するため、unsigned 成果物を要求する）
 *   - `release`  : リリース keystore を使う `signingConfigs.release` を注入し、
 *                  `buildTypes.release` がそれを使うようにする
 *                  （GitHub Release に載せる APK はこれで署名する）
 *
 * モードの指定は環境変数 `PREPITO_SIGNING_MODE` で行い、未指定の場合は
 * 何もしない（prebuild 既定の debug 署名のまま）。
 *
 * なお本 plugin は署名情報の置き場所（ワークスペース内 / 一時ディレクトリ等）を
 * 決めない。キーストアの配置と秘密情報の管理は呼び出し側の責務である。
 *
 * @param {import('expo/config-plugins').ExpoConfig} config
 * @param {{ mode?: string, keystoreFile?: string, keystorePassword?: string, keyAlias?: string, keyPassword?: string }} [props]
 * @returns {import('expo/config-plugins').ExpoConfig}
 */
function withReleaseSigning(config, props) {
  const { mode, values } = resolveSigningConfig(props);

  if (!mode) {
    return config;
  }

  return withAppBuildGradle(config, (modConfig) => {
    const contents = modConfig.modResults.contents;

    const patched =
      mode === MODE_UNSIGNED
        ? removeSigningConfigFromBuildTypes(contents)
        : applyReleaseSigningConfigToBuildType(insertReleaseSigningConfig(contents, values));

    modConfig.modResults.contents = patched;
    return modConfig;
  });
}

module.exports = withReleaseSigning;
