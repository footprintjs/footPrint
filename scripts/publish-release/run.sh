#!/usr/bin/env bash
# Release-event admission, late metadata staging and exact-archive publication.
# No dependency resolution or lifecycle command belongs in the publish operation.
set -euo pipefail

helper=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
trusted=${TRUSTED_SOURCE:-$PWD}
[[ $trusted == /* ]] || { echo '::error::ERR_RELEASE_SOURCE_PATH' >&2; exit 1; }
cd -- "$trusted"

core='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
stable="^${core}$"
rc="^${core}-rc\.(0|[1-9][0-9]*)$"
refuse() { printf '::error::%s\n' "$1" >&2; exit 1; }
check_version() {
  [[ ${#1} -le 128 && ( $1 =~ $stable || $1 =~ $rc ) ]] || refuse ERR_RELEASE_VERSION
}

admit() {
    tag=${RELEASE_TAG:?}
    [[ $tag == v* ]] || refuse ERR_RELEASE_TAG
    version=${tag#v}
    check_version "$version"
    source_version=$(node "$helper/check-archive.cjs" source "$trusted/package.json")
    check_version "$source_version"
    if [[ $version =~ $rc ]]; then
      [[ ${RELEASE_PRERELEASE:-} == true ]] || refuse ERR_RELEASE_PRERELEASE
      node "$helper/check-archive.cjs" candidate "$version" "$source_version"
    else
      [[ ${RELEASE_PRERELEASE:-} == false ]] || refuse ERR_RELEASE_PRERELEASE
      [[ $source_version == "$version" ]] || refuse ERR_RELEASE_SOURCE_VERSION
    fi
    source=$(git rev-parse --verify HEAD 2>/dev/null) || refuse ERR_RELEASE_EVENT_SOURCE
    [[ ${GITHUB_SHA:?} == "$source" ]] || refuse ERR_RELEASE_EVENT_SOURCE
    # Checkout manufactures a local event tag. It is not an independent remote observation.
    status=$(gh api "repos/${GITHUB_REPOSITORY:?}/compare/$source...main" --jq .status 2>/dev/null) || refuse ERR_RELEASE_MAIN_READ
    [[ $status == ahead || $status == identical ]] || refuse ERR_RELEASE_NOT_ON_MAIN
}

case "${1:-}" in
  admit)
    admit
    printf 'version=%s\nsource=%s\n' "$version" "$source" >> "${GITHUB_OUTPUT:?}"
    ;;
  stage)
    version=${EXPECTED_VERSION:?}
    check_version "$version"
    node "$helper/check-archive.cjs" source "$trusted/package.json" >/dev/null
    if [[ $version =~ $rc ]]; then
      jq -e --arg version "$version" '.version = $version' \
        package.json > package.release.json
      mv package.release.json package.json
    fi
    [[ $(jq -er '.version' package.json) == "$version" ]] || refuse ERR_RELEASE_SOURCE_VERSION
    ;;
  publish)
    # The event and pinned checkout admit the version again; build outputs are not authority.
    admit
    [[ -n ${ARTIFACT_DIRECTORY:-} ]] || refuse ERR_RELEASE_INTAKE
    [[ -n ${PUBLISH_DIRECTORY:-} ]] || refuse ERR_RELEASE_PUBLISH_DIRECTORY
    intake=$ARTIFACT_DIRECTORY
    publish_directory=$PUBLISH_DIRECTORY
    node "$helper/check-archive.cjs" inspect "$intake" "$trusted/package.json" "$version"
    node "$helper/check-archive.cjs" directory "$publish_directory" "$intake" "$trusted"
    cd -- "$publish_directory"
    args=(publish "$intake/package.tgz" --ignore-scripts --provenance --access public)
    if [[ $version =~ $rc ]]; then args+=(--tag next); fi
    npm "${args[@]}"
    ;;
  *) refuse ERR_RELEASE_OPERATION ;;
esac
