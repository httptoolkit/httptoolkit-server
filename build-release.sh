#!/usr/bin/env bash
set -e

# This script takes a target platform as an argument, and then
# builds the server for that platform - installing the correct
# native-built modules for the platform as appropriate.

# ------------------------------------------------------------------------
# Configure everything for the target platform
# ------------------------------------------------------------------------

TARGET_PLATFORM=$1
TARGET_ARCH=$2

echo "CONFIGURING FOR $TARGET_PLATFORM $TARGET_ARCH"

if [ -z "$TARGET_PLATFORM" ]; then
    echo 'A target platform (linux/win32/darwin) is required'
    exit 1
fi

if [ -z "$TARGET_ARCH" ]; then
    echo 'A target platform (x64/arm/arm64) is required'
    exit 1
fi


export PATH=./node_modules/.bin:$PATH

# Pick the target platform for prebuild-install:
export npm_config_platform=$TARGET_PLATFORM
# Pick the target platform for node-pre-gyp:
export npm_config_target_platform=$TARGET_PLATFORM

# Same for architecture:
export npm_config_arch=$TARGET_ARCH
export npm_config_target_arch=$TARGET_ARCH

# Disable node-gyp-build for win-version-info only. Without this, it's
# rebuilt for Linux, even given $TARGET_PLATFORM=win32, and then breaks
# at runtime even though there are valid win32 prebuilds available.
export WIN_VERSION_INFO=disable-prebuild

TARGET=$TARGET_PLATFORM-$TARGET_ARCH

# ------------------------------------------------------------------------
# Clean the existing build workspace, to keep targets 100% independent
# ------------------------------------------------------------------------

rm -rf ./tmp || true

# ------------------------------------------------------------------------
# Build the package for this platform
# ------------------------------------------------------------------------

echo
echo "BUILDING FOR $TARGET_PLATFORM $TARGET_ARCH"
echo

oclif-dev pack --targets=$TARGET

echo
echo "BUILT"
echo

# ------------------------------------------------------------------------
# Confirm that the installed binaries all support the target platform.
# This is not 100% by any means, but catches obvious mistakes.
# ------------------------------------------------------------------------

# Whitelist (as a regex) for packages that may include binaries for other platforms
PACKAGE_WHITELIST=''

case "$TARGET_ARCH" in
    x64)
        EXPECTED_ARCH_STRING='x86[_-]64|80386'
        ;;
    arm64)
        EXPECTED_ARCH_STRING='arm64'
        ;;
    *)
        echo "Unknown arch $TARGET_ARCH"
        exit 1
        ;;
esac

case "$TARGET_PLATFORM" in
    linux)
        EXPECTED_PLATFORM_STRING='ELF'
        # Registry-js builds raw on non-Windows, but never used
        # Win-version info includes prebuilds for Windows on all platforms
        PACKAGE_WHITELIST='registry-js|win-version-info/prebuilds'
        ;;
    win32)
        EXPECTED_PLATFORM_STRING='MS Windows'
        PACKAGE_WHITELIST=''
        ;;
    darwin)
        EXPECTED_PLATFORM_STRING='Mach-O'
        # Registry-js builds raw on non-Windows, but never used
        # Win-version info includes prebuilds for Windows on all platforms
        PACKAGE_WHITELIST='registry-js|win-version-info/prebuilds'
        ;;
    *)
        echo "Unknown platform $TARGET_PLATFORM"
        exit 1
        ;;
esac

echo "CHECKING FOR BAD CONFIG"
echo "EXPECTING: $EXPECTED_PLATFORM_STRING and $EXPECTED_ARCH_STRING"
echo "WHITELIST: $PACKAGE_WHITELIST"

# Find all *.node files in the build that `file` doesn't describe with the above
NATIVE_BINARIES=$(
    find ./tmp/$TARGET/ \
    -name '*.node' \
    -type f \
    -exec file {} \;
)
echo "NATIVE BINS: $NATIVE_BINARIES"

BAD_BINS=$(echo "$NATIVE_BINARIES" | grep -vE "$EXPECTED_PLATFORM_STRING" | grep -vE "$EXPECTED_ARCH_STRING" || true)

if [[ ! -z "$PACKAGE_WHITELIST" ]]; then
    BAD_BINS=$(echo "$BAD_BINS" | grep -E -v "$PACKAGE_WHITELIST" || true)
fi

if [ `echo "$BAD_BINS" | wc -w` -ne 0 ]; then
    echo
    echo "***** BUILD FAILED *****"
    echo
    echo "Invalid build! $TARGET build has binaries for the wrong platform."
    echo "Bad binaries are:"
    echo "$BAD_BINS"
    echo
    echo "---"

    exit 1
fi

echo "BUILD SUCCESSFUL"