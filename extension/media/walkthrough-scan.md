# Scan

Run **Drift: Scan Dependencies for Upgrades** (or type `/scan` in the Drift
panel) to check every direct dependency against its registry, and see which
available upgrades would actually affect code in this repository.

Anything Drift could not check is reported as such, rather than counted as up
to date.

**Drift: Check for Breaking Changes** is the other direction: it analyses a
dependency change that has already happened in your working tree or history.
