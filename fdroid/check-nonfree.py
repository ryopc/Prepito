#!/usr/bin/env python3
"""F-Droid の NonFree 判定を再現する検証スクリプト。

`gradle :app:dependencies --configuration releaseRuntimeClasspath` の出力を読み取り、
fdroidserver（scanner.py の KnownNonFree 辞書にある gradle_signatures）と同等の
パターンで NonFree な依存を検出する。

F-Droid のソーススキャンは NonFree な Gradle 依存を検出するとビルドを失敗させるため、
このスクリプトを CI で実行して公開前に検知する。

使い方:
    gradle :app:dependencies --configuration releaseRuntimeClasspath > deps.txt
    python3 fdroid/check-nonfree.py deps.txt
"""

from __future__ import annotations

import re
import sys

# fdroidserver の scanner.py にある KnownNonFree .gradle_signatures 相当
# （2026-10 時点 / https://gitlab.com/fdroid/fdroidserver/-/blob/master/fdroidserver/scanner.py）
NONFREE_GRADLE_SIGNATURES: list[str] = [
    "androidx.core:core-google-shortcuts"
    "androidx.credentials:credentials-play-services-auth"
    "androidx.media3:media3-cast"
    "androidx.media3:media3-datasource-cronet"
    "androidx.media3:media3-exoplayer-ima"
    "androidx.navigation:navigation-dynamic-features"
    "androidx.wear:wear-remote-interactions"
    "androidx.work:work-gcm"
    "com.amazonaws:DynamoDBLocal"
    "com.amazonaws:amazon-kinesis-aggregator"
    "com.amazonaws:amazon-kinesis-connectors"
    "com.amazonaws:amazon-kinesis-deaggregator"
    "com.amazonaws:aws-android-sdk-apigateway-core"
    "com.amazonaws:aws-android-sdk-auth-core"
    "com.amazonaws:aws-android-sdk-auth-facebook"
    "com.amazonaws:aws-android-sdk-auth-google"
    "com.amazonaws:aws-android-sdk-auth-ui"
    "com.amazonaws:aws-android-sdk-auth-userpools"
    "com.amazonaws:aws-android-sdk-cognito"
    "com.amazonaws:aws-android-sdk-cognitoauth"
    "com.amazonaws:aws-android-sdk-cognitoidentityprovider-asf"
    "com.amazonaws:aws-android-sdk-comprehend"
    "com.amazonaws:aws-android-sdk-core"
    "com.amazonaws:aws-android-sdk-ddb"
    "com.amazonaws:aws-android-sdk-ddb-document"
    "com.amazonaws:aws-android-sdk-iot"
    "com.amazonaws:aws-android-sdk-kinesis"
    "com.amazonaws:aws-android-sdk-kinesisvideo"
    "com.amazonaws:aws-android-sdk-kinesisvideo-archivedmedia"
    "com.amazonaws:aws-android-sdk-kms"
    "com.amazonaws:aws-android-sdk-lambda"
    "com.amazonaws:aws-android-sdk-lex"
    "com.amazonaws:aws-android-sdk-location"
    "com.amazonaws:aws-android-sdk-logs"
    "com.amazonaws:aws-android-sdk-mobile-client"
    "com.amazonaws:aws-android-sdk-mobileanalytics"
    "com.amazonaws:aws-android-sdk-pinpoint"
    "com.amazonaws:aws-android-sdk-polly"
    "com.amazonaws:aws-android-sdk-rekognition"
    "com.amazonaws:aws-android-sdk-s3"
    "com.amazonaws:aws-android-sdk-ses"
    "com.amazonaws:aws-android-sdk-sns"
    "com.amazonaws:aws-android-sdk-sqs"
    "com.amazonaws:aws-android-sdk-textract"
    "com.amazonaws:aws-android-sdk-transcribe"
    "com.amazonaws:aws-android-sdk-translate"
    "com.amazonaws:dynamodb-key-diagnostics-library"
    "com.amazonaws:dynamodb-lock-client"
    "com.amazonaws:ivs-broadcast"
    "com.amazonaws:ivs-player"
    "com.amazonaws:kinesis-storm-spout"
    "com.android.billingclient"
    "com.android.installreferrer"
    "com.anjlab.android.iab.v3:library"
    "com.baidu.mobstat"
    "com.bugsense"
    "com.cloudrail"
    "com.crittercism"
    "com.evernote:android-job"
    "com.facebook.android"
    "com.flurry.android"
    "com.garmin.connectiq:ciq-companion-app-sdk"
    "com.geetest"
    "com.github.SanojPunchihewa:InAppUpdater"
    "com.github.junrar:junrar"
    "com.github.omicronapps:7-Zip-JBinding-4Android"
    "com.github.penn5:donations"
    "com.github.uccmawei:FingerprintIdentify"
    "com.google.ads"
    "com.google.android.exoplayer:extension-cast"
    "com.google.android.exoplayer:extension-cronet"
    "com.google.android.exoplayer:extension-ima"
    "com.google.android.gms(?!.(oss-licenses-plugin|strict-version-matcher-plugin))"
    "com.google.android.libraries(?!.mapsplatform.secrets-gradle-plugin)"
    "com.google.android.play:app-update"
    "com.google.android.play:asset-delivery"
    "com.google.android.play:core.*"
    "com.google.android.play:feature-delivery"
    "com.google.android.play:review"
    "com.google.android.support:wearable"
    "com.google.android.ump"
    "com.google.android.wearable:wearable"
    "com.google.androidbrowserhelper:billing"
    "com.google.mlkit"
    "com.hypertrack(?!:hyperlog)"
    "com.onesignal:OneSignal"
    "com.paypal"
    "com.revenuecat.purchases"
    "com.suddenh4x.ratingdialog:awesome-app-rating"
    "com.tencent.bugly"
    "com.umeng"
    "com.wei.android.lib:fingerprintidentify"
    "com\\.yandex\\.android(?!:authsdk)"
    "crashlytics"
    "io.github.g00fy2.quickie"
    "io.github.sinaweibosdk"
    "io.objectbox:objectbox-gradle-plugin"
    "me.proton.core:payment-iap"
    "me.pushy"
    "org.gradle.toolchains.foojay-resolver"
]

