#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

#
# This tool generates full update packages for the update system.
# Author: Darin Fisher
#

. $(dirname "$0")/common.sh

# -----------------------------------------------------------------------------

print_usage() {
  notice "Usage: $(basename $0) [OPTIONS] ARCHIVE DIRECTORY"
}

if [ $# = 0 ]; then
  print_usage
  exit 1
fi

if [ $1 = -h ]; then
  print_usage
  notice ""
  notice "The contents of DIRECTORY will be stored in ARCHIVE."
  notice ""
  notice "Options:"
  notice "  -h  show this help text"
  notice "  -q  be less verbose"
  notice ""
  exit 1
fi

if [ $1 = -q ]; then
  QUIET=1
  shift
fi

# -----------------------------------------------------------------------------

archive="$1"
targetdir="$2"
# Prevent the workdir from being inside the targetdir so it isn't included in
# the update mar.
if [ $(echo "$targetdir" | grep -c '\/$') = 1 ]; then
  # Remove the /
  targetdir=$(echo "$targetdir" | sed -e 's:\/$::')
fi
workdir="$targetdir.work"
updatemanifestv2="$workdir/updatev2.manifest"
updatemanifestv3="$workdir/updatev3.manifest"
targetfiles="updatev2.manifest updatev3.manifest"

mkdir -p "$workdir"

# Generate a list of all files in the target directory.
pushd "$targetdir"
if test $? -ne 0 ; then
  exit 1
fi

if [ ! -f "precomplete" ]; then
  if [ ! -f "Contents/Resources/precomplete" ]; then
    notice "precomplete file is missing!"
    exit 1
  fi
fi

list_files files
list_symlinks symlinks symlink_targets

# TODO When TOR_BROWSER_DATA_OUTSIDE_APP_DIR is used on all platforms,
# we should remove the following lines (which remove entire directories
# which, if present, contain old, unpacked copies of HTTPS Everywhere):
# Make sure we delete the pre 5.1.0 HTTPS Everywhere as well in case it
# exists. The extension ID got changed with the version bump to 5.1.0.
ext_path='TorBrowser/Data/Browser/profile.default/extensions'
if [ -d "$ext_dir" ]; then
  directories_to_remove="$ext_path/https-everywhere@eff.org $ext_path/https-everywhere-eff@eff.org"
else
  directories_to_remove=""
fi
# END TOR_BROWSER_DATA_OUTSIDE_APP_DIR removal

popd

# Add the type of update to the beginning of the update manifests.
> "$updatemanifestv2"
> "$updatemanifestv3"
notice ""
notice "Adding type instruction to update manifests"
notice "       type complete"
echo "type \"complete\"" >> "$updatemanifestv2"
echo "type \"complete\"" >> "$updatemanifestv3"

# TODO When TOR_BROWSER_DATA_OUTSIDE_APP_DIR is used on all platforms,
# we should remove the following lines:
# If removal of any old, existing directories is desired, emit the appropriate
# rmrfdir commands.
notice ""
notice "Adding directory removal instructions to update manifests"
for dir_to_remove in $directories_to_remove; do
  # rmrfdir requires a trailing slash; if slash is missing, add one.
  if ! [[ "$dir_to_remove" =~ /$ ]]; then
   dir_to_remove="${dir_to_remove}/"
  fi
  echo "rmrfdir \"$dir_to_remove\"" >> "$updatemanifestv2"
  echo "rmrfdir \"$dir_to_remove\"" >> "$updatemanifestv3"
done
# END TOR_BROWSER_DATA_OUTSIDE_APP_DIR removal

notice ""
notice "Adding file add instructions to update manifests"
num_files=${#files[*]}

for ((i=0; $i<$num_files; i=$i+1)); do
  f="${files[$i]}"

  if check_for_add_if_not_update "$f"; then
    make_add_if_not_instruction "$f" "$updatemanifestv3"
    if check_for_add_to_manifestv2 "$f"; then
      make_add_instruction "$f" "$updatemanifestv2" "" 1
    fi
  else
    make_add_instruction "$f" "$updatemanifestv2" "$updatemanifestv3"
  fi

  dir=$(dirname "$f")
  mkdir -p "$workdir/$dir"
  if [[ -n $MAR_OLD_FORMAT ]]; then
    $BZIP2 -cz9 "$targetdir/$f" > "$workdir/$f"
  else
    $XZ --compress $BCJ_OPTIONS --lzma2 --format=xz --check=crc64 --force --stdout "$targetdir/$f" > "$workdir/$f"
  fi
  copy_perm "$targetdir/$f" "$workdir/$f"

  targetfiles="$targetfiles \"$f\""
done

notice ""
notice "Adding symlink add instructions to update manifests"
num_symlinks=${#symlinks[*]}
for ((i=0; $i<$num_symlinks; i=$i+1)); do
  link="${symlinks[$i]}"
  target="${symlink_targets[$i]}"
  make_addsymlink_instruction "$link" "$target" "$updatemanifestv2" "$updatemanifestv3"
done

# Append remove instructions for any dead files.
notice ""
notice "Adding file and directory remove instructions from file 'removed-files'"
append_remove_instructions "$targetdir" "$updatemanifestv2" "$updatemanifestv3"

if [[ -n $MAR_OLD_FORMAT ]]; then
  $BZIP2 -z9 "$updatemanifestv2" && mv -f "$updatemanifestv2.bz2" "$updatemanifestv2"
  $BZIP2 -z9 "$updatemanifestv3" && mv -f "$updatemanifestv3.bz2" "$updatemanifestv3"
else
  $XZ --compress $BCJ_OPTIONS --lzma2 --format=xz --check=crc64 --force "$updatemanifestv2" && mv -f "$updatemanifestv2.xz" "$updatemanifestv2"
  $XZ --compress $BCJ_OPTIONS --lzma2 --format=xz --check=crc64 --force "$updatemanifestv3" && mv -f "$updatemanifestv3.xz" "$updatemanifestv3"
fi

mar_command="$MAR"
if [[ -n $MOZ_PRODUCT_VERSION ]]
then
  mar_command="$mar_command -V $MOZ_PRODUCT_VERSION"
fi
mar_command="$mar_command -C \"$workdir\" -c output.mar"
eval "$mar_command $targetfiles"
mv -f "$workdir/output.mar" "$archive"

# cleanup
rm -fr "$workdir"

notice ""
notice "Finished"
notice ""
