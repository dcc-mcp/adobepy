set shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]

default:
    just --list

test:
    npm run test:all

quick:
    npm run test:quick

bridges:
    npm run test:bridges

replay:
    npm run test:replay

api-sources:
    npm run api:sources:validate

architecture:
    npm run architecture:check

lint:
    npm run lint

build:
    cargo build --release -p adobepy-cli --bin adobepy
    cargo build --release -p adobepy-broker --bin adobepy-bootstrap-helper
    npm run uxp:build
    npm run cep:build

package:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/package-release.ps1

package-quick:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/package-release.ps1 -SkipTests