# 上記以外の代表的な NonFree 群（Firebase / MEA / 広告 SDK など）
EXTRA_NONFREE = [
    # Firebase（fdroidserver の実パターン: firebase-jobdispatcher / geofire-java は除外）
    r"com(\.google)?\.firebase[.:](?!firebase-jobdispatcher|geofire-java)",
    # Facebook SDK（React Native 本体の com.facebook.react は FOSS なので含めない）
    "com.facebook.android",
    "com.facebook.ads",
    # Google Play Services の別表記
    "play-services",
    "com.android.billingclient",
    "com.android.installreferrer",
]

# 解析・計測・クラッシュ報告 SDK。
# fdroidserver の KnownNonFree には含まれないが、F-Droid のレビュアが
# Anti-Feature「Tracking」として指摘しうるため警告（失敗はしない）として検出する。
ADVISORY_NONFREE = [
    "com.mixpanel",
    "com.segment",
    "com.amplitude",
    "com.appsflyer",
    "com.adjust",
    "com.branch",
    "io.branch",
    "com.sentry",
    "io.sentry",
    "com.crashlytics",
]

# `group:artifact:version` 形式の依存行
DEP_LINE = re.compile(r"^[|\s+\\-]*[+\\]---\s+([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([A-Za-z0-9_.+\-]+)")
# `group:artifact` のみ（バージョンなし）で現れる依存行
DEP_LINE_NO_VERSION = re.compile(r"^[|\s+\\-]*[+\\]---\s+([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)\s*$")


def extract_dependencies(text: str) -> set[str]:
    """Gradle 依存グラフから 'group:artifact' を抽出する。"""
    deps: set[str] = set()
    for line in text.splitlines():
        m = DEP_LINE.match(line) or DEP_LINE_NO_VERSION.match(line)
        if not m:
            continue
        group, artifact = m.group(1), m.group(2)
        # project :foo 形式はGradle 内部依存なので対象外
        if group == "project" or artifact.startswith(":"):
            continue
        deps.add(f"{group}:{artifact}")
    return deps


def find_violations(deps: set[str]) -> list[tuple[str, str]]:
    """NonFree な依存と、その該当パターンを返す。"""
    violations: list[tuple[str, str]] = []
    for dep in sorted(deps):
        for pattern in NONFREE_GRADLE_SIGNATURES + EXTRA_NONFREE:
            try:
                if re.search(pattern, dep):
                    violations.append((dep, pattern))
                    break
            except re.error:
                if pattern in dep:
                    violations.append((dep, pattern))
                    break
    return violations


def find_advisories(deps: set[str]) -> list[tuple[str, str]]:
    """レビュア注意喚起用の解析・計測 SDK を返す（失敗はしない）。"""
    found: list[tuple[str, str]] = []
    for dep in sorted(deps):
        for pattern in ADVISORY_NONFREE:
            if pattern in dep:
                found.append((dep, pattern))
                break
    return found


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("使い方: check-nonfree.py <gradle dependencies の出力ファイル>", file=sys.stderr)
        return 2

    with open(argv[1], encoding="utf-8", errors="replace") as fh:
        text = fh.read()

    deps = extract_dependencies(text)
    if not deps:
        print("::error::依存を抽出できませんでした（gradle dependencies の出力を確認してください）", file=sys.stderr)
        return 1

    violations = find_violations(deps)
    advisories = find_advisories(deps)
    print(f"検査した外部依存: {len(deps)} 件")

    for dep, pattern in advisories:
        print(f"::warning::解析・計測 SDK の可能性があります: {dep}  (パターン: {pattern})")

    if violations:
        print("::error::F-Droid の NonFree 判定に該当する依存があります", file=sys.stderr)
        for dep, pattern in violations:
            print(f"  - {dep}  (パターン: {pattern})", file=sys.stderr)
        return 1

    print("OK: NonFree な依存は検出されませんでした")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
