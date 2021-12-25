set dotenv-load := true

run-node +args="":
    npx subql-node -f . -p 3001 {{args}}

run-query:
    npx subql-query --name deer-subql --playground --indexer=http://localhost:3001

clean:
    docker-compose down
    rm -rf .data

build:
    yarn codegen
    rm -rf dist
    yarn build