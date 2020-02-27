#!/bin/bash
set -o xtrace
set -o errexit

# load node.js environment
export NVM_DIR="${PROJECT_DIRECTORY}/node-artifacts/nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# $PYTHON_BINARY -m virtualenv --never-download --no-wheel ocsptest
#     . ocsptest/bin/activate
#     trap "deactivate; rm -rf ocsptest" EXIT HUP
#     pip install pyopenssl requests service_identity
#     PYTHON=python

OCSP_TLS_SHOULD_SUCCEED=${OCSP_TLS_SHOULD_SUCCEED} CA_FILE=${CA_FILE} npx mocha test/functional/ocsp_support.test.js
