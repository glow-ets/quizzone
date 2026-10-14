@echo off
cd /d "%~dp0server"
python -m contromossa run %*
