#!/bin/bash
cd /volume1/web-test
/usr/local/bin/node server.js >> output.log 2>&1 &
