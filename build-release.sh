#!/usr/bin/env bash
set -e

# This script takes a target platform as an argument, and then
# builds the server for that platform - installing the correct
# native-built modules for the platform as appropriate.

# ------------------------------------------------------------------------
# Configure everything for the target platform
# ------------------------------------------------------------------------

TARGET_PLATFORM=$1

echo "CONFIGURING FOR $TARGET_PLATFORM"

if [ -z "$TARGET_PLATFORM" ]; then
    echo 'A target platform (linux/win32/darwin) is required'
    exit 1
fi

TARGET_ARCH=`node -e 'console.log(process.arch)'`

export PATH=./node_modules/.bin:$PATH

# Pick the target platform for prebuild-install:
export npm_config_platform=$TARGET_PLATFORM
# Pick the target platform for node-pre-gyp:
export npm_config_target_platform=$TARGET_PLATFORM

TARGET=$TARGET_PLATFORM-$TARGET_ARCH

# ------------------------------------------------------------------------
# Clean the existing build workspace, to keep targets 100% independent
# ------------------------------------------------------------------------

rm -r ./tmp || true

# ------------------------------------------------------------------------
# Build the package for this platform
# ------------------------------------------------------------------------

env | grep -E 'npm_|TARGET_'

echo
echo "BUILDING FOR $TARGET_PLATFORM"
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

case "$TARGET_PLATFORM" in
    linux)
        EXPECTED_BIN_STRING="ELF"
        # Builds raw on non-Windows, but never used
        PACKAGE_WHITELIST="registry-js"
        ;;
    win32)
        EXPECTED_BIN_STRING="MS Windows"
        PACKAGE_WHITELIST=""
        ;;
    darwin)
        EXPECTED_BIN_STRING="Mach-O"
        # Builds raw on non-Windows, but never used
        PACKAGE_WHITELIST="registry-js"
        ;;
    *)
        echo "Unknown platform $TARGET_PLATFORM"
        exit 1
        ;;
esac

echo "CHECKING FOR BAD CONFIG"
echo "EXPECTING: $EXPECTED_BIN_STRING"
echo "WHITELIST: $PACKAGE_WHITELIST"

# Find all *.node files in the build that `file` doesn't describe with the above
NATIVE_BINARIES=$(
    find ./tmp/$TARGET/ \
    -name '*.node' \
    -type f \
    -exec file {} \;
)
echo "NATIVE BINS: $NATIVE_BINARIES"

BAD_BINS=$(echo "$NATIVE_BINARIES" | grep -v "$EXPECTED_BIN_STRING" || true)

if [[ ! -z "$PACKAGE_WHITELIST" ]]; then
    BAD_BINS=$(echo "$BAD_BINS" | grep -E -v "$PACKAGE_WHITELIST" || true)
fi

if [ `echo "$BAD_BINS" | wc -w` -ne 0 ]; then
    echo
    echo "***** BUILD FAILED *****"
    echo
    echo "Invalid build! $TARGET_PLATFORM build has binaries for the wrong platform."
    echo "Bad binaries are:"
    echo "$BAD_BINS"
    echo
    echo "---"

    exit 1
fi

echo "BUILD SUCCESSFUL"