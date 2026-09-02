#!/bin/sh
# Fetches one external benchmark corpus into this directory.
#
# The exact commands documented in README.md's "Fetching them" section, made
# idempotent (skip a corpus already present) and dispatched by dataset id so
# CI can fetch only what the benchmark it is about to run needs. Nothing here
# is committed to the repo (see README.md) — this script exists so a clean
# checkout, including a CI runner's, can reproduce that directory without a
# human copying commands out of a doc.
#
# Usage: benchmarks/fetch.sh <dataset> [...ignored]
# <dataset> is whatever eval:external accepts (kong, roseau, swe-bump, bump,
# timemachine) — the same first argument, so a caller can pass the run's full
# argument list through unchanged.

set -eu
cd "$(dirname "$0")"

# Download $1 to $2 and verify its md5 is $3, retrying the whole cycle a few
# times. Zenodo rate-limits (HTTP 429) when sibling CI jobs fetch the same
# record at once, and without this a throttled response — an HTML error page
# saved under the archive's name — would fail the checksum and kill the run.
# --fail makes curl reject those responses; the loop re-fetches on a transient
# miss instead of giving up on the first one.
fetch_verified() {
  url=$1 dest=$2 want=$3 attempt=1
  while [ "$attempt" -le 5 ]; do
    rm -f "$dest"
    if curl -fsSL --retry 5 --retry-delay 10 --retry-all-errors -o "$dest" "$url" \
      && echo "$want  $dest" | md5sum -c - ; then
      return 0
    fi
    echo "fetch_verified: attempt $attempt for $dest failed, retrying in 15s" >&2
    sleep 15
    attempt=$((attempt + 1))
  done
  echo "fetch_verified: giving up on $dest after $((attempt - 1)) attempts" >&2
  return 1
}

case "${1:-}" in
  kong)
    if [ ! -d kong-zenodo-13857646 ]; then
      fetch_verified "https://zenodo.org/records/13857646/files/replication_package.zip?download=1" \
        replication_package.zip 786cda66ae080cc70e5fb4a04e472429
      mkdir -p kong-zenodo-13857646
      unzip -q replication_package.zip -d kong-zenodo-13857646
    fi
    ;;
  swe-bump)
    if [ ! -d swe-bump-bench ]; then
      git clone https://github.com/xeol-io/swe-bump-bench.git
    fi
    ;;
  timemachine)
    if [ ! -d timemachine-bench ]; then
      git clone --filter=blob:none --sparse https://github.com/tohoku-nlp/timemachine-bench.git
      git -C timemachine-bench sparse-checkout set benchmark/data
    fi
    ;;
  roseau)
    if [ ! -d roseau ]; then
      mkdir -p roseau
      fetch_verified "https://zenodo.org/records/15536418/files/archive.zip?download=1" \
        roseau/archive.zip 60a6f44feb4189e7751034bdfdfafef3
      (cd roseau && unzip -q archive.zip 'accuracy-dataset/*' 'results/*')
    fi
    ;;
  bump)
    if [ ! -d bump ]; then
      git clone --filter=blob:none --sparse https://github.com/chains-project/bump.git
      git -C bump sparse-checkout set data/benchmark
    fi
    ;;
  *)
    echo "Unknown dataset '${1:-}'. Expected one of: kong, roseau, swe-bump, bump, timemachine." >&2
    exit 1
    ;;
esac
