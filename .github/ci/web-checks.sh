#!/usr/bin/env bash
set -euo pipefail

mkdir -p test-results
pids=()
names=()

run_check() {
  local name=$1
  shift
  "$@" > "test-results/source-$name.log" 2>&1 &
  pids+=("$!")
  names+=("$name")
}

static_checks() {
  npm run graph:architecture
  npm run format:check
  npm run test:entry-config
  npm run test:browser-policy
  node ../../tools/validate-assets.check.mjs
  node ../../tools/setup.check.mjs
  bash ../../deploy/deploy.test.sh
  node --test ../../deploy/verify-release.test.mjs
}

unit_tests() {
  npm run test:unit -- --reporter=default --reporter=junit --outputFile=test-results/unit.xml
  node tests/restricted-catalogue.check.mjs
}

bundle() {
  npm run bundle:editor
  npm run build:visitor
}

run_check lint npm run lint
run_check types npm run typecheck
run_check unit unit_tests
run_check static static_checks
if [[ ${GITHUB_EVENT_NAME:-} == pull_request ]]; then
  run_check build bundle
fi

failed=0
for i in "${!pids[@]}"; do
  wait "${pids[i]}" || failed=1
  echo "::group::${names[i]}"
  cat "test-results/source-${names[i]}.log"
  echo "::endgroup::"
done
exit "$failed"
