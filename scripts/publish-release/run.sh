#!/usr/bin/env bash
# Release-event admission, late metadata staging and exact-archive publication.
# No dependency resolution or lifecycle command belongs in the publish operation.
set -euo pipefail

core='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
stable="^${core}$"
rc="^${core}-rc\.(0|[1-9][0-9]*)$"
refuse() { echo "$1" >&2; exit 1; }
check_version() {
  [[ ${#1} -le 128 && ( $1 =~ $stable || $1 =~ $rc ) ]] || refuse ERR_RELEASE_VERSION
}

case "${1:-}" in
  admit)
    tag=${RELEASE_TAG:?}
    [[ $tag == v* ]] || refuse ERR_RELEASE_TAG
    version=${tag#v}
    check_version "$version"
    if [[ $version =~ $rc ]]; then
      [[ ${RELEASE_PRERELEASE:-} == true ]] || refuse ERR_RELEASE_PRERELEASE
    else
      [[ ${RELEASE_PRERELEASE:-} == false ]] || refuse ERR_RELEASE_PRERELEASE
      [[ $(jq -er '.version' package.json) == "$version" ]] || refuse ERR_RELEASE_SOURCE_VERSION
    fi
    source=$(git rev-parse --verify HEAD)
    [[ ${GITHUB_SHA:?} == "$source" ]] || refuse ERR_RELEASE_EVENT_SOURCE
    [[ $(git rev-parse --verify "refs/tags/$tag^{commit}") == "$source" ]] || refuse ERR_RELEASE_TAG_SOURCE
    status=$(gh api "repos/${GITHUB_REPOSITORY:?}/compare/$source...main" --jq .status)
    [[ $status == ahead || $status == identical ]] || refuse ERR_RELEASE_NOT_ON_MAIN
    printf 'version=%s\nsource=%s\n' "$version" "$source" >> "${GITHUB_OUTPUT:?}"
    ;;
  stage)
    version=${EXPECTED_VERSION:?}
    check_version "$version"
    if [[ $version =~ $rc ]]; then
      jq -e --arg version "$version" \
        'if .name == "footprintjs" then .version = $version else error("ERR_RELEASE_PACKAGE") end' \
        package.json > package.release.json
      mv package.release.json package.json
    fi
    [[ $(jq -er '.version' package.json) == "$version" ]] || refuse ERR_RELEASE_SOURCE_VERSION
    ;;
  publish)
    expected=${EXPECTED_VERSION:?}
    check_version "$expected"
    version=$(tar -xOf package.tgz package/package.json | jq -er 'select(.name == "footprintjs") | .version')
    [[ $version == "$expected" ]] || refuse ERR_RELEASE_ARCHIVE_VERSION
    check_version "$version"
    if [[ $version =~ $rc ]]; then channel=next; else channel=latest; fi
    npm publish ./package.tgz --provenance --access public --tag "$channel"
    ;;
  *) refuse ERR_RELEASE_OPERATION ;;
esac
