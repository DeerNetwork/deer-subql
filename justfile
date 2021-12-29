set dotenv-load := true

run-node +args="":
    #!/bin/bash
    npx subql-node -f . -p 3001 --local {{args}}

run-query name="public":
    #!/bin/bash
    export NAME={{name}}
    npx subql-query --name {{name}} --playground --indexer=http://localhost:3001

reset: reset-db build

reset-db:
    #!/bin/bash
    docker-compose down
    sudo rm -rf .data
    docker-compose up -d postgres

build:
    #!/bin/bash
    yarn codegen
    rm -rf dist
    yarn build