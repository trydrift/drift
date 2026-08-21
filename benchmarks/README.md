# External benchmark corpora

Nothing in this directory is committed except this file and `fetch.sh`, which
runs the commands below non-interactively — it's what
`.github/workflows/refresh-benchmarks.yml` uses to reproduce a corpus on a
clean CI checkout, and a human can run it the same way (`benchmarks/fetch.sh
<dataset>`) instead of copying commands out of this doc.

These are other people's datasets. Vendoring them would add hundreds of
megabytes this repository has no right to redistribute, and it would not make a
run any more reproducible — what makes a run reproducible is that every
artifact records the exact DOI, commit or image digest the data was fetched at,
which lives in `eval/results/<run-id>/` rather than in a copy of the data.

What *is* committed is everything needed to fetch and evaluate them from a
clean checkout: the adapters in `eval/src/external/`, the label mappings, the
deterministic selection manifests, and the run artifacts intended for
publication.

## Fetching them

```sh
mkdir -p benchmarks && cd benchmarks

# 1. Kong — npm breaking changes (CC-BY-4.0, DOI 10.5281/zenodo.13857646)
curl -sSLO "https://zenodo.org/records/13857646/files/replication_package.zip?download=1"
# verify before trusting: md5 must be 786cda66ae080cc70e5fb4a04e472429
md5 replication_package.zip
mkdir -p kong-zenodo-13857646 && unzip -q replication_package.zip -d kong-zenodo-13857646

# 2. swe-bump-bench — TypeScript consumer breakages (MIT)
git clone https://github.com/xeol-io/swe-bump-bench.git

# 3. TimeMachine-bench — Python migration failures
git clone --filter=blob:none --sparse https://github.com/tohoku-nlp/timemachine-bench.git
git -C timemachine-bench sparse-checkout set benchmark/data

# 4. Roseau accuracy dataset (CC-BY-4.0, DOI 10.5281/zenodo.15536418)
mkdir -p roseau && cd roseau
curl -sSLo archive.zip "https://zenodo.org/records/15536418/files/archive.zip?download=1"
# md5 must be 60a6f44feb4189e7751034bdfdfafef3
unzip -q archive.zip 'accuracy-dataset/*' 'results/*' && cd ..

# 5. BUMP — Java consumer breakages. METADATA ONLY.
# The full archive is 1,142 Docker images and is not needed: the adapter reads
# the JSON records and fetches each project's real commit pair from GitHub.
git clone --filter=blob:none --sparse https://github.com/chains-project/bump.git
git -C bump sparse-checkout set data/benchmark
```

## Toolchain helpers

Two tools the adapters need are not usually installed and are not distributed
by their upstreams as binaries. Both go here rather than into a system prefix,
and both have their version recorded in every run's `environment.json`.

```sh
# Maven — needed only if you intend to build Roseau itself from its kit.
curl -sSLO "https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz"
tar xzf apache-maven-3.9.9-bin.tar.gz

# japicmp — Drift's Java API-surface diff shells out to this by name.
# Upstream ships a fat jar rather than a binary, so this is a shim.
mkdir -p tools/bin
curl -sSLo tools/japicmp.jar \
  "https://repo1.maven.org/maven2/com/github/siom79/japicmp/japicmp/0.26.1/japicmp-0.26.1-jar-with-dependencies.jar"
printf '#!/bin/sh\nexec java -jar "$(cd "$(dirname "$0")/.." && pwd)/japicmp.jar" "$@"\n' > tools/bin/japicmp
chmod +x tools/bin/japicmp
export PATH="$PWD/tools/bin:$PATH"
```

**Whether japicmp is present changes the Java result completely.** Without it
Drift cannot compute a Java API surface, correctly declines to conclude
anything, and reports `insufficient-evidence`; with it, the same cases produce
hundreds of API changes. Every run records which situation it was in.

## Running

```sh
npm run eval:external -- kong --experiment rq2-category
npm run eval:external -- roseau
npm run eval:external -- swe-bump
npm run eval:external -- timemachine --experiment verified
npm run eval:external -- bump --limit 40 --seed 20260819
```

Artifacts land in `eval/results/<run-id>/`. See
[`eval/README.md`](../eval/README.md) for what the harness measures and, more
importantly, what it refuses to measure.

## Licences and citation

Each dataset's licence and the citation its authors ask for are recorded in
`eval/src/external/dataset.ts` and reproduced verbatim in every report these
runs generate. Kong and the Roseau replication kit are CC-BY-4.0;
swe-bump-bench is MIT; BUMP and TimeMachine-bench carry their repositories'
own terms. If you publish anything derived from these runs, cite the datasets,
not this repository.
