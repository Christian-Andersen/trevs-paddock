alias c := check
alias r := run

[private]
default:
    @just --choose

check:
    prek run --all-files

run:
    xdg-open ./dist/index.html

ci: check
