set dotenv-load

alias b := build
alias c := check
alias r := run
alias t := test
alias ci := continuous_integration

[private]
default:
    @just --list

check:
    prek run --all-files

manual:
    prek run --stage manual --all-files

audit:
    prek run audit --all-files

test:
    prek run test --all-files

build:
    npm run build

run:
    npm start

continuous_integration: manual build
