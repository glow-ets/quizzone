@echo off
cd /d "%~dp0server"
python -m quizzone run %*
