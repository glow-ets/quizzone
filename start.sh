#!/bin/sh
cd "$(dirname "$0")/server" && exec python3 -m contromossa run "$@"
