const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

/**
 * 使用する Gradle のバージョン。
 *
 * Expo SDK 51 のテンプレート (`expo-template-bare-minimum@sdk-51`) は dist-tag が
 * 可変で、51.0.32 以降で Gradle 8.8 へ bump された。しかし:
 *
 *   - Gradle 8.8 で `Jar.classifier` (expo-task-manager) と
 *     `SoftwareComponentContainer.release` (expo-modules-core) が削除されている
 *   - `expo-modules-core@1.12.26` は 1.12.x の最終版であり、8.8 対応版が存在しない
 *
 * 結果としてテンプレートを無加工で使うと
 *   `Could not set unknown property 'classifier' ...`
 *   `Could not get unknown property 'release' ...`
 * でビルドが失敗する。
 *
 * `expo-modules-core@1.12.x` と整合する検証済みバージョンは 8.6 なので、
 * prebuild 後に gradle-wrapper.properties を 8.6 に固定する。
 * これによりテンプレートの dist-tag 変動にもビルド結果が影響されなくなる。
 */
const GRADLE_VERSION = '8.6';

/**
 * `android/gradle/wrapper/gradle-wrapper.properties` の distributionUrl を書き換える。
 *
 * @param {import('expo/config-plugins').ExpoConfig} config
 * @param {{ gradleVersion?: string }} [props]
 * @returns {import('expo/config-plugins').ExpoConfig}
 */
function withGradleVersion(config, props) {
  const gradleVersion = (props && props.gradleVersion) || GRADLE_VERSION;

  return withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const projectRoot = modConfig.modRequest.platformProjectRoot;
      if (!projectRoot) {
        return modConfig;
      }

      const wrapperPath = path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');
      if (!fs.existsSync(wrapperPath)) {
        return modConfig;
      }

      const original = fs.readFileSync(wrapperPath, 'utf8');
      const patched = original.replace(
        /gradle-[0-9]+(?:\.[0-9]+)*-(all|bin)\.zip/,
        `gradle-${gradleVersion}-$1.zip`
      );

      if (patched !== original) {
        fs.writeFileSync(wrapperPath, patched);
      }

      return modConfig;
    },
  ]);
}

module.exports = withGradleVersion;
