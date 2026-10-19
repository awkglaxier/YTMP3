@echo off
rem ไฟล์: server.bat — ดับเบิลคลิกเพื่อเปิด server + หน้าเว็บทันที
cd /d "%~dp0"
start "" http://127.0.0.1:5577
node server.js
pause
