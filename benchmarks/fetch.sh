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

case "${1:-}" in
  kong)
    if [ ! -d kong-zenodo-13857646 ]; then
      curl -sSLO "https://zenodo.org/records/13857646/files/replication_package.zip?download=1"
      echo "786cda66ae080cc70e5fb4a04e472429  replication_package.zip" | md5sum -c -
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
      curl -sSLo roseau/archive.zip "https://zenodo.org/records/15536418/files/archive.zip?download=1"
      echo "60a6f44feb4189e7751034bdfdfafef3  roseau/archive.zip" | md5sum -c -
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
