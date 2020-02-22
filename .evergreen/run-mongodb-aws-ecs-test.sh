#!/bin/bash
set -o xtrace   # Write all commands first to stderr
set -o errexit  # Exit the script with error if any of the commands fail

MONGODB_URI="$1"

echo "Running MONGODB-AWS ECS authentication tests"

export MONGODB_URI=$MONGODB_URI
export PROJECT_DIRECTORY="$(pwd)/src"
export NVM_DIR="${PROJECT_DIRECTORY}/node-artifacts/nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"


MONGODB_UNIFIED_TOPOLOGY=1 npx mocha src/test/functional/mongodb_aws.test.js
